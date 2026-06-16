import { useState, useEffect, useCallback } from "react";
import { getBuildVersionCache, type BuildVersionRow } from "@/lib/db";

// Refresh the cache when a server status event fires (server may have confirmed
// its version via A2S after starting) or on a slow background interval.
const REFRESH_MS = 30_000;

export function useBuildVersionCache(): Map<string, BuildVersionRow> {
  const [cache, setCache] = useState<Map<string, BuildVersionRow>>(new Map());

  const refresh = useCallback(() => {
    getBuildVersionCache().then(setCache).catch(() => null);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return cache;
}
