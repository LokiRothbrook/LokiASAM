"use client";

import { useState, useEffect, useMemo } from "react";
import { queryStatHistory, queryStatDaily } from "@/lib/db";
import { useAppStore } from "@/store/useAppStore";
import type { ChartPoint } from "@/lib/db";

export type Timeframe = "Live" | "1H" | "6H" | "24H" | "7D" | "30D" | "3M" | "6M" | "1Y";

// Stable empty array so the Zustand selector never returns a new reference when
// there is no live data yet — avoids the "getSnapshot should be cached" loop.
const EMPTY_BUFFER: ChartPoint[] = [];

const MS = {
  min:    60_000,
  hour:   3_600_000,
  day:    86_400_000,
} as const;

// Live mode window and resolution must match the Rust recorder (5 s poll, 10 min window).
const LIVE_SLOT_MS   = 5_000;
const LIVE_SLOTS     = 120; // 10 min × 5 s = 120 points
const LIVE_WINDOW_MS = LIVE_SLOTS * LIVE_SLOT_MS;

// For each DB-backed timeframe: how far back to fetch, and the SQL bucket size.
const DB_CONFIG: Record<
  Exclude<Timeframe, "Live">,
  { fromMs: number; bucketMs: number; useDaily: boolean }
> = {
  "1H":  { fromMs: MS.hour,           bucketMs: MS.min,          useDaily: false },
  "6H":  { fromMs: 6  * MS.hour,      bucketMs: 5  * MS.min,     useDaily: false },
  "24H": { fromMs: 24 * MS.hour,      bucketMs: 30 * MS.min,     useDaily: false },
  "7D":  { fromMs: 7  * MS.day,       bucketMs: 2  * MS.hour,    useDaily: false },
  "30D": { fromMs: 30 * MS.day,       bucketMs: 6  * MS.hour,    useDaily: false },
  "3M":  { fromMs: 90 * MS.day,       bucketMs: MS.day,          useDaily: true  },
  "6M":  { fromMs: 180 * MS.day,      bucketMs: MS.day,          useDaily: true  },
  "1Y":  { fromMs: 365 * MS.day,      bucketMs: MS.day,          useDaily: true  },
};

interface Result {
  data: ChartPoint[];
  loading: boolean;
}

/**
 * Returns chart data for a server + timeframe.
 *
 * "Live" mode: returns a fixed 120-slot, 10-minute time grid anchored to now.
 * Each slot is matched to the nearest real sample from the Zustand live buffer.
 * Unmatched slots carry null values so Recharts renders them as gaps
 * (connectNulls={false}) rather than zeros, which correctly shows server downtime.
 *
 * All other timeframes query SQLite on mount and when the timeframe changes.
 */
export function useServerStatsHistory(
  serverId: string | null,
  timeframe: Timeframe,
): Result {
  const liveBuffer = useAppStore(
    (s) => (serverId ? (s.statsLiveBuffers[serverId] ?? EMPTY_BUFFER) : EMPTY_BUFFER),
  );

  // ── Live mode: time-anchored gap chart ────────────────────────────────────
  // Recompute whenever the buffer changes (new 5 s sample arrives).
  // `now` is captured at compute time so the window always ends at the current tick.
  const gappedLive = useMemo<ChartPoint[]>(() => {
    if (timeframe !== "Live") return EMPTY_BUFFER;

    const now = Date.now();

    // Build a lookup from rounded-slot-ts → ChartPoint for fast matching.
    const lookup = new Map<number, ChartPoint>();
    for (const p of liveBuffer) {
      const slotTs = Math.round(p.ts / LIVE_SLOT_MS) * LIVE_SLOT_MS;
      lookup.set(slotTs, p);
    }

    return Array.from({ length: LIVE_SLOTS }, (_, i) => {
      const slotTs =
        Math.round((now - LIVE_WINDOW_MS + i * LIVE_SLOT_MS) / LIVE_SLOT_MS) *
        LIVE_SLOT_MS;

      return (
        lookup.get(slotTs) ?? {
          ts:         slotTs,
          cpu:        null,
          cpuMax:     null,
          mem:        null,
          memMax:     null,
          players:    null,
          playersMax: null,
        }
      );
    });
  }, [liveBuffer, timeframe]);

  // ── DB-backed timeframes ──────────────────────────────────────────────────
  const [dbData, setDbData]   = useState<ChartPoint[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (timeframe === "Live" || !serverId) {
      setDbData([]);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const { fromMs, bucketMs, useDaily } = DB_CONFIG[timeframe];
    const from = Date.now() - fromMs;

    (useDaily
      ? queryStatDaily(serverId, from)
      : queryStatHistory(serverId, from, bucketMs)
    )
      .then((rows) => {
        if (!cancelled) setDbData(rows);
      })
      .catch(() => {
        if (!cancelled) setDbData([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [serverId, timeframe]);

  if (timeframe === "Live") {
    return { data: gappedLive, loading: false };
  }
  return { data: dbData, loading };
}
