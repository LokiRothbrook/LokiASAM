"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getServers } from "@/lib/db";
import { useTauriEvent } from "./useTauriEvent";
import type { ServerStatus } from "@/lib/tauri-commands";
import { updateServerStatus } from "@/lib/db";
import { useAppStore } from "@/store/useAppStore";

// Chains each server_id's writes onto its own promise instead of firing them
// concurrently — `listen()` delivers events in emission order, but doesn't
// await the handler, so two IPC round-trips for the same server (e.g.
// "starting" immediately followed by "running", which happens on every
// single start) can otherwise complete out of order and leave SQLite holding
// the older status as final until the 30s fallback poll corrects it.
// Module-level (not per-hook-instance) since only one listener is ever
// mounted for this event, and the ordering guarantee needs to span every
// call regardless of which render registered the current closure.
const writeChains = new Map<string, Promise<unknown>>();

function chainedUpdateServerStatus(serverId: string, status: string, pid: number | null): Promise<void> {
  const prior = writeChains.get(serverId) ?? Promise.resolve();
  const next = prior
    .catch(() => {}) // a prior write's rejection must not block this one
    .then(() => updateServerStatus(serverId, status, pid));
  writeChains.set(serverId, next);
  return next.catch(() => {});
}

/**
 * Fetches all server rows from SQLite and keeps them fresh by:
 * 1. Listening to `server://any-change` events from the Rust backend and
 *    applying the status update directly to SQLite, then invalidating the query.
 * 2. Polling every 30 s as a fallback (covers in-browser dev mode where events
 *    are unavailable).
 */
export function useServers() {
  const queryClient = useQueryClient();
  const serverStartTimes = useAppStore((s) => s.serverStartTimes);
  const setServerStartTime = useAppStore((s) => s.setServerStartTime);
  const clearServerStartTime = useAppStore((s) => s.clearServerStartTime);
  const enqueueStartup = useAppStore((s) => s.enqueueStartup);

  useTauriEvent<ServerStatus>("server://any-change", async (payload) => {
    // Track when each server process first started so we can show uptime from
    // process-start rather than from the later "running" status change.
    if (payload.status === "starting" && payload.pid != null) {
      if (!serverStartTimes[payload.serverId]) {
        setServerStartTime(payload.serverId, Date.now());
      }
    } else if (payload.status === "stopped" || payload.status === "crashed") {
      clearServerStartTime(payload.serverId);
    } else if (payload.status === "startup_queued") {
      // Rust emits this when a scheduled auto-update interrupts a server that
      // was mid-boot or already queued to start — hand it back to the
      // staggered startup queue instead of restarting it directly.
      // enqueueStartup dedupes, so this is a no-op if already queued.
      enqueueStartup([payload.serverId]);
    }

    // Write the new status into SQLite immediately so the cache stays in sync
    // with what the Rust backend knows. Chained per server_id so a fast
    // "starting" → "running" pair can't have its DB writes land out of order.
    await chainedUpdateServerStatus(payload.serverId, payload.status, payload.pid ?? null);
    queryClient.invalidateQueries({ queryKey: ["servers"] });
  });

  // Primary updates arrive via server://any-change events above.
  // 30 s poll is a safety-net fallback for dev mode or missed events.
  return useQuery({
    queryKey: ["servers"],
    queryFn: getServers,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}
