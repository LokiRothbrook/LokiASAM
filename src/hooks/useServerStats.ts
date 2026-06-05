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
 * Polls process stats (CPU/RAM) every 10 s for the given server.
 * Player count comes from rcon://players/{id} events emitted by the Rust
 * manager task and is kept current by a 30 s cache fallback poll.
 * MaxPlayers is read once from GameUserSettings.ini (falls back to the DB value).
 */
export function useServerStats(server: ServerRow | null): ServerStats {
  const [stats, setStats] = useState<ServerStats>({
    cpuPercent: null,
    memoryMb: null,
    playersOnline: null,
    maxPlayers: null,
    version: null,
  });

  // Keep a mutable ref so interval callbacks always see current values.
  const serverRef = useRef(server);
  serverRef.current = server;

  // ── MaxPlayers from INI ───────────────────────────────────────────────────
  // Read once per server (not per render). Falls back to the DB column on any
  // read error.  We do NOT write this back to the DB — INI is the source of
  // truth for the display; the DB value is what the user configured in LokiASAM.
  useEffect(() => {
    if (!server?.install_path) return;
    tauriCmd.readServerConfig(server.install_path).then((config) => {
      // MaxPlayers is in [GameSession] (primary) or [ServerSettings] (fallback).
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
    }).catch(() => null); // silently fall back to DB value
  }, [server?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Process stats (CPU / RAM) — every 10 s ────────────────────────────────
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

  // ── Player count — reactive via Tauri events ──────────────────────────────
  // Primary source: rcon://players/{id} emitted by the Rust manager task on
  // every listplayers result (30 s internal poll + any explicit refresh).
  useTauriEvent<ArkPlayer[]>(
    server ? `rcon://players/${server.id}` : "",
    (players) => {
      setStats((prev) => ({
        ...prev,
        playersOnline: players.length,
        // Prefer the INI-read maxPlayers already in state; fall back to DB value.
        maxPlayers: prev.maxPlayers ?? serverRef.current?.max_players ?? null,
      }));
    },
  );

  // ── Player count — 30 s cache fallback poll ───────────────────────────────
  // Reads the Rust-side cache without sending any RCON command.  This is
  // purely defensive — events from the manager task are the primary update
  // mechanism.  A null result means "not connected yet" and is ignored so we
  // don't flash 0 on mount before the first connection is established.
  useEffect(() => {
    if (!server || server.status !== "running") {
      setStats((s) => ({ ...s, playersOnline: null }));
      return;
    }

    const poll = () => {
      tauriCmd.rconGetCachedPlayers(server.id).then((players) => {
        if (players === null) return; // no RCON connection yet — don't touch state
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
