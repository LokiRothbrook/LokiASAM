/**
 * config-migrations.ts — one-time fixes for INI keys older versions wrote to
 * the wrong place. Pure functions, applied both to the DB copy of each config
 * and (as in-place patch ops) to the INI files on disk.
 */

import type { IniPatchOp } from "@/lib/tauri-commands";
import { type IniSections, GAME_MODE_SECTION, getIni, setIni, deleteIni, isIniTrue } from "@/lib/ini-utils";

/** Settings ASA only reads from Game.ini that older versions wrote to GameUserSettings.ini. */
const MOVE_TO_GAME_INI: { from: string; to: string }[] = [
  "BabyCuddleIntervalMultiplier", "BabyImprintAmountMultiplier", "BabyImprintingStatScaleMultiplier",
  "BabyMatureSpeedMultiplier", "EggHatchSpeedMultiplier", "MatingIntervalMultiplier",
  "FishingLootQualityMultiplier", "FuelConsumptionIntervalMultiplier",
  "GlobalCorpseDecompositionTimeMultiplier", "GlobalItemDecompositionTimeMultiplier",
  "GlobalSpoilingTimeMultiplier", "MaxNumberOfPlayersInTribe", "SupplyCrateLootQualityMultiplier",
  "UseCorpseLifeSpanMultiplier", "bDisableStructurePlacementCollision",
].map((k) => ({ from: k, to: k }))
  // The wizard used to write this one without its "b" prefix.
  .concat([{ from: "DisableStructurePlacementCollision", to: "bDisableStructurePlacementCollision" }]);

export interface IniKeyMigration {
  gus: IniSections;
  game: IniSections;
  /** The same changes expressed as in-place patch ops (empty = nothing to do). */
  ops: IniPatchOp[];
}

/**
 * - ServerPassword: [SessionSettings] → [ServerSettings]
 * - AllowPvP (not an ASA key) → ServerPVE
 * - Game.ini-only settings: GameUserSettings [ServerSettings] → Game.ini
 * An existing value at the destination always wins over the old copy.
 */
export function migrateIniKeys(gusIn: IniSections, gameIn: IniSections): IniKeyMigration {
  let gus = gusIn;
  let game = gameIn;
  const ops: IniPatchOp[] = [];

  const sessionPw = getIni(gus, "SessionSettings", "ServerPassword");
  if (sessionPw !== undefined) {
    if (getIni(gus, "ServerSettings", "ServerPassword") === undefined) {
      gus = setIni(gus, "ServerSettings", "ServerPassword", sessionPw);
      ops.push({ file: "gus", section: "ServerSettings", key: "ServerPassword", value: sessionPw });
    }
    gus = deleteIni(gus, "SessionSettings", "ServerPassword");
    ops.push({ file: "gus", section: "SessionSettings", key: "ServerPassword", value: null });
  }

  const allowPvP = getIni(gus, "ServerSettings", "AllowPvP");
  if (allowPvP !== undefined) {
    if (getIni(gus, "ServerSettings", "ServerPVE") === undefined) {
      const pve = isIniTrue(allowPvP) ? "False" : "True";
      gus = setIni(gus, "ServerSettings", "ServerPVE", pve);
      ops.push({ file: "gus", section: "ServerSettings", key: "ServerPVE", value: pve });
    }
    gus = deleteIni(gus, "ServerSettings", "AllowPvP");
    ops.push({ file: "gus", section: "ServerSettings", key: "AllowPvP", value: null });
  }

  for (const { from, to } of MOVE_TO_GAME_INI) {
    const v = getIni(gus, "ServerSettings", from);
    if (v === undefined) continue;
    if (getIni(game, GAME_MODE_SECTION, to) === undefined) {
      game = setIni(game, GAME_MODE_SECTION, to, v);
      ops.push({ file: "game", section: GAME_MODE_SECTION, key: to, value: v });
    }
    gus = deleteIni(gus, "ServerSettings", from);
    ops.push({ file: "gus", section: "ServerSettings", key: from, value: null });
  }

  return { gus, game, ops };
}

/**
 * Launch-arg fixes:
 * - "crossplay" / "AllPlatforms" toggles (neither is an ASA flag) → ServerPlatform=ALL
 * - NoTransferFromFiltering is now added automatically for cluster members
 *   (and only for them), so the stored per-server toggle is dropped.
 */
export function migrateLaunchArgs(argsIn: Record<string, string>): { args: Record<string, string>; changed: boolean } {
  const args = { ...argsIn };
  let changed = false;
  const wantedAll = args.crossplay === "true" || args.AllPlatforms === "true";
  for (const k of ["crossplay", "AllPlatforms", "NoTransferFromFiltering"]) {
    if (k in args) { delete args[k]; changed = true; }
  }
  if (wantedAll && !args.ServerPlatform) { args.ServerPlatform = "ALL"; changed = true; }
  return { args, changed };
}
