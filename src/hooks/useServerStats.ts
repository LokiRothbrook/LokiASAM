"use client";

import { useState, useEffect, useRef } from "react";
import { tauriCmd, type ArkPlayer } from "@/lib/tauri-commands";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { useAppStore } from "@/store/useAppStore";
import type { ServerRow } from "@/lib/db";

export interface ServerStats {
  cpuPercent: number | null;
  memoryMb: number | null;
  playersOnline: number | null;
  maxPlayers: number | null;
  /** Server version string from Source Query, if available. */
  version: string | null;
}

// Stable empty-array reference so the Zustand selector never creates a new value.
const EMPTY: never[] = [];

/**
 * Returns live stats for a server card/tile.
 *
 * CPU and RAM come from the Zustand live buffer, which is fed by the Rust
 * background recorder task every 5 s via "stats://live" events.  This ensures
 * the tile values are always in sync with the live chart.
 *
 * Player count comes from rcon://players/{id} events (primary) and a 30 s
 * cache-read fallback.  MaxPlayers is read once from GameUserSettings.ini.
 */
export function useServerStats(server: ServerRow | null): ServerStats {
  // playersOnline/maxPlayers are genuinely async-sourced (RCON events, a 30 s
  // poll, and a one-time INI read) so they stay as state updated from effects.
  // cpuPercent/memoryMb are pure derivations of the live buffer + status —
  // computed directly below instead of mirrored into state via an effect.
  const [asyncStats, setAsyncStats] = useState<{
    playersOnline: number | null;
    maxPlayers: number | null;
  }>({ playersOnline: null, maxPlayers: null });

  const serverRef = useRef(server);
  useEffect(() => {
    serverRef.current = server;
  });

  // ── CPU / RAM — read latest live-buffer sample ────────────────────────────
  // The Rust recorder emits "stats://live" every 5 s; ServerStatsRecorderProvider
  // pushes each sample into the Zustand buffer.  We pull the last entry here so
  // the tile value and the live chart always show the same reading.
  const liveBuffer = useAppStore(
    (s) =>
      server ? (s.statsLiveBuffers[server.id] ?? EMPTY) : EMPTY,
  );
  const isRunning = server?.status === "running";
  const isActiveForStats =
    server?.status === "running" || server?.status === "starting";
  const latestSample = liveBuffer[liveBuffer.length - 1];
  const cpuPercent = latestSample && isActiveForStats ? latestSample.cpu : null;
  const memoryMb   = latestSample && isActiveForStats ? latestSample.mem : null;

  // ── MaxPlayers from INI ───────────────────────────────────────────────────
  useEffect(() => {
    if (!server?.install_path) return;
    tauriCmd.readServerConfig(server.install_path).then((config) => {
      const gus = config.gameUserSettings as Record<string, Record<string, string>>;
      const raw =
        gus["GameSession"]?.["MaxPlayers"] ??
        gus["ServerSettings"]?.["MaxPlayers"];
      if (raw) {
        const n = parseInt(raw, 10);
        if (!isNaN(n) && n > 0) {
          setAsyncStats((prev) => ({ ...prev, maxPlayers: n }));
        }
      }
    }).catch(() => null);
  }, [server?.id, server?.install_path]);

  // ── Player count — reactive via Tauri events ──────────────────────────────
  useTauriEvent<ArkPlayer[]>(
    server ? `rcon://players/${server.id}` : "",
    (players) => {
      setAsyncStats((prev) => ({
        playersOnline: players.length,
        maxPlayers: prev.maxPlayers ?? serverRef.current?.max_players ?? null,
      }));
    },
  );

  // ── Player count — 30 s cache fallback poll ───────────────────────────────
  const serverId = server?.id;
  const serverStatus = server?.status;
  useEffect(() => {
    if (!serverId || serverStatus !== "running") return;

    const poll = () => {
      tauriCmd.rconGetCachedPlayers(serverId).then((players) => {
        if (players === null) return;
        setAsyncStats((prev) => ({
          playersOnline: players.length,
          maxPlayers: prev.maxPlayers ?? serverRef.current?.max_players ?? null,
        }));
      }).catch(() => null);
    };

    poll();
    const id = setInterval(poll, 30_000);
    return () => clearInterval(id);
  }, [serverId, serverStatus]);

  return {
    cpuPercent,
    memoryMb,
    // Masked to null while not running instead of being reset via an effect —
    // the underlying async value is still cached in asyncStats for next time.
    playersOnline: isRunning ? asyncStats.playersOnline : null,
    maxPlayers: asyncStats.maxPlayers,
    version: null,
  };
}
