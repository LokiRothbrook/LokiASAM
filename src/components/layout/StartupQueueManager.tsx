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
 * When a server is manually started by the user it bypasses this queue entirely.
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServers } from "@/hooks/useServers";
import { useAppStore } from "@/store/useAppStore";
import { getServer, updateServerStatus } from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";
import { buildStartParams } from "@/lib/server-utils";
import { dispatchNotification } from "@/lib/notifications";
import { NOTIFICATION_EVENTS } from "@/data/game-data";
import { toast } from "sonner";

export function StartupQueueManager() {
  const queryClient   = useQueryClient();
  const { data: servers = [] } = useServers();
  const startupQueue          = useAppStore((s) => s.startupQueue);
  const dequeueNextStartup    = useAppStore((s) => s.dequeueNextStartup);
  const setNoRetryServer      = useAppStore((s) => s.setNoRetryServer);
  const startingRef           = useRef(false);

  useEffect(() => {
    // Guard: don't start another server while one is already starting,
    // or if the queue is empty.
    const anyStarting = servers.some((s) => s.status === "starting");
    if (anyStarting || startupQueue.length === 0 || startingRef.current) return;

    const nextId = startupQueue[0];

    // Quick cache check: if the server has been fully deleted, skip immediately.
    if (servers.length > 0 && !servers.find((s) => s.id === nextId)) {
      dequeueNextStartup();
      return;
    }

    startingRef.current = true;
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
        startingRef.current = false;
        queryClient.invalidateQueries({ queryKey: ["servers"] });
      }
    })();
  }, [servers, startupQueue, dequeueNextStartup, queryClient, setNoRetryServer]);

  return null;
}
