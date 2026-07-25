"use client";

/**
 * StartupQueueManager — processes the startup queue sequentially.
 *
 * Watches the server list and the Zustand startupQueue. When no server is
 * currently in the "starting" state and the queue is non-empty, it pops the
 * next server and starts it. This ensures servers are started one at a time
 * to avoid overloading the host machine.
 *
 * Queue entries have status = "startup_queued" in the DB so the badge shows.
 * Manual Start, Start All, and the Rust scheduler's post-update/restart
 * hand-off all route through this queue rather than starting directly.
 * "Skip Queue" on a queued server's card is the one deliberate bypass.
 *
 * The DB status column is treated as the source of truth: a separate effect
 * below reconciles any server sitting at "startup_queued" that isn't in the
 * in-memory Zustand array back into it, so a missed/raced enqueueStartup call
 * anywhere else can't leave a server stuck showing "queued" with nothing ever
 * picking it up.
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServers } from "@/hooks/useServers";
import { useAppStore } from "@/store/useAppStore";
import { getServer, getAppSetting, updateServerStatus } from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";
import { buildStartParams } from "@/lib/server-utils";
import { warnIfFirewallMissing } from "@/lib/firewall-utils";
import { ARK_MAPS } from "@/data/game-data";
import { dispatchNotification } from "@/lib/notifications";
import { NOTIFICATION_EVENTS } from "@/data/game-data";
import { toast } from "sonner";

export function StartupQueueManager() {
  const queryClient   = useQueryClient();
  const { data: servers = [] } = useServers();
  const startupQueue          = useAppStore((s) => s.startupQueue);
  const dequeueNextStartup    = useAppStore((s) => s.dequeueNextStartup);
  const enqueueStartup        = useAppStore((s) => s.enqueueStartup);
  const setNoRetryServer      = useAppStore((s) => s.setNoRetryServer);
  // Tracks the id currently being processed (not just a boolean) so the
  // reconciliation effect below can tell "already being handled" apart from
  // "genuinely missing" for this one server.
  const startingIdRef         = useRef<string | null>(null);

  // Self-heal: the DB status column is the source of truth for "wants to
  // start via the queue" — the in-memory Zustand array is only an ordering
  // hint on top of it, populated from several call sites (manual Start,
  // Start All, the Rust scheduler's post-update/restart hand-off, etc). If
  // any of those ever fails to call enqueueStartup (a missed event, a race),
  // a server can be left showing "startup_queued" with nothing ever picking
  // it up. Reconcile on every servers refresh so that can't get permanently
  // stuck — this is the same fix StartupRecoveryManager already does once at
  // launch, just kept running for the rest of the session too.
  //
  // Excludes whatever's currently being processed: the main effect below
  // dequeues a server synchronously before its DB status actually flips away
  // from "startup_queued" (that write happens moments later, after an async
  // round-trip) — without this exclusion, this effect sees the stale cached
  // status, decides the server it just popped is "missing", and re-queues a
  // duplicate for it.
  useEffect(() => {
    const missing = servers
      .filter((s) => s.status === "startup_queued" && !startupQueue.includes(s.id) && s.id !== startingIdRef.current)
      .map((s) => s.id);
    if (missing.length > 0) enqueueStartup(missing);
  }, [servers, startupQueue, enqueueStartup]);

  useEffect(() => {
    // Guard: don't start another server while one is already starting,
    // or if the queue is empty.
    const anyStarting = servers.some((s) => s.status === "starting");
    if (anyStarting || startupQueue.length === 0 || startingIdRef.current) return;

    const nextId = startupQueue[0];

    // Quick cache check: if the server has been fully deleted, skip immediately.
    if (servers.length > 0 && !servers.find((s) => s.id === nextId)) {
      dequeueNextStartup();
      return;
    }

    startingIdRef.current = nextId;
    dequeueNextStartup();

    (async () => {
      try {
        // Read authoritative status from DB — the TanStack cache may still be
        // stale when enqueueStartup fires immediately after a DB write, causing
        // the cache-based status check to see "stopped" and silently skip the server.
        const server = await getServer(nextId);

        if (!server || server.status !== "startup_queued") {
          // Server was cancelled or doesn't exist — skip without error.
          return;
        }

        await updateServerStatus(server.id, "starting", null);
        queryClient.invalidateQueries({ queryKey: ["servers"] });

        // Ensure both save symlinks/junctions are in place before launching —
        // same repair step the manual Start button runs, now also needed here
        // since manual starts route through this queue too.
        const baseDir = await getAppSetting("base_dir").catch(() => null);
        if (baseDir) {
          const mapPath = ARK_MAPS.find((m) => m.id === server.map_id)?.mapPath ?? "TheIsland_WP";
          await tauriCmd.createSaveLink(server.install_path, server.id, baseDir).catch((e) => {
            console.warn("createSaveLink failed on queued start:", e);
          });
          await tauriCmd.createModsSavesLink(server.install_path, server.id, baseDir, mapPath).catch((e) => {
            console.warn("createModsSavesLink failed on queued start:", e);
          });
        }

        await warnIfFirewallMissing(server);
        const params = await buildStartParams(server);
        const pid    = await tauriCmd.startServer(params);

        await updateServerStatus(server.id, "starting", pid);
        queryClient.invalidateQueries({ queryKey: ["servers"] });
      } catch (err) {
        const raw          = typeof err === "string" ? err : String(err);
        const isExeMissing = raw.startsWith("exe_missing:");
        const userMsg      = isExeMissing ? raw.slice("exe_missing: ".length) : raw;

        // Re-read name for the error notification since we may not have `server` in scope.
        const serverName = servers.find((s) => s.id === nextId)?.name ?? nextId;

        if (isExeMissing) setNoRetryServer(nextId);

        await updateServerStatus(nextId, "start-failed", null);
        queryClient.invalidateQueries({ queryKey: ["servers"] });

        toast.error(`${serverName} failed to start`, { description: userMsg });
        dispatchNotification({
          eventType:  NOTIFICATION_EVENTS.SERVER_START_FAILED,
          serverId:   nextId,
          serverName,
          title:      `${serverName} failed to start`,
          body:       userMsg,
          severity:   "error",
        });
      } finally {
        startingIdRef.current = null;
        queryClient.invalidateQueries({ queryKey: ["servers"] });
      }
    })();
  }, [servers, startupQueue, dequeueNextStartup, queryClient, setNoRetryServer]);

  return null;
}
