"use client";

import { useState, useEffect, useRef } from "react";
import { tauriCmd, type ArkPlayer } from "@/lib/tauri-commands";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import type { ServerRow } from "@/lib/db";

export interface ServerStats {
  cpuPercent: number | null;
  memoryMb: number | null;
  playersOnline: number | null;
  maxPlayers: number | null;
  /** Server version string from Source Query, if available. */
  version: string | null;
}

/**
 * Polls process stats (CPU/RAM) every 10 s and Source Query (players) every
 * 30 s for the given server.  Polling is paused when the server is not running.
 */
export function useServerStats(server: ServerRow | null): ServerStats {
  const [stats, setStats] = useState<ServerStats>({
    cpuPercent: null,
    memoryMb: null,
    playersOnline: null,
    maxPlayers: null,
    version: null,
  });

  // Keep mutable refs so interval callbacks always see current values without
  // stale closure issues.
  const serverRef = useRef(server);
  serverRef.current = server;

  // ── Process stats (CPU / RAM) — every 10 s ────────────────────────────────
  // Poll during both "starting" and "running": on Linux the Wine game process
  // appears 15–30 s after Proton launches, well before RCON confirms "running".
  // The backend resolves the real game PID and re-emits "starting" with it, so
  // we start seeing accurate stats while the server is still loading the map.
  useEffect(() => {
    const active = server?.status === "running" || server?.status === "starting";
    if (!server || !active || !server.pid) {
      setStats((s) => ({ ...s, cpuPercent: null, memoryMb: null }));
      return;
    }

    let cancelled = false;

    const poll = async () => {
      const s = serverRef.current;
      const isActive = s?.status === "running" || s?.status === "starting";
      if (!s || !isActive || !s.pid) return;
      try {
        const ps = await tauriCmd.getProcessStats(s.pid, s.install_path);
        if (!cancelled) {
          setStats((prev) => ({
            ...prev,
            cpuPercent: ps.cpuPercent,
            memoryMb: ps.memoryMb,
          }));
        }
      } catch {
        // Process may not have appeared yet — next poll will retry.
      }
    };

    poll();
    const id = setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [server?.pid, server?.status]);

  // ── Player count ──────────────────────────────────────────────────────────
  // Primary: subscribe to rcon://players/{id} events emitted by RconManager's
  // 30 s tick (and by any explicit rconGetPlayers call). This updates in real
  // time whenever the event fires.
  useTauriEvent<ArkPlayer[]>(
    server ? `rcon://players/${server.id}` : "",
    (players) => {
      setStats((prev) => ({
        ...prev,
        playersOnline: players.length,
        maxPlayers: serverRef.current?.max_players ?? prev.maxPlayers,
      }));
    },
  );

  // Secondary: poll the RCON cache every 30 s. This is purely a cache read
  // (no RCON command sent) so it's free, and it guarantees the count stays
  // current even if an event was missed. Also resets to null when not running.
  useEffect(() => {
    if (!server || server.status !== "running") {
      setStats((s) => ({ ...s, playersOnline: null, maxPlayers: null }));
      return;
    }

    const poll = () => {
      tauriCmd.rconGetCachedPlayers(server.id).then((players) => {
        setStats((prev) => ({
          ...prev,
          playersOnline: players.length,
          maxPlayers: serverRef.current?.max_players ?? prev.maxPlayers,
        }));
      }).catch(() => null);
    };

    poll();
    const id = setInterval(poll, 30_000);
    return () => clearInterval(id);
  }, [server?.id, server?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  return stats;
}
