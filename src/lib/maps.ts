/**
 * maps.ts — process-wide cache merging built-in ARK_MAPS with user-added
 * custom mod maps from the `custom_maps` table.
 *
 * `ARK_MAPS` (game-data.ts) only knows about built-in maps; custom maps live
 * in SQLite and must be fetched async. Every place that resolves a server's
 * `map_id` — launch args, backup folder lookups, display labels, the
 * settings-page map dropdown — needs the merged list, not just `ARK_MAPS`,
 * or a custom map's id (`custom_<uuid>`) silently fails to match and callers
 * fall back to defaults (e.g. "TheIsland_WP"). This module is the one place
 * that fetches and caches `custom_maps`, so both React components
 * (`useAllMaps()`) and plain async functions (`ensureMapsCacheLoaded()` +
 * `findMapById()`) resolve against the same up-to-date list.
 */

import { ARK_MAPS, type ArkMap } from "@/data/game-data";
import { getCustomMaps, type CustomMapRow } from "@/lib/db";

function toArkMap(r: CustomMapRow): ArkMap {
  return {
    id: `custom_${r.id}`,
    displayName: r.display_name,
    mapPath: r.map_path,
    isOfficial: false,
    dlcRequired: false,
    released: true,
    isMod: true,
    requiredModId: r.mod_id,
  };
}

let customMaps: ArkMap[] = [];
// Cached merged snapshot — must be a STABLE reference across calls whenever
// nothing has changed. useSyncExternalStore (in useAllMaps()) compares
// getSnapshot()'s return by reference on every render; rebuilding a fresh
// array in getAllMapsSync() itself made every render "see" a changed
// snapshot and React threw "getSnapshot should be cached" (infinite loop).
let mergedSnapshot: ArkMap[] = ARK_MAPS;
let loaded = false;
let inFlight: Promise<ArkMap[]> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((l) => l());
}

function setCustomMaps(maps: ArkMap[]): void {
  customMaps = maps;
  mergedSnapshot = [...ARK_MAPS, ...customMaps];
  loaded = true;
  notify();
}

async function fetchAndCache(): Promise<ArkMap[]> {
  const rows = await getCustomMaps();
  setCustomMaps(rows.map(toArkMap));
  return customMaps;
}

/**
 * Update the cache directly from rows the caller already fetched (the Mod
 * Maps page does its own `getCustomMaps()` call to populate its table; this
 * lets it push that same result into the shared cache instead of a second
 * redundant fetch). Notifies subscribers.
 */
export function setCustomMapsCache(rows: CustomMapRow[]): void {
  setCustomMaps(rows.map(toArkMap));
}

/** Force a re-fetch from the DB and update the cache. Notifies subscribers. */
export function refreshMapsCache(): Promise<ArkMap[]> {
  inFlight = fetchAndCache().finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * Ensure the cache has been loaded at least once (no-op if already loaded
 * or a load is in flight). Call this before a synchronous lookup
 * (`findMapById`/`getAllMapsSync`) in a non-React context to guarantee
 * custom maps are included even on a cold start.
 */
export function ensureMapsCacheLoaded(): Promise<ArkMap[]> {
  if (loaded) return Promise.resolve(customMaps);
  if (!inFlight) inFlight = fetchAndCache().finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * Built-in maps + cached custom maps. May not include custom maps yet if
 * nothing has awaited `ensureMapsCacheLoaded()`/`refreshMapsCache()` first.
 * Returns the same array reference until the cache actually changes — required
 * for `useSyncExternalStore` (see `useAllMaps()`) to not loop.
 */
export function getAllMapsSync(): ArkMap[] {
  return mergedSnapshot;
}

export function findMapById(id: string | null | undefined): ArkMap | undefined {
  if (!id) return undefined;
  return getAllMapsSync().find((m) => m.id === id);
}

export function subscribeMapsCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
