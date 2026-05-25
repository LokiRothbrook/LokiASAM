"use client";

import { useState, useEffect, useRef } from "react";
import { tauriCmd } from "@/lib/tauri-commands";
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
  useEffect(() => {
    if (!server || server.status !== "running" || !server.pid) {
      setStats((s) => ({ ...s, cpuPercent: null, memoryMb: null }));
      return;
    }

    let cancelled = false;

    const poll = async () => {
      const s = serverRef.current;
      if (!s || s.status !== "running" || !s.pid) return;
      try {
        const ps = await tauriCmd.getProcessStats(s.pid);
        if (!cancelled) {
          setStats((prev) => ({
            ...prev,
            cpuPercent: ps.cpuPercent,
            memoryMb: ps.memoryMb,
          }));
        }
      } catch {
        // Process may have just stopped — next poll will be a no-op.
      }
    };

    poll();
    const id = setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [server?.pid, server?.status]);

  // ── Source Query (players / version) — every 30 s ─────────────────────────
  useEffect(() => {
    if (!server || server.status !== "running") {
      setStats((s) => ({ ...s, playersOnline: null, maxPlayers: null }));
      return;
    }

    let cancelled = false;

    const poll = async () => {
      const s = serverRef.current;
      if (!s || s.status !== "running") return;
      try {
        const qs = await tauriCmd.queryServer("127.0.0.1", s.query_port);
        if (!cancelled) {
          setStats((prev) => ({
            ...prev,
            playersOnline: qs.players,
            maxPlayers: qs.maxPlayers,
            version: qs.version || prev.version,
          }));
        }
      } catch {
        // Server may not have fully started yet or Source Query is unavailable.
      }
    };

    poll();
    const id = setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [server?.id, server?.status]);

  return stats;
}
