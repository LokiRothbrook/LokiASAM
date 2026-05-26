"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getServers } from "@/lib/db";
import { useTauriEvent } from "./useTauriEvent";
import type { ServerStatus } from "@/lib/tauri-commands";
import { updateServerStatus } from "@/lib/db";

/**
 * Fetches all server rows from SQLite and keeps them fresh by:
 * 1. Listening to `server://any-change` events from the Rust backend and
 *    applying the status update directly to SQLite, then invalidating the query.
 * 2. Polling every 5 s as a fallback (covers in-browser dev mode where events
 *    are unavailable).
 */
export function useServers() {
  const queryClient = useQueryClient();

  useTauriEvent<ServerStatus>("server://any-change", async (payload) => {
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
