"use client";

import { useEffect, useRef } from "react";
import { useServers } from "@/hooks/useServers";
import { tauriCmd } from "@/lib/tauri-commands";
import { insertStatSample, openUptimeSession, closeUptimeSession } from "@/lib/db";
import { useAppStore } from "@/store/useAppStore";
import { runStatsRollup } from "@/lib/stats-rollup";

const LIVE_POLL_MS = 5_000;
// Write to DB on every 12th poll (every 60 s at 5 s resolution).
const DB_WRITE_EVERY = 12;

/**
 * Mounts inside SetupGuard. For each running server it:
 *  - Polls CPU/RAM + player count every 10 s and feeds the live buffer.
 *  - Writes a sample to server_stats_history every 60 s.
 *  - Opens/closes server_uptime_sessions as servers start and stop.
 *  - Runs the 30-day→daily stats rollup on mount and every 24 h.
 *
 * Renders nothing.
 */
export function ServerStatsRecorderProvider() {
  const { data: servers = [] } = useServers();
  const addLiveSample = useAppStore((s) => s.addLiveSample);

  // sessionId per server — set when opened, cleared when closed.
  const openSessions = useRef<Map<string, string>>(new Map());
  // Poll counter per server — used to throttle DB writes to every 60 s.
  const pollCounters = useRef<Map<string, number>>(new Map());
  // Server IDs that were active on the last poll — used to detect start/stop.
  const prevActive = useRef<Set<string>>(new Set());

  // Rollup on mount + every 24 h.
  useEffect(() => {
    runStatsRollup().catch(() => null);
    const id = setInterval(() => runStatsRollup().catch(() => null), 24 * 60 * 60_000);
    return () => clearInterval(id);
  }, []);

  // Keep a stable ref so the poll callback always sees current servers.
  const serversRef = useRef(servers);
  serversRef.current = servers;

  const addLiveSampleRef = useRef(addLiveSample);
  addLiveSampleRef.current = addLiveSample;

  useEffect(() => {
    const poll = async () => {
      const current = serversRef.current;
      const activeNow = new Set(
        current
          .filter((s) => s.status === "running" || s.status === "starting")
          .map((s) => s.id),
      );

      // Detect starts and stops for session management.
      for (const s of current) {
        const wasActive = prevActive.current.has(s.id);
        const isActive = activeNow.has(s.id);

        if (!wasActive && isActive && !openSessions.current.has(s.id)) {
          const sessionId = crypto.randomUUID();
          openSessions.current.set(s.id, sessionId);
          openUptimeSession(s.id, sessionId, Date.now()).catch(() => null);
        } else if (wasActive && !isActive) {
          const sessionId = openSessions.current.get(s.id);
          if (sessionId) {
            closeUptimeSession(sessionId, Date.now()).catch(() => null);
            openSessions.current.delete(s.id);
          }
          pollCounters.current.delete(s.id);
        }
      }
      prevActive.current = activeNow;

      // Sample each active server.
      for (const s of current) {
        if (!activeNow.has(s.id) || !s.pid) continue;

        const [ps, cachedPlayers] = await Promise.all([
          tauriCmd.getProcessStats(s.pid, s.install_path).catch(() => null),
          tauriCmd.rconGetCachedPlayers(s.id).catch(() => null),
        ]);

        const cpuPct     = ps?.cpuPercent    ?? null;
        const memMb      = ps?.memoryMb      ?? null;
        const playerCount = cachedPlayers !== null ? cachedPlayers.length : null;

        addLiveSampleRef.current(s.id, {
          ts: Date.now(),
          cpu: cpuPct,
          cpuMax: cpuPct,
          mem: memMb,
          memMax: memMb,
          players: playerCount,
          playersMax: playerCount,
        });

        const count = (pollCounters.current.get(s.id) ?? 0) + 1;
        pollCounters.current.set(s.id, count);
        if (count % DB_WRITE_EVERY === 0) {
          insertStatSample(s.id, cpuPct, memMb, playerCount).catch(() => null);
        }
      }
    };

    poll();
    const id = setInterval(poll, LIVE_POLL_MS);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // runs once; uses refs for current servers/addLiveSample

  return null;
}
