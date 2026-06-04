"use client";

/**
 * RconManager — maintains RCON connections and a live player-count cache.
 *
 * Every 30 s it:
 *   1. Queries the DB for servers currently in "running" state
 *   2. Connects RCON for any that don't have a live connection yet
 *   3. Calls rconGetPlayers for each — this fills the cache AND emits
 *      rcon://players/{id} events so stats tiles update without the RCON
 *      tab ever being opened
 *
 * No tracking ref is used so every tick naturally retries failed connections
 * without any special retry logic.
 */

import { useEffect } from "react";
import { getServers } from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import type { ServerStatus } from "@/lib/tauri-commands";

const POLL_MS = 30_000;

export function RconManager() {
  useEffect(() => {
    const tick = async () => {
      const servers = await getServers().catch(() => []);
      for (const s of servers) {
        if (s.status !== "running") continue;
        try {
          const already = await tauriCmd.rconIsConnected(s.id);
          if (!already) {
            await tauriCmd.rconConnect(s.id, "127.0.0.1", s.rcon_port, s.rcon_password);
            // Seed the player cache once on fresh connection. After this, the
            // Rust 30 s background task owns the periodic listplayers polling.
            // Calling it every JS tick would double-call the command and fight
            // the background task for the connection mutex.
            await tauriCmd.rconGetPlayers(s.id);
          }
          // Already connected: Rust background task handles the 30 s poll.
        } catch {
          // RCON not ready yet — next tick retries automatically.
        }
      }
    };

    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, []);

  // Clean up the pool connection when a server stops so stale handles don't linger.
  useTauriEvent<ServerStatus>("server://any-change", (payload) => {
    if (["stopped", "crashed", "start-failed"].includes(payload.status)) {
      tauriCmd.rconDisconnect(payload.serverId).catch(() => null);
    }
  });

  return null;
}
