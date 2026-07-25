"use client";

import { useTauriEvent } from "@/hooks/useTauriEvent";
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

  useTauriEvent<LiveStatEvent>("stats://live", (payload) => {
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
  });

  return null;
}
