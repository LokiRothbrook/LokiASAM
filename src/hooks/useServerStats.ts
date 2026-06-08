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
  const [stats, setStats] = useState<ServerStats>({
    cpuPercent: null,
    memoryMb: null,
    playersOnline: null,
    maxPlayers: null,
    version: null,
  });

  const serverRef = useRef(server);
  serverRef.current = server;

  // ── CPU / RAM — read latest live-buffer sample ────────────────────────────
  // The Rust recorder emits "stats://live" every 5 s; ServerStatsRecorderProvider
  // pushes each sample into the Zustand buffer.  We pull the last entry here so
  // the tile value and the live chart always show the same reading.
  const liveBuffer = useAppStore(
    (s) =>
      server ? (s.statsLiveBuffers[server.id] ?? EMPTY) : EMPTY,
  );

  useEffect(() => {
    const latest = liveBuffer[liveBuffer.length - 1];
    const active =
      server?.status === "running" || server?.status === "starting";

    if (!latest || !active) {
      setStats((s) => ({ ...s, cpuPercent: null, memoryMb: null }));
      return;
    }

    setStats((s) => ({
      ...s,
      cpuPercent: latest.cpu,
      memoryMb:   latest.mem,
    }));
  }, [liveBuffer, server?.status]);

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
          setStats((prev) => ({ ...prev, maxPlayers: n }));
        }
      }
    }).catch(() => null);
  }, [server?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Player count — reactive via Tauri events ──────────────────────────────
  useTauriEvent<ArkPlayer[]>(
    server ? `rcon://players/${server.id}` : "",
    (players) => {
      setStats((prev) => ({
        ...prev,
        playersOnline: players.length,
        maxPlayers: prev.maxPlayers ?? serverRef.current?.max_players ?? null,
      }));
    },
  );

  // ── Player count — 30 s cache fallback poll ───────────────────────────────
  useEffect(() => {
    if (!server || server.status !== "running") {
      setStats((s) => ({ ...s, playersOnline: null }));
      return;
    }

    const poll = () => {
      tauriCmd.rconGetCachedPlayers(server.id).then((players) => {
        if (players === null) return;
        setStats((prev) => ({
          ...prev,
          playersOnline: players.length,
          maxPlayers: prev.maxPlayers ?? serverRef.current?.max_players ?? null,
        }));
      }).catch(() => null);
    };

    poll();
    const id = setInterval(poll, 30_000);
    return () => clearInterval(id);
  }, [server?.id, server?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  return stats;
}
