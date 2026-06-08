"use client";

import { useState, useEffect } from "react";
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
 * "Live" mode reads directly from the in-memory Zustand buffer — no DB query,
 * updates in real time as ServerStatsRecorderProvider pushes new samples.
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

  const [dbData, setDbData]     = useState<ChartPoint[]>([]);
  const [loading, setLoading]   = useState(false);

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
    return { data: liveBuffer, loading: false };
  }
  return { data: dbData, loading };
}
