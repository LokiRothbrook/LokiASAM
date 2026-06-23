"use client";

import { useState, useEffect } from "react";
import { ARK_MAPS, type ArkMap } from "@/data/game-data";
import { getCustomMaps } from "@/lib/db";

/**
 * Returns all selectable maps: built-in ARK_MAPS merged with user-defined
 * custom maps from the custom_maps table. Custom maps are appended after
 * the built-in mod maps section so the ordering stays stable.
 */
export function useAllMaps(): ArkMap[] {
  const [allMaps, setAllMaps] = useState<ArkMap[]>(ARK_MAPS);

  useEffect(() => {
    getCustomMaps()
      .then((rows) => {
        const custom: ArkMap[] = rows.map((r) => ({
          id:           `custom_${r.id}`,
          displayName:  r.display_name,
          mapPath:      r.map_path,
          isOfficial:   false,
          dlcRequired:  false,
          released:     true,
          isMod:        true,
          requiredModId: r.mod_id,
        }));
        setAllMaps([...ARK_MAPS, ...custom]);
      })
      .catch(() => {
        // Custom maps unavailable — fall back to built-in list silently
      });
  }, []);

  return allMaps;
}
