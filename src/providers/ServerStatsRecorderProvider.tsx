"use client";

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store/useAppStore";
import type { ChartPoint } from "@/lib/db";

interface LiveStatEvent {
  serverId: string;
  ts: number;
  cpu: number | null;
  mem: number | null;
  players: number | null;
}

/**
 * Mounts inside SetupGuard.  Listens for "stats://live" events emitted by the
 * Rust background stats recorder task and pushes each sample into the Zustand
 * live buffer.  All actual polling, DB writing, rollup, and uptime session
 * management now happens entirely in Rust.
 *
 * Renders nothing.
 */
export function ServerStatsRecorderProvider() {
  const addLiveSample = useAppStore((s) => s.addLiveSample);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<LiveStatEvent>("stats://live", ({ payload }) => {
      const point: ChartPoint = {
        ts:         payload.ts,
        cpu:        payload.cpu,
        cpuMax:     payload.cpu,
        mem:        payload.mem,
        memMax:     payload.mem,
        players:    payload.players,
        playersMax: payload.players,
      };
      addLiveSample(payload.serverId, point);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  // addLiveSample is stable (Zustand action reference never changes)
  }, [addLiveSample]);

  return null;
}
