"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getServers } from "@/lib/db";
import { useTauriEvent } from "./useTauriEvent";
import type { ServerStatus } from "@/lib/tauri-commands";
import { updateServerStatus } from "@/lib/db";
import { useAppStore } from "@/store/useAppStore";

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

  useTauriEvent<ServerStatus>("server://any-change", async (payload) => {
    // Track when each server process first started so we can show uptime from
    // process-start rather than from the later "running" status change.
    if (payload.status === "starting" && payload.pid != null) {
      if (!serverStartTimes[payload.serverId]) {
        setServerStartTime(payload.serverId, Date.now());
      }
    } else if (payload.status === "stopped" || payload.status === "crashed") {
      clearServerStartTime(payload.serverId);
    }

    // Write the new status into SQLite immediately so the cache stays in sync
    // with what the Rust backend knows.
    try {
      await updateServerStatus(payload.serverId, payload.status, payload.pid ?? null);
    } catch {
      // Non-fatal: the query refetch below will still re-read correct data.
    }
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
