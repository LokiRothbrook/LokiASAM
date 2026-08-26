"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { ArkMap } from "@/data/game-data";
import { ensureMapsCacheLoaded, getAllMapsSync, subscribeMapsCache } from "@/lib/maps";

/**
 * Returns all selectable maps: built-in ARK_MAPS merged with user-defined
 * custom maps from the custom_maps table (via the shared cache in
 * `@/lib/maps`, kept fresh by the Mod Maps page on every add/edit/delete).
 */
export function useAllMaps(): ArkMap[] {
  useEffect(() => {
    ensureMapsCacheLoaded().catch(() => {
      // Custom maps unavailable — fall back to built-in list silently
    });
  }, []);

  return useSyncExternalStore(subscribeMapsCache, getAllMapsSync, getAllMapsSync);
}
