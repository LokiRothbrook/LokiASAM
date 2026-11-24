/**
 * preset-builder.ts — turns a game mode + style choice into the actual
 * GameUserSettings.ini / Game.ini section maps.
 *
 * Shared by the server creation wizard and the Config tab's Quick Setup so the
 * same preset always produces the same config. (Quick Setup used to apply only
 * the bare base preset, skipping ServerPVE, turret limits, breeding, etc.)
 */

import { buildPresetConfig, INI_FIELD_GROUPS } from "@/data/game-data";
import {
  type IniSections, GAME_MODE_SECTION, GAME_SESSION_SECTION,
  findSectionKey, mergeIniSections,
} from "@/lib/ini-utils";

export type GameMode = "pvp" | "pve";
export type PresetStyleId = "official" | "casual" | "boosted" | "guided_custom" | "full_custom";

export interface GuidedRates {
  // Core Rates
  xpMultiplier: number;
  harvestMultiplier: number;
  harvestHealthMultiplier: number;
  tamingMultiplier: number;
  wildDinoMaxLevel: number;
  resourceRespawnMultiplier: number;
  nightSpeedMultiplier: number;
  // Breeding
  matureSpeedMultiplier: number;
  hatchSpeedMultiplier: number;
  foodConsumptionMultiplier: number;
  matingIntervalMultiplier: number;
  matingSpeedMultiplier: number;
  cuddleIntervalMultiplier: number;
  cuddleGraceMultiplier: number;
  imprintAmountMultiplier: number;
  // Combat
  playerDamageMultiplier: number;
  playerResistanceMultiplier: number;
  dinoDamageMultiplier: number;
  dinoResistanceMultiplier: number;
  tamedDinoDamageMultiplier: number;
  tamedDinoResistanceMultiplier: number;
  structureDamageMultiplier: number;
  structureResistanceMultiplier: number;
  enableRespawnPenalty: boolean;
  enableTurretLimits: boolean;
  // Server QoL
  allowFlyingStaminaRecovery: boolean;
  allowSpeedLeveling: boolean;
  allowFlyerSpeedLeveling: boolean;
  allowUnlimitedRespecs: boolean;
  globalSpoilingTimeMultiplier: number;
  globalItemDecompMultiplier: number;
  globalCorpseDecompMultiplier: number;
}

export const DEFAULT_GUIDED_RATES: GuidedRates = {
  xpMultiplier: 2.0,
  harvestMultiplier: 2.0,
  harvestHealthMultiplier: 2.0,
  tamingMultiplier: 5.0,
  wildDinoMaxLevel: 150,
  resourceRespawnMultiplier: 0.5,
  nightSpeedMultiplier: 2.0,
  matureSpeedMultiplier: 10.0,
  hatchSpeedMultiplier: 10.0,
  foodConsumptionMultiplier: 5.0,
  matingIntervalMultiplier: 0.25,
  matingSpeedMultiplier: 2.0,
  cuddleIntervalMultiplier: 0.3,
  cuddleGraceMultiplier: 2.0,
  imprintAmountMultiplier: 2.0,
  playerDamageMultiplier: 1.0,
  playerResistanceMultiplier: 1.0,
  dinoDamageMultiplier: 1.0,
  dinoResistanceMultiplier: 1.0,
  tamedDinoDamageMultiplier: 1.0,
  tamedDinoResistanceMultiplier: 1.0,
  structureDamageMultiplier: 1.0,
  structureResistanceMultiplier: 1.0,
  enableRespawnPenalty: true,
  enableTurretLimits: true,
  allowFlyingStaminaRecovery: true,
  allowSpeedLeveling: false,
  allowFlyerSpeedLeveling: false,
  allowUnlimitedRespecs: false,
  globalSpoilingTimeMultiplier: 2.0,
  globalItemDecompMultiplier: 2.0,
  globalCorpseDecompMultiplier: 2.0,
};

/** The Game Mode step's toggles (shared by PvP and PvE unless noted). */
export interface GameModeOptions {
  adminLogging: boolean;
  serverCrosshair: boolean;
  showDamageNumbers: boolean;
  showPlayerLocation: boolean;
  forceAllStructureLocking: boolean;
  alwaysAllowStructurePickup: boolean;
  disableStructurePlacementCollision: boolean;
  // PvE only
  flyerCarryPvE: boolean;
  allowCaveBuildingPvE: boolean;
  pveAllowStructuresAtSupplyDrops: boolean;
  allowCrateSpawnsOnTopOfStructures: boolean;
  disableStructureDecayPvE: boolean;
  disableDinoDecayPvE: boolean;
  // PvP only
  pvpFriendlyFire: boolean;
  preventOfflinePvP: boolean;
  preventOfflinePvPInterval: number;
}

export const DEFAULT_GAME_MODE_OPTIONS: GameModeOptions = {
  adminLogging: true,
  serverCrosshair: true,
  showDamageNumbers: true,
  showPlayerLocation: true,
  forceAllStructureLocking: true,
  alwaysAllowStructurePickup: true,
  disableStructurePlacementCollision: false,
  flyerCarryPvE: false,
  allowCaveBuildingPvE: false,
  pveAllowStructuresAtSupplyDrops: true,
  allowCrateSpawnsOnTopOfStructures: true,
  disableStructureDecayPvE: false,
  disableDinoDecayPvE: false,
  pvpFriendlyFire: true,
  preventOfflinePvP: false,
  preventOfflinePvPInterval: 900,
};

/** Everything the builders need. The wizard's own data object satisfies this. */
export interface PresetBuildInput extends GameModeOptions {
  gameMode: GameMode;
  presetStyle: PresetStyleId;
  guidedRates: GuidedRates;
  /** Full Custom / Copy-from-server INI. Empty = build from the preset. */
  fullCustomGus: IniSections;
  fullCustomGameIni: IniSections;
  // Identity
  name: string;
  serverPassword: string;
  adminPassword: string;
  rconPort: number;
  maxPlayers: number;
  motdMessage: string;
  motdDuration: number;
}

/**
 * Keys the game only reads from Game.ini, derived from the field definitions.
 * Several base-preset values (breeding, spoiling, decomposition) are typed as
 * GameUserSettings keys; they're moved here so they actually take effect.
 */
const GAME_INI_KEYS = new Set(
  INI_FIELD_GROUPS.flatMap((g) => g.fields).filter((f) => f.section === "game").map((f) => f.key),
);

const tf = (b: boolean) => (b ? "True" : "False");

/** Apply the identity keys + MOTD to a GameUserSettings section map. */
function applyIdentity(gus: IniSections, input: PresetBuildInput): IniSections {
  const result: IniSections = mergeIniSections(gus, {
    SessionSettings: { SessionName: input.name },
    ServerSettings: {
      ServerPassword: input.serverPassword,
      ServerAdminPassword: input.adminPassword,
      RCONEnabled: "True",
      RCONPort: String(input.rconPort),
    },
    [GAME_SESSION_SECTION]: { MaxPlayers: String(input.maxPlayers) },
  });
  // ServerPassword belongs in [ServerSettings]; drop any stale copy left in
  // [SessionSettings] by a copied or older config.
  const session = findSectionKey(result, "SessionSettings");
  if (session && "ServerPassword" in result[session]) {
    result[session] = { ...result[session] };
    delete result[session].ServerPassword;
  }
  const motd = findSectionKey(result, "MessageOfTheDay");
  if (motd) delete result[motd];
  if (input.motdMessage.trim()) {
    result.MessageOfTheDay = { Message: input.motdMessage.trim(), Duration: String(input.motdDuration) };
  }
  return result;
}

/** The Game Mode step's GameUserSettings values. */
function gameModeServerSettings(input: PresetBuildInput): Record<string, string> {
  const s: Record<string, string> = {
    AdminLogging:               tf(input.adminLogging),
    ServerCrosshair:            tf(input.serverCrosshair),
    ShowFloatingDamageText:     tf(input.showDamageNumbers),
    ShowMapPlayerLocation:      tf(input.showPlayerLocation),
    ForceAllStructureLocking:   tf(input.forceAllStructureLocking),
    AlwaysAllowStructurePickup: tf(input.alwaysAllowStructurePickup),
    ServerPVE:                  tf(input.gameMode === "pve"),
  };
  if (input.gameMode === "pve") {
    s.AllowFlyerCarryPvE                = tf(input.flyerCarryPvE);
    s.AllowCaveBuildingPvE              = tf(input.allowCaveBuildingPvE);
    s.PvEAllowStructuresAtSupplyDrops   = tf(input.pveAllowStructuresAtSupplyDrops);
    s.AllowCrateSpawnsOnTopOfStructures = tf(input.allowCrateSpawnsOnTopOfStructures);
    s.DisableStructureDecayPvE          = tf(input.disableStructureDecayPvE);
    s.DisableDinoDecayPvE               = tf(input.disableDinoDecayPvE);
    // Auto-destroying decayed tames only makes sense while dino decay is on.
    s.AutoDestroyDecayedDinos           = tf(!input.disableDinoDecayPvE);
  } else {
    s.PreventOfflinePvP = tf(input.preventOfflinePvP);
    if (input.preventOfflinePvP) s.PreventOfflinePvPInterval = String(input.preventOfflinePvPInterval);
  }
  return s;
}

/** The Game Mode step's Game.ini values. */
function gameModeGameIni(input: PresetBuildInput): Record<string, string> {
  const g: Record<string, string> = {
    bDisableStructurePlacementCollision: tf(input.disableStructurePlacementCollision),
  };
  if (input.gameMode === "pve") {
    g.bDisableFriendlyFire = "True";
    g.bPvEDisableFriendlyFire = "True";
  } else if (!input.pvpFriendlyFire) {
    g.bDisableFriendlyFire = "True";
  }
  return g;
}

/**
 * Build the preset-derived [ServerSettings] values plus any Game.ini keys that
 * the base preset typed as GameUserSettings (returned separately so they can
 * be routed to Game.ini).
 */
function presetSettings(input: PresetBuildInput): { serverSettings: Record<string, string>; movedToGameIni: Record<string, string> } {
  const { gameMode: mode, presetStyle: style } = input;
  let config = buildPresetConfig(mode, style) as unknown as Record<string, unknown>;

  if (style === "guided_custom") {
    const r = input.guidedRates;
    config = {
      ...config,
      XPMultiplier: r.xpMultiplier,
      HarvestAmountMultiplier: r.harvestMultiplier,
      TamingSpeedMultiplier: r.tamingMultiplier,
      ResourcesRespawnPeriodMultiplier: r.resourceRespawnMultiplier,
      PlayerDamageMultiplier: r.playerDamageMultiplier,
      NightTimeSpeedScale: r.nightSpeedMultiplier,
      OverrideOfficialDifficulty: r.wildDinoMaxLevel / 30,
      DifficultyOffset: 1.0,
    };
  }

  // Identity / network keys are handled by applyIdentity, never by the preset.
  const skipKeys = new Set(["QueryPort", "Port", "MaxPlayers", "SessionName", "ServerPassword", "ServerAdminPassword", "RCONEnabled", "RCONPort"]);
  const serverSettings: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    if (skipKeys.has(k) || v === undefined || v === null) continue;
    serverSettings[k] = typeof v === "boolean" ? tf(v) : String(v);
  }

  const isNamedPreset = style === "official" || style === "casual" || style === "boosted";
  if (isNamedPreset) {
    serverSettings.DinoCountMultiplier = "1.0";
    serverSettings.MaxTamedDinos = "5000";
  }

  if (style === "official") {
    serverSettings.MaxPersonalTamedDinos = mode === "pvp" ? "300" : "500";
    serverSettings.NPCNetworkStasisRangeScalePlayerCountStart = "24";
    serverSettings.NPCNetworkStasisRangeScalePlayerCountEnd = "70";
    serverSettings.NPCNetworkStasisRangeScalePercentEnd = "0.5";
    serverSettings.BanListURL = "http://arkdedicated.com/banlist.txt";
    if (mode === "pve") {
      serverSettings.OnlyAutoDestroyCoreStructures = "True";
    }
  }

  if (style === "casual") {
    serverSettings.MaxPersonalTamedDinos = "500";
    serverSettings.AllowFlyingStaminaRecovery = "True";
    serverSettings.HarvestHealthMultiplier = "2.0";
    // PvE wants 2.0; PvP keeps the preset's 1.5
    if (mode === "pve") serverSettings.GlobalSpoilingTimeMultiplier = "2.0";
  }

  if (style === "boosted") {
    // Taming rate differs by mode — PRESET_STYLES has a generic 10× which we override here
    serverSettings.TamingSpeedMultiplier = mode === "pvp" ? "15.0" : "25.0";
    serverSettings.MaxPersonalTamedDinos = "500";
    serverSettings.AllowFlyingStaminaRecovery = "True";
    serverSettings.HarvestHealthMultiplier = "2.0";
    serverSettings.GlobalItemDecompositionTimeMultiplier = mode === "pve" ? "3.0" : "2.0";
    // PvE wants 3.0; PvP keeps the preset's 2.0
    if (mode === "pve") serverSettings.GlobalSpoilingTimeMultiplier = "3.0";
  }

  if (style === "guided_custom") {
    const r = input.guidedRates;
    serverSettings.HarvestHealthMultiplier          = String(r.harvestHealthMultiplier);
    serverSettings.PlayerResistanceMultiplier        = String(r.playerResistanceMultiplier);
    serverSettings.DinoCountMultiplier               = "1.0";
    serverSettings.DinoDamageMultiplier              = String(r.dinoDamageMultiplier);
    serverSettings.DinoResistanceMultiplier          = String(r.dinoResistanceMultiplier);
    serverSettings.TamedDinoDamageMultiplier         = String(r.tamedDinoDamageMultiplier);
    serverSettings.TamedDinoResistanceMultiplier     = String(r.tamedDinoResistanceMultiplier);
    serverSettings.StructureDamageMultiplier         = String(r.structureDamageMultiplier);
    serverSettings.StructureResistanceMultiplier     = String(r.structureResistanceMultiplier);
    serverSettings.MaxTamedDinos                     = "5000";
    serverSettings.MaxPersonalTamedDinos             = "500";
    serverSettings.GlobalSpoilingTimeMultiplier      = String(r.globalSpoilingTimeMultiplier);
    serverSettings.GlobalItemDecompositionTimeMultiplier = String(r.globalItemDecompMultiplier);
    serverSettings.AllowFlyingStaminaRecovery        = tf(r.allowFlyingStaminaRecovery);
    serverSettings.AutoSavePeriodMinutes             = "15.0";
  }

  // Route Game.ini-only keys out of [ServerSettings].
  const movedToGameIni: Record<string, string> = {};
  for (const k of Object.keys(serverSettings)) {
    if (GAME_INI_KEYS.has(k)) {
      movedToGameIni[k] = serverSettings[k];
      delete serverSettings[k];
    }
  }
  return { serverSettings, movedToGameIni };
}

/** Game.ini values specific to the chosen preset style. */
function presetGameIni(input: PresetBuildInput): Record<string, string> {
  const { gameMode: mode, presetStyle: style } = input;
  const g: Record<string, string> = {};
  const isNamedPreset = style === "official" || style === "casual" || style === "boosted";

  if (isNamedPreset) {
    if (mode === "pvp") {
      // Repeat-kill respawn penalty (all PvP named presets)
      g.bIncreasePvPRespawnInterval = "True";
      g.IncreasePvPRespawnIntervalBaseAmount = "60.0";
      g.IncreasePvPRespawnIntervalCheckPeriod = "300.0";
      g.IncreasePvPRespawnIntervalMultiplier = "2.0";
    }
    if (mode === "pve") g.bPvEAllowTribeWar = "True";

    // Turret limits (all named presets)
    g.bLimitTurretsInRange = "True";
    g.bHardLimitTurretsInRange = "True";
    g.LimitTurretsNum = "100";
    g.LimitTurretsRange = "10000";

    if (style === "official") {
      g.LimitNonPlayerDroppedItemsCount = "600";
      g.LimitNonPlayerDroppedItemsRange = "1600";
    }
    if (style === "boosted") {
      g.bAllowFlyerSpeedLeveling = "True";
      g.bAllowSpeedLeveling = "True";
      g.bAllowUnlimitedRespecs = "True";
    }
    if (mode === "pve" && style === "casual") g.bAllowUnlimitedRespecs = "True";
    if (mode === "pve" && style === "boosted") {
      g.bAllowPlatformSaddleMultiFloors = "True";
      g.LayEggIntervalMultiplier = "0.5";
      g.FuelConsumptionIntervalMultiplier = "2.0";
    }

    const BREEDING: Record<string, Record<GameMode, Record<string, string>>> = {
      casual: {
        pvp: {
          BabyMatureSpeedMultiplier: "5.0",
          EggHatchSpeedMultiplier: "5.0",
          BabyFoodConsumptionSpeedMultiplier: "5.0",
          BabyCuddleIntervalMultiplier: "0.5",
          BabyCuddleGracePeriodMultiplier: "2.0",
          MatingIntervalMultiplier: "0.5",
        },
        pve: {
          BabyMatureSpeedMultiplier: "10.0",
          EggHatchSpeedMultiplier: "10.0",
          BabyFoodConsumptionSpeedMultiplier: "5.0",
          BabyCuddleIntervalMultiplier: "0.3",
          BabyCuddleGracePeriodMultiplier: "2.0",
          BabyImprintAmountMultiplier: "2.0",
          MatingIntervalMultiplier: "0.25",
          MatingSpeedMultiplier: "2.0",
          GlobalCorpseDecompositionTimeMultiplier: "2.0",
        },
      },
      boosted: {
        pvp: {
          BabyMatureSpeedMultiplier: "30.0",
          EggHatchSpeedMultiplier: "30.0",
          BabyFoodConsumptionSpeedMultiplier: "1.0",
          BabyCuddleIntervalMultiplier: "0.1",
          BabyCuddleGracePeriodMultiplier: "2.0",
          MatingIntervalMultiplier: "0.1",
          MatingSpeedMultiplier: "2.0",
        },
        pve: {
          BabyMatureSpeedMultiplier: "50.0",
          EggHatchSpeedMultiplier: "50.0",
          BabyFoodConsumptionSpeedMultiplier: "0.5",
          BabyCuddleIntervalMultiplier: "0.1",
          BabyCuddleGracePeriodMultiplier: "5.0",
          BabyImprintAmountMultiplier: "4.0",
          MatingIntervalMultiplier: "0.05",
          MatingSpeedMultiplier: "2.0",
          GlobalCorpseDecompositionTimeMultiplier: "3.0",
        },
      },
    };
    const breeding = BREEDING[style]?.[mode];
    if (breeding) Object.assign(g, breeding);
  } else if (style === "guided_custom") {
    const r = input.guidedRates;
    if (mode === "pve") {
      g.bPvEAllowTribeWar = "True";
      g.GlobalCorpseDecompositionTimeMultiplier = String(r.globalCorpseDecompMultiplier);
    }
    g.BabyMatureSpeedMultiplier            = String(r.matureSpeedMultiplier);
    g.EggHatchSpeedMultiplier              = String(r.hatchSpeedMultiplier);
    g.BabyFoodConsumptionSpeedMultiplier   = String(r.foodConsumptionMultiplier);
    g.MatingIntervalMultiplier             = String(r.matingIntervalMultiplier);
    g.MatingSpeedMultiplier                = String(r.matingSpeedMultiplier);
    g.BabyCuddleIntervalMultiplier         = String(r.cuddleIntervalMultiplier);
    g.BabyCuddleGracePeriodMultiplier      = String(r.cuddleGraceMultiplier);
    if (r.imprintAmountMultiplier !== 1.0) g.BabyImprintAmountMultiplier = String(r.imprintAmountMultiplier);
    if (r.allowSpeedLeveling)      g.bAllowSpeedLeveling      = "True";
    if (r.allowFlyerSpeedLeveling) g.bAllowFlyerSpeedLeveling = "True";
    if (r.allowUnlimitedRespecs)   g.bAllowUnlimitedRespecs   = "True";
    if (mode === "pvp" && r.enableRespawnPenalty) {
      g.bIncreasePvPRespawnInterval           = "True";
      g.IncreasePvPRespawnIntervalBaseAmount  = "60.0";
      g.IncreasePvPRespawnIntervalCheckPeriod = "300.0";
      g.IncreasePvPRespawnIntervalMultiplier  = "2.0";
    }
    if (r.enableTurretLimits) {
      g.bLimitTurretsInRange     = "True";
      g.bHardLimitTurretsInRange = "True";
      g.LimitTurretsNum          = "100";
      g.LimitTurretsRange        = "10000";
    }
  }
  return g;
}

/**
 * Gameplay-only GameUserSettings sections for a preset (no identity keys).
 * Used directly by Quick Setup, which must never touch identity.
 */
export function buildPresetGus(input: PresetBuildInput): IniSections {
  const { serverSettings } = presetSettings(input);
  return { ServerSettings: { ...serverSettings, ...gameModeServerSettings(input) } };
}

/** Gameplay Game.ini sections for a preset. */
export function buildPresetGameIni(input: PresetBuildInput): IniSections {
  const { movedToGameIni } = presetSettings(input);
  return {
    [GAME_MODE_SECTION]: { ...movedToGameIni, ...presetGameIni(input), ...gameModeGameIni(input) },
  };
}

const hasCustom = (s: IniSections) => Object.keys(s).length > 0;

/** Full GameUserSettings.ini for a new server (gameplay + identity + MOTD). */
export function buildGusSections(input: PresetBuildInput): IniSections {
  // Full Custom / Copy: the user's INI is the base. The Full Custom editor is
  // seeded from buildPresetGus, so the Game Mode step's choices are already in
  // it; anything the user changed afterwards wins.
  const gameplay = input.presetStyle === "full_custom" && hasCustom(input.fullCustomGus)
    ? input.fullCustomGus
    : buildPresetGus(input);
  return applyIdentity(gameplay, input);
}

/** Full Game.ini for a new server. */
export function buildGameIniSections(input: PresetBuildInput): IniSections {
  const base = buildPresetGameIni(input);
  // Copied / custom Game.ini wins over the preset-derived values.
  return input.presetStyle === "full_custom" && hasCustom(input.fullCustomGameIni)
    ? mergeIniSections(base, input.fullCustomGameIni)
    : base;
}
