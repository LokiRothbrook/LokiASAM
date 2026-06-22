/**
 * game-data.ts — SINGLE SOURCE OF TRUTH for all Ark Survival Ascended game data.
 *
 * Rules:
 *  - All ASA map names, presets, launch parameters, and INI field definitions live here.
 *  - No component or page may hard-code map names, parameter keys, or preset values.
 *  - To add a new map: add one entry to ARK_MAPS. Every dropdown, wizard, and form
 *    that shows maps imports from this file and will automatically include it.
 *  - This is ASA (Ark Survival Ascended), NOT ASE (Ark Survival Evolved).
 */

// ---------------------------------------------------------------------------
// Steam App IDs
// ---------------------------------------------------------------------------

/** Steam App ID for the ASA Dedicated Server (used with SteamCMD +app_update). */
export const ASA_SERVER_APP_ID = "2430930";

/**
 * Steam App ID for the ASA client. Used with SteamCMD workshop_download_item
 * when downloading mods, because workshop items are published under the client ID.
 */
export const ASA_CLIENT_APP_ID = "2399830";

// ---------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------

export interface ArkMap {
  /** Internal key stored in the DB and used in launch args. Never change once set. */
  id: string;
  /** Human-readable name shown in all UI dropdowns and cards. */
  displayName: string;
  /**
   * The map path value passed after the server executable
   * (e.g. `ArkAscendedServer.exe TheIsland_WP?listen?...`).
   */
  mapPath: string;
  /** True if this is an official WildCard / Studio Wildcard map. */
  isOfficial: boolean;
  /** True if the player needs to own a paid DLC/expansion to access this map. */
  dlcRequired: boolean;
  /** Name of the DLC/expansion (if dlcRequired is true). */
  dlcName?: string;
  /** Whether this map is currently released in ASA (false = announced/upcoming). */
  released: boolean;
  /**
   * True if this map is delivered as a CurseForge mod rather than built into the game.
   * When true, `requiredModId` is the CurseForge mod ID that must be installed and
   * included in the server's mod list for this map to be available.
   */
  isMod: boolean;
  /**
   * CurseForge mod ID required to run this map (only set when isMod = true).
   * This mod is automatically added to the server's mod list and locked when the
   * map is selected — the user cannot remove it without changing the map.
   */
  requiredModId?: string;
}

/**
 * All ASA maps. To add a new map, append an entry here — no other file needs editing.
 * Maps marked `released: false` are shown in the UI as "Coming Soon" and cannot be
 * selected during server creation.
 *
 * Official map release status as of 2026:
 *   Released: The Island, Scorched Earth, Aberration, The Center, Extinction,
 *             Astraeos, Ragnarok, Valguero, Lost Colony
 *   Upcoming: Genesis Part 1, Genesis Part 2, Lost Island, Fjordur, Crystal Isles
 */
export const ARK_MAPS: ArkMap[] = [
  // ── Official / Base Game ──────────────────────────────────────────────────
  {
    id: "theisland",
    displayName: "The Island",
    mapPath: "TheIsland_WP",
    isOfficial: true,
    dlcRequired: false,
    released: true,
    isMod: false,
  },
  {
    id: "thecenter",
    displayName: "The Center",
    mapPath: "TheCenter_WP",
    isOfficial: true,
    dlcRequired: false,
    released: true,
    isMod: false,
  },
  {
    id: "ragnarok",
    displayName: "Ragnarok",
    mapPath: "Ragnarok_WP",
    isOfficial: true,
    dlcRequired: false,
    released: true,
    isMod: false,
  },
  {
    id: "valguero",
    displayName: "Valguero",
    mapPath: "Valguero_WP",
    isOfficial: true,
    dlcRequired: false,
    released: true,
    isMod: false,
  },

  // ── Official / Paid DLC ───────────────────────────────────────────────────
  {
    id: "scorched",
    displayName: "Scorched Earth",
    mapPath: "ScorchedEarth_WP",
    isOfficial: true,
    dlcRequired: true,
    dlcName: "Scorched Earth",
    released: true,
    isMod: false,
  },
  {
    id: "aberration",
    displayName: "Aberration",
    mapPath: "Aberration_WP",
    isOfficial: true,
    dlcRequired: true,
    dlcName: "Aberration",
    released: true,
    isMod: false,
  },
  {
    id: "extinction",
    displayName: "Extinction",
    mapPath: "Extinction_WP",
    isOfficial: true,
    dlcRequired: true,
    dlcName: "Extinction",
    released: true,
    isMod: false,
  },
  {
    id: "astraeos",
    displayName: "Astraeos",
    mapPath: "Astraeos_WP",
    isOfficial: true,
    dlcRequired: true,
    dlcName: "Astraeos",
    released: true,
    isMod: false,
  },
  {
    id: "lostcolony",
    displayName: "Lost Colony",
    mapPath: "LostColony_WP",
    isOfficial: true,
    dlcRequired: true,
    dlcName: "Lost Colony",
    released: true,
    isMod: false,
  },
  // ── Official / Announced but Not Yet Released ─────────────────────────────
  {
    id: "genesis1",
    displayName: "Genesis: Part 1",
    mapPath: "Genesis_WP",
    isOfficial: true,
    dlcRequired: true,
    dlcName: "Genesis: Part 1",
    released: false,
    isMod: false,
  },
  {
    id: "genesis2",
    displayName: "Genesis: Part 2",
    mapPath: "Gen2_WP",
    isOfficial: true,
    dlcRequired: true,
    dlcName: "Genesis: Part 2",
    released: false,
    isMod: false,
  },
  {
    id: "lostisland",
    displayName: "Lost Island",
    mapPath: "LostIsland_WP",
    isOfficial: true,
    dlcRequired: false,
    released: false,
    isMod: false,
  },
  {
    id: "fjordur",
    displayName: "Fjordur",
    mapPath: "Fjordur_WP",
    isOfficial: true,
    dlcRequired: false,
    released: false,
    isMod: false,
  },
  {
    id: "crystalisles",
    displayName: "Crystal Isles",
    mapPath: "CrystalIsles_WP",
    isOfficial: true,
    dlcRequired: false,
    released: false,
    isMod: false,
  },

  // ── Mod Maps (CurseForge) ─────────────────────────────────────────────────
  {
    id: "amissa",
    displayName: "Amissa",
    mapPath: "Amissa_WP",
    isOfficial: false,
    dlcRequired: false,
    released: true,
    isMod: true,
    requiredModId: "965379",
  },
  {
    id: "svartalfheim",
    displayName: "Svartalfheim",
    mapPath: "Svartalfheim_WP",
    isOfficial: false,
    dlcRequired: false,
    released: true,
    isMod: true,
    requiredModId: "942355",
  },
  {
    id: "clubark",
    displayName: "Club ARK",
    mapPath: "ClubARK_WP",
    isOfficial: false,
    dlcRequired: false,
    released: true,
    isMod: true,
    requiredModId: "1005639",
  },
];

/** Returns only maps that are currently released and selectable. */
export function getReleasedMaps(): ArkMap[] {
  return ARK_MAPS.filter((m) => m.released);
}

/** Returns released official (non-mod) maps. */
export function getOfficialMaps(): ArkMap[] {
  return ARK_MAPS.filter((m) => m.released && !m.isMod);
}

/** Returns released mod maps. */
export function getModMaps(): ArkMap[] {
  return ARK_MAPS.filter((m) => m.released && m.isMod);
}

/** Look up a map by its internal ID. Returns undefined if not found. */
export function getMapById(id: string): ArkMap | undefined {
  return ARK_MAPS.find((m) => m.id === id);
}

// ---------------------------------------------------------------------------
// GameUserSettings.ini typed config
// ---------------------------------------------------------------------------

/**
 * Typed representation of the [ServerSettings] and [SessionSettings] sections
 * of GameUserSettings.ini. Keys match the exact INI key names used by ASA.
 */
export interface GameUserSettingsConfig {
  // [SessionSettings]
  SessionName: string;
  ServerPassword: string;
  ServerAdminPassword: string;
  MaxPlayers: number;
  QueryPort: number;
  Port: number;
  RCONEnabled: boolean;
  RCONPort: number;

  // [ServerSettings] — rates
  XPMultiplier: number;
  TamingSpeedMultiplier: number;
  HarvestAmountMultiplier: number;
  ResourcesRespawnPeriodMultiplier: number;
  MatingIntervalMultiplier: number;
  EggHatchSpeedMultiplier: number;
  BabyMatureSpeedMultiplier: number;
  BabyCuddleIntervalMultiplier: number;
  BabyImprintingStatScaleMultiplier: number;
  BabyImprintAmountMultiplier: number;

  // [ServerSettings] — player/dino tuning
  PlayerDamageMultiplier: number;
  PlayerResistanceMultiplier: number;
  DinoResistanceMultiplier: number;
  DinoDamageMultiplier: number;
  PlayerCharacterFoodDrainMultiplier: number;
  PlayerCharacterWaterDrainMultiplier: number;
  PlayerCharacterStaminaDrainMultiplier: number;
  PlayerCharacterHealthRecoveryMultiplier: number;
  DinoCharacterFoodDrainMultiplier: number;
  DinoCharacterStaminaDrainMultiplier: number;
  DinoCharacterHealthRecoveryMultiplier: number;

  // [ServerSettings] — PvP / PvE
  AllowPvP: boolean;
  AllowCaveBuildingPvE: boolean;
  AllowCaveBuildingPvP: boolean;
  AllowFlyerCarryPvE: boolean;
  DisablePvEGoodBerryGlobalSpoilingTime: boolean;
  PreventOfflinePvP: boolean;
  PreventOfflinePvPInterval: number;
  EnableCryoSicknessPVE: boolean;

  // [ServerSettings] — admin / RCON
  ServerCrosshair: boolean;
  ShowMapPlayerLocation: boolean;
  EnablePvPGamma: boolean;
  AdminLogging: boolean;
  AllowThirdPersonPlayer: boolean;
  AlwaysNotifyPlayerLeft: boolean;
  AlwaysNotifyPlayerJoined: boolean;
  GlobalVoiceChat: boolean;
  ProximityChat: boolean;
  AllowHitMarkers: boolean;

  // [ServerSettings] — tribe / structure
  MaxNumberOfPlayersInTribe: number;
  TribeNameChangeCooldown: number;
  StructureDamageMultiplier: number;
  StructureResistanceMultiplier: number;
  PvEStructureDecayDestructionPeriod: number;
  PvEStructureDecayPeriodMultiplier: number;
  AutoDestroyOldStructuresMultiplier: number;

  // [ServerSettings] — time / environment
  NightTimeSpeedScale: number;
  DayTimeSpeedScale: number;
  DayCycleSpeedScale: number;
  DifficultyOffset: number;
  OverrideOfficialDifficulty: number;

  // [ServerSettings] — spoilage / decomposition
  GlobalSpoilingTimeMultiplier: number;
  GlobalItemDecompositionTimeMultiplier: number;
  GlobalCorpseDecompositionTimeMultiplier: number;

  // [ServerSettings] — misc
  AutoSavePeriodMinutes: number;
  AllowAnyoneBabyImprintCuddle: boolean;
  AllowMultipleAttachedC4: boolean;
  AllowRaidDinoFeeding: boolean;
  ClampItemStats: boolean;
}

// ---------------------------------------------------------------------------
// Game.ini typed config
// ---------------------------------------------------------------------------

/**
 * Typed representation of the [/script/shootergame.shootergamemode] section
 * of Game.ini.
 */
export interface GameIniConfig {
  // Engrams
  bOnlyAllowSpecifiedEngrams: boolean;
  OverrideEngramEntries: string[];

  // Supply drops
  ConfigOverrideSupplyCrateItems: string[];

  // Stat clamps — per-level multipliers (index = stat slot)
  PerLevelStatsMultiplier_Player: number[];
  PerLevelStatsMultiplier_DinoTamed: number[];
  PerLevelStatsMultiplier_DinoWild: number[];
}

// ---------------------------------------------------------------------------
// Default config values (used as the baseline for presets)
// ---------------------------------------------------------------------------

/** Vanilla/Official-like defaults for GameUserSettings.ini fields. */
export const DEFAULT_GAME_USER_SETTINGS: GameUserSettingsConfig = {
  SessionName: "My ASA Server",
  ServerPassword: "",
  ServerAdminPassword: "changeme",
  MaxPlayers: 70,
  QueryPort: 27015,
  Port: 7777,
  RCONEnabled: true,
  RCONPort: 27020,

  XPMultiplier: 1.0,
  TamingSpeedMultiplier: 1.0,
  HarvestAmountMultiplier: 1.0,
  ResourcesRespawnPeriodMultiplier: 1.0,
  MatingIntervalMultiplier: 1.0,
  EggHatchSpeedMultiplier: 1.0,
  BabyMatureSpeedMultiplier: 1.0,
  BabyCuddleIntervalMultiplier: 1.0,
  BabyImprintingStatScaleMultiplier: 1.0,
  BabyImprintAmountMultiplier: 1.0,

  PlayerDamageMultiplier: 1.0,
  PlayerResistanceMultiplier: 1.0,
  DinoResistanceMultiplier: 1.0,
  DinoDamageMultiplier: 1.0,
  PlayerCharacterFoodDrainMultiplier: 1.0,
  PlayerCharacterWaterDrainMultiplier: 1.0,
  PlayerCharacterStaminaDrainMultiplier: 1.0,
  PlayerCharacterHealthRecoveryMultiplier: 1.0,
  DinoCharacterFoodDrainMultiplier: 1.0,
  DinoCharacterStaminaDrainMultiplier: 1.0,
  DinoCharacterHealthRecoveryMultiplier: 1.0,

  AllowPvP: false,
  AllowCaveBuildingPvE: false,
  AllowCaveBuildingPvP: true,
  AllowFlyerCarryPvE: false,
  DisablePvEGoodBerryGlobalSpoilingTime: false,
  PreventOfflinePvP: false,
  PreventOfflinePvPInterval: 900,
  EnableCryoSicknessPVE: true,

  ServerCrosshair: true,
  ShowMapPlayerLocation: false,
  EnablePvPGamma: false,
  AdminLogging: false,
  AllowThirdPersonPlayer: true,
  AlwaysNotifyPlayerLeft: false,
  AlwaysNotifyPlayerJoined: false,
  GlobalVoiceChat: false,
  ProximityChat: false,
  AllowHitMarkers: true,

  MaxNumberOfPlayersInTribe: 0,
  TribeNameChangeCooldown: 15,
  StructureDamageMultiplier: 1.0,
  StructureResistanceMultiplier: 1.0,
  PvEStructureDecayDestructionPeriod: 0,
  PvEStructureDecayPeriodMultiplier: 1.0,
  AutoDestroyOldStructuresMultiplier: 0.0,

  NightTimeSpeedScale: 1.0,
  DayTimeSpeedScale: 1.0,
  DayCycleSpeedScale: 1.0,
  DifficultyOffset: 1.0,
  OverrideOfficialDifficulty: 5.0,

  GlobalSpoilingTimeMultiplier: 1.0,
  GlobalItemDecompositionTimeMultiplier: 1.0,
  GlobalCorpseDecompositionTimeMultiplier: 1.0,

  AutoSavePeriodMinutes: 15.0,
  AllowAnyoneBabyImprintCuddle: false,
  AllowMultipleAttachedC4: false,
  AllowRaidDinoFeeding: false,
  ClampItemStats: false,
};

/** Vanilla/Official-like defaults for Game.ini fields. */
export const DEFAULT_GAME_INI: GameIniConfig = {
  bOnlyAllowSpecifiedEngrams: false,
  OverrideEngramEntries: [],
  ConfigOverrideSupplyCrateItems: [],
  PerLevelStatsMultiplier_Player: [],
  PerLevelStatsMultiplier_DinoTamed: [],
  PerLevelStatsMultiplier_DinoWild: [],
};

// ---------------------------------------------------------------------------
// Game Mode (PvP vs PvE) — Step 1 of the wizard
// ---------------------------------------------------------------------------

export interface GameModeConfig {
  id: "pvp" | "pve";
  displayName: string;
  description: string;
  icon: string;
  gameUserSettings: Partial<GameUserSettingsConfig>;
}

export const GAME_MODES: GameModeConfig[] = [
  {
    id: "pve",
    displayName: "PvE",
    icon: "🌿",
    description:
      "Player vs Environment. Cooperative gameplay — no player-vs-player combat. Ideal for friends building together or solo players. Friendly fire and cryo sickness are disabled.",
    gameUserSettings: {
      AllowPvP: false,
      AllowCaveBuildingPvE: true,
      AllowFlyerCarryPvE: true,
      EnablePvPGamma: false,
      PreventOfflinePvP: false,
      EnableCryoSicknessPVE: false,
    },
  },
  {
    id: "pvp",
    displayName: "PvP",
    icon: "⚔️",
    description:
      "Player vs Player. Competitive combat enabled. Players and tribes can raid each other's bases and tames.",
    gameUserSettings: {
      AllowPvP: true,
      EnablePvPGamma: true,
      PreventOfflinePvP: true,
      PreventOfflinePvPInterval: 900,
      AllowCaveBuildingPvE: false,
      AllowFlyerCarryPvE: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Preset Styles — Step 2 of the wizard
// ---------------------------------------------------------------------------

export interface PresetStyle {
  id: "official" | "casual" | "boosted" | "guided_custom" | "full_custom";
  displayName: string;
  description: string;
  tags: string[];
  gameUserSettings: Partial<GameUserSettingsConfig>;
  gameIni: Partial<GameIniConfig>;
}

export const PRESET_STYLES: PresetStyle[] = [
  {
    id: "official",
    displayName: "Official Rates",
    description:
      "Mirrors WildCard official server rates. A hardcore, authentic experience. Progression takes time.",
    tags: ["Official Rates", "1× All"],
    gameUserSettings: {
      XPMultiplier: 1.0,
      TamingSpeedMultiplier: 1.0,
      HarvestAmountMultiplier: 1.0,
      ResourcesRespawnPeriodMultiplier: 1.0,
      MatingIntervalMultiplier: 1.0,
      EggHatchSpeedMultiplier: 1.0,
      BabyMatureSpeedMultiplier: 1.0,
      BabyCuddleIntervalMultiplier: 1.0,
      DayCycleSpeedScale: 1.0,
      NightTimeSpeedScale: 1.0,
      GlobalSpoilingTimeMultiplier: 1.0,
    },
    gameIni: {},
  },
  {
    id: "casual",
    displayName: "Casual",
    description:
      "Slightly boosted rates to smooth out the grind. Great for regular players who want progression without excessive time investment.",
    tags: ["Casual", "2–3× Rates"],
    gameUserSettings: {
      XPMultiplier: 2.0,
      TamingSpeedMultiplier: 5.0,
      HarvestAmountMultiplier: 2.0,
      ResourcesRespawnPeriodMultiplier: 0.5,
      MatingIntervalMultiplier: 0.5,
      EggHatchSpeedMultiplier: 5.0,
      BabyMatureSpeedMultiplier: 5.0,
      BabyCuddleIntervalMultiplier: 0.5,
      NightTimeSpeedScale: 2.0,
      GlobalSpoilingTimeMultiplier: 1.5,
      PlayerCharacterFoodDrainMultiplier: 0.5,
      PlayerCharacterWaterDrainMultiplier: 0.5,
    },
    gameIni: {},
  },
  {
    id: "boosted",
    displayName: "Boosted",
    description:
      "Very high rates for a fast-paced, relaxed experience. Ideal for small friend groups or solo players who want to enjoy the game without the grind.",
    tags: ["Boosted", "5–25× Rates"],
    gameUserSettings: {
      XPMultiplier: 5.0,
      TamingSpeedMultiplier: 10.0,
      HarvestAmountMultiplier: 5.0,
      ResourcesRespawnPeriodMultiplier: 0.25,
      MatingIntervalMultiplier: 0.1,
      EggHatchSpeedMultiplier: 25.0,
      BabyMatureSpeedMultiplier: 25.0,
      BabyCuddleIntervalMultiplier: 0.1,
      BabyImprintAmountMultiplier: 2.0,
      NightTimeSpeedScale: 3.0,
      GlobalSpoilingTimeMultiplier: 2.0,
      AllowAnyoneBabyImprintCuddle: true,
      PlayerCharacterFoodDrainMultiplier: 0.25,
      PlayerCharacterWaterDrainMultiplier: 0.25,
    },
    gameIni: {},
  },
  {
    id: "guided_custom",
    displayName: "Guided Custom",
    description:
      "Walk through the key rate sliders and options one by one. Lets you dial in exactly the experience you want without editing raw INI files.",
    tags: ["Custom", "Guided"],
    gameUserSettings: {},
    gameIni: {},
  },
  {
    id: "full_custom",
    displayName: "Full Custom",
    description:
      "Direct access to the complete INI configuration editor. Set any server value before installation.",
    tags: ["Custom", "Advanced"],
    gameUserSettings: {},
    gameIni: {},
  },
];

/**
 * Compute the full GameUserSettings config for a given mode + style combo.
 * Priority: defaults → mode settings → style settings.
 */
export function buildPresetConfig(
  modeId: "pvp" | "pve",
  styleId: string,
  overrides?: Partial<GameUserSettingsConfig>
): GameUserSettingsConfig {
  const mode = GAME_MODES.find((m) => m.id === modeId);
  const style = PRESET_STYLES.find((s) => s.id === styleId);
  return {
    ...DEFAULT_GAME_USER_SETTINGS,
    ...(mode?.gameUserSettings ?? {}),
    ...(style?.gameUserSettings ?? {}),
    ...(overrides ?? {}),
  };
}

// ---------------------------------------------------------------------------
// Legacy SERVER_PRESETS (kept for existing server cards + overview display)
// ---------------------------------------------------------------------------

export interface ServerPreset {
  id: string;
  displayName: string;
  description: string;
  tags: string[];
  gameUserSettings: Partial<GameUserSettingsConfig>;
  gameIni: Partial<GameIniConfig>;
}

/**
 * Full preset list combining mode + style for the overview display.
 * New servers use the 2-axis (mode + style) system in the wizard; these
 * combined presets are generated here for label/tag display on server cards.
 */
export const SERVER_PRESETS: ServerPreset[] = [
  // PvE presets
  {
    id: "pve_official",
    displayName: "PvE — Official",
    description: "Cooperative play at official WildCard rates.",
    tags: ["PvE", "Official Rates"],
    gameUserSettings: { ...GAME_MODES[0].gameUserSettings, ...PRESET_STYLES[0].gameUserSettings },
    gameIni: {},
  },
  {
    id: "pve_casual",
    displayName: "PvE — Casual",
    description: "Cooperative play with slightly boosted rates.",
    tags: ["PvE", "Casual", "2–3×"],
    gameUserSettings: { ...GAME_MODES[0].gameUserSettings, ...PRESET_STYLES[1].gameUserSettings },
    gameIni: {},
  },
  {
    id: "pve_boosted",
    displayName: "PvE — Boosted",
    description: "Cooperative play with very high rates for fast progression.",
    tags: ["PvE", "Boosted", "5–25×"],
    gameUserSettings: { ...GAME_MODES[0].gameUserSettings, ...PRESET_STYLES[2].gameUserSettings },
    gameIni: {},
  },
  // PvP presets
  {
    id: "pvp_official",
    displayName: "PvP — Official",
    description: "Competitive PvP at official WildCard rates.",
    tags: ["PvP", "Official Rates"],
    gameUserSettings: { ...GAME_MODES[1].gameUserSettings, ...PRESET_STYLES[0].gameUserSettings },
    gameIni: {},
  },
  {
    id: "pvp_casual",
    displayName: "PvP — Casual",
    description: "Competitive PvP with slightly boosted rates.",
    tags: ["PvP", "Casual", "2–3×"],
    gameUserSettings: { ...GAME_MODES[1].gameUserSettings, ...PRESET_STYLES[1].gameUserSettings },
    gameIni: {},
  },
  {
    id: "pvp_boosted",
    displayName: "PvP — Boosted",
    description: "Competitive PvP with high rates for faster action.",
    tags: ["PvP", "Boosted", "5–25×"],
    gameUserSettings: { ...GAME_MODES[1].gameUserSettings, ...PRESET_STYLES[2].gameUserSettings },
    gameIni: {},
  },
  // Custom
  {
    id: "guided_custom",
    displayName: "Guided Custom",
    description: "User-configured rates built with the guided wizard.",
    tags: ["Custom", "Guided"],
    gameUserSettings: {},
    gameIni: {},
  },
  {
    id: "full_custom",
    displayName: "Full Custom",
    description: "Fully user-defined INI configuration.",
    tags: ["Custom", "Advanced"],
    gameUserSettings: {},
    gameIni: {},
  },
  // Legacy IDs (mapped for old servers stored in DB before this version)
  {
    id: "vanilla",
    displayName: "PvE — Official",
    description: "Cooperative play at official WildCard rates.",
    tags: ["PvE", "Official Rates"],
    gameUserSettings: { ...GAME_MODES[0].gameUserSettings, ...PRESET_STYLES[0].gameUserSettings },
    gameIni: {},
  },
  {
    id: "pvp",
    displayName: "PvP — Casual",
    description: "Competitive PvP with slightly boosted rates.",
    tags: ["PvP", "Casual"],
    gameUserSettings: { ...GAME_MODES[1].gameUserSettings, ...PRESET_STYLES[1].gameUserSettings },
    gameIni: {},
  },
  {
    id: "pve",
    displayName: "PvE — Casual",
    description: "Cooperative play with slightly boosted rates.",
    tags: ["PvE", "Casual"],
    gameUserSettings: { ...GAME_MODES[0].gameUserSettings, ...PRESET_STYLES[1].gameUserSettings },
    gameIni: {},
  },
  {
    id: "boosted",
    displayName: "PvE — Boosted",
    description: "Cooperative play with very high rates.",
    tags: ["PvE", "Boosted"],
    gameUserSettings: { ...GAME_MODES[0].gameUserSettings, ...PRESET_STYLES[2].gameUserSettings },
    gameIni: {},
  },
  {
    id: "custom",
    displayName: "Custom",
    description: "Fully user-defined configuration.",
    tags: ["Custom"],
    gameUserSettings: {},
    gameIni: {},
  },
];

/** Look up a preset by its ID. Returns undefined if not found. */
export function getPresetById(id: string): ServerPreset | undefined {
  return SERVER_PRESETS.find((p) => p.id === id);
}

/**
 * Merge a preset's overrides onto the vanilla defaults to produce the full
 * GameUserSettings config that will be written to disk.
 */
export function applyPreset(presetId: string): GameUserSettingsConfig {
  const preset = getPresetById(presetId);
  return {
    ...DEFAULT_GAME_USER_SETTINGS,
    ...(preset?.gameUserSettings ?? {}),
  };
}

// ---------------------------------------------------------------------------
// INI Field Groups — used by the Config Tab and Full INI Editor
// ---------------------------------------------------------------------------

export interface IniFieldDef {
  section: "gus" | "game";
  iniSection: string;
  key: string;
  label: string;
  type: "string" | "number" | "boolean";
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: number;
  description?: string;
}

export interface IniFieldGroup {
  id: string;
  title: string;
  fields: IniFieldDef[];
}

export const INI_FIELD_GROUPS: IniFieldGroup[] = [
  {
    id: "session",
    title: "Session",
    fields: [
      { section: "gus", iniSection: "SessionSettings", key: "SessionName", label: "Server Name", type: "string", placeholder: "My ASA Server", description: "The name shown in the server browser." },
      // MaxPlayers lives in [/Script/Engine.GameSession] in ASA's GameUserSettings.ini
      { section: "gus", iniSection: "/Script/Engine.GameSession", key: "MaxPlayers", label: "Max Players", type: "number", min: 1, max: 200, defaultValue: 70, description: "Maximum concurrent players allowed." },
      { section: "gus", iniSection: "SessionSettings", key: "ServerPassword", label: "Join Password", type: "string", placeholder: "(no password)", description: "Players must enter this to join. Leave empty for public." },
    ],
  },
  {
    id: "admin",
    title: "Admin & RCON",
    fields: [
      { section: "gus", iniSection: "ServerSettings", key: "ServerAdminPassword", label: "Admin Password", type: "string", placeholder: "required", description: "Password for in-game admin commands and RCON." },
      { section: "gus", iniSection: "ServerSettings", key: "RCONEnabled", label: "RCON Enabled", type: "boolean", description: "Enable the RCON remote console interface." },
      { section: "gus", iniSection: "ServerSettings", key: "RCONPort", label: "RCON Port", type: "number", min: 1024, max: 65535, defaultValue: 27020, description: "TCP port the RCON server listens on." },
      { section: "gus", iniSection: "ServerSettings", key: "AdminLogging", label: "Admin Logging", type: "boolean", description: "Log all admin commands to in-game chat (visible to admins only)." },
    ],
  },
  {
    id: "rates",
    title: "Rates",
    fields: [
      { section: "gus", iniSection: "ServerSettings", key: "OverrideOfficialDifficulty", label: "Wild Dino Max Level", type: "number", min: 0.1, max: 20, step: 0.5, defaultValue: 5.0, description: "Directly sets difficulty. Value × 30 = max wild dino level (5.0 = level 150). Overrides Difficulty Offset when set." },
      { section: "gus", iniSection: "ServerSettings", key: "DifficultyOffset", label: "Difficulty Offset", type: "number", min: 0, max: 1, step: 0.05, defaultValue: 1.0, description: "Fallback difficulty scale (0–1). Ignored when Override Official Difficulty is set." },
      { section: "gus", iniSection: "ServerSettings", key: "XPMultiplier", label: "XP Multiplier", type: "number", min: 0, max: 100, step: 0.1, defaultValue: 1.0, description: "Global XP gain multiplier." },
      { section: "gus", iniSection: "ServerSettings", key: "TamingSpeedMultiplier", label: "Taming Speed", type: "number", min: 0, max: 100, step: 0.1, defaultValue: 1.0, description: "How fast taming effectiveness increases." },
      { section: "gus", iniSection: "ServerSettings", key: "HarvestAmountMultiplier", label: "Harvest Amount", type: "number", min: 0, max: 100, step: 0.1, defaultValue: 1.0, description: "Resource yield per harvest." },
      { section: "gus", iniSection: "ServerSettings", key: "ResourcesRespawnPeriodMultiplier", label: "Resource Respawn", type: "number", min: 0.01, max: 10, step: 0.05, defaultValue: 1.0, description: "Lower = faster respawn. 0.5 = twice as fast." },
    ],
  },
  {
    id: "breeding",
    title: "Taming & Breeding",
    fields: [
      { section: "gus", iniSection: "ServerSettings", key: "MatingIntervalMultiplier", label: "Mating Interval", type: "number", min: 0.01, max: 10, step: 0.05, defaultValue: 1.0, description: "Lower = dinos can mate more often." },
      { section: "gus", iniSection: "ServerSettings", key: "EggHatchSpeedMultiplier", label: "Egg Hatch Speed", type: "number", min: 0, max: 100, step: 0.5, defaultValue: 1.0, description: "Higher = eggs hatch faster." },
      { section: "gus", iniSection: "ServerSettings", key: "BabyMatureSpeedMultiplier", label: "Baby Mature Speed", type: "number", min: 0, max: 100, step: 0.5, defaultValue: 1.0, description: "Higher = babies grow up faster." },
      { section: "gus", iniSection: "ServerSettings", key: "BabyCuddleIntervalMultiplier", label: "Imprint Interval", type: "number", min: 0.01, max: 10, step: 0.05, defaultValue: 1.0, description: "Lower = imprinting cuddles required less often." },
      { section: "gus", iniSection: "ServerSettings", key: "BabyImprintingStatScaleMultiplier", label: "Imprint Stat Scale", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0, description: "Multiplier on imprinting stat bonuses." },
      { section: "gus", iniSection: "ServerSettings", key: "BabyImprintAmountMultiplier", label: "Imprint Amount", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0, description: "Higher = each cuddle gives more imprint %." },
      { section: "gus", iniSection: "ServerSettings", key: "AllowAnyoneBabyImprintCuddle", label: "Anyone Can Imprint", type: "boolean", description: "Allow any player (not just the imprinter) to cuddle babies." },
    ],
  },
  {
    id: "player_dino",
    title: "Player & Dino Tuning",
    fields: [
      { section: "gus", iniSection: "ServerSettings", key: "PlayerDamageMultiplier", label: "Player Damage", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0, description: "Damage dealt by players." },
      { section: "gus", iniSection: "ServerSettings", key: "PlayerResistanceMultiplier", label: "Player Resistance", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0, description: "Damage received by players (lower = tankier)." },
      { section: "gus", iniSection: "ServerSettings", key: "DinoDamageMultiplier", label: "Dino Damage", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0, description: "Damage dealt by dinos." },
      { section: "gus", iniSection: "ServerSettings", key: "DinoResistanceMultiplier", label: "Dino Resistance", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0, description: "Damage received by dinos (lower = tankier)." },
      { section: "gus", iniSection: "ServerSettings", key: "PlayerCharacterFoodDrainMultiplier", label: "Food Drain", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
      { section: "gus", iniSection: "ServerSettings", key: "PlayerCharacterWaterDrainMultiplier", label: "Water Drain", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
      { section: "gus", iniSection: "ServerSettings", key: "PlayerCharacterStaminaDrainMultiplier", label: "Stamina Drain", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
      { section: "gus", iniSection: "ServerSettings", key: "PlayerCharacterHealthRecoveryMultiplier", label: "Player Health Regen", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
      { section: "gus", iniSection: "ServerSettings", key: "DinoCharacterFoodDrainMultiplier", label: "Dino Food Drain", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
      { section: "gus", iniSection: "ServerSettings", key: "DinoCharacterStaminaDrainMultiplier", label: "Dino Stamina Drain", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
      { section: "gus", iniSection: "ServerSettings", key: "DinoCharacterHealthRecoveryMultiplier", label: "Dino Health Regen", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
    ],
  },
  {
    id: "pvp_pve",
    title: "PvP / PvE Settings",
    fields: [
      { section: "gus", iniSection: "ServerSettings", key: "AllowPvP", label: "Allow PvP", type: "boolean", description: "Enable player-vs-player combat." },
      { section: "gus", iniSection: "ServerSettings", key: "EnablePvPGamma", label: "PvP Gamma", type: "boolean", description: "Allow gamma adjustment in PvP (gives night vision advantage)." },
      { section: "gus", iniSection: "ServerSettings", key: "PreventOfflinePvP", label: "Offline Raid Protection", type: "boolean", description: "Protect structures/tames when the owner tribe is offline." },
      { section: "gus", iniSection: "ServerSettings", key: "PreventOfflinePvPInterval", label: "ORP Grace Period (s)", type: "number", min: 0, max: 86400, step: 60, defaultValue: 900, description: "Seconds after last tribe member logs off before protection kicks in." },
      { section: "gus", iniSection: "ServerSettings", key: "AllowCaveBuildingPvE", label: "Cave Building (PvE)", type: "boolean", description: "Allow structure placement inside caves in PvE mode." },
      { section: "gus", iniSection: "ServerSettings", key: "AllowCaveBuildingPvP", label: "Cave Building (PvP)", type: "boolean", description: "Allow structure placement inside caves in PvP mode." },
      { section: "gus", iniSection: "ServerSettings", key: "AllowFlyerCarryPvE", label: "Flyer Carry (PvE)", type: "boolean", description: "Allow flyers to pick up wild dinos and players in PvE." },
      { section: "gus", iniSection: "ServerSettings", key: "AllowMultipleAttachedC4", label: "Multiple C4 on Tames", type: "boolean", description: "Allow attaching multiple C4 charges to a single tame." },
      { section: "gus", iniSection: "ServerSettings", key: "AllowRaidDinoFeeding", label: "Titanosaur Feeding", type: "boolean", description: "Allow players to feed Titanosaurs to keep them tamed." },
    ],
  },
  {
    id: "tribe",
    title: "Tribes & Structures",
    fields: [
      { section: "gus", iniSection: "ServerSettings", key: "MaxNumberOfPlayersInTribe", label: "Max Tribe Size", type: "number", min: 0, max: 200, defaultValue: 0, description: "0 = unlimited." },
      { section: "gus", iniSection: "ServerSettings", key: "TribeNameChangeCooldown", label: "Tribe Rename Cooldown (min)", type: "number", min: 0, max: 1440, defaultValue: 15 },
      { section: "gus", iniSection: "ServerSettings", key: "StructureDamageMultiplier", label: "Structure Damage", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
      { section: "gus", iniSection: "ServerSettings", key: "StructureResistanceMultiplier", label: "Structure Resistance", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0, description: "Lower = structures take more damage." },
      { section: "gus", iniSection: "ServerSettings", key: "PvEStructureDecayDestructionPeriod", label: "PvE Decay Period (days)", type: "number", min: 0, max: 90, defaultValue: 0, description: "0 = disabled. Days before abandoned structures are destroyed." },
      { section: "gus", iniSection: "ServerSettings", key: "PvEStructureDecayPeriodMultiplier", label: "PvE Decay Multiplier", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
      { section: "gus", iniSection: "ServerSettings", key: "AutoDestroyOldStructuresMultiplier", label: "Auto-Destroy Old Structures", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 0, description: "0 = disabled. Higher = faster auto-destruction of old structures." },
    ],
  },
  {
    id: "world",
    title: "World & Time",
    fields: [
      { section: "gus", iniSection: "ServerSettings", key: "DayCycleSpeedScale", label: "Day Cycle Speed", type: "number", min: 0.1, max: 10, step: 0.1, defaultValue: 1.0, description: "Overall day/night cycle speed." },
      { section: "gus", iniSection: "ServerSettings", key: "DayTimeSpeedScale", label: "Daytime Speed", type: "number", min: 0.1, max: 10, step: 0.1, defaultValue: 1.0 },
      { section: "gus", iniSection: "ServerSettings", key: "NightTimeSpeedScale", label: "Nighttime Speed", type: "number", min: 0.1, max: 10, step: 0.1, defaultValue: 1.0, description: "Higher = nights pass faster." },
      { section: "gus", iniSection: "ServerSettings", key: "GlobalSpoilingTimeMultiplier", label: "Spoiling Time", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0, description: "Higher = food/items spoil slower." },
      { section: "gus", iniSection: "ServerSettings", key: "GlobalItemDecompositionTimeMultiplier", label: "Item Decay Time", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
      { section: "gus", iniSection: "ServerSettings", key: "GlobalCorpseDecompositionTimeMultiplier", label: "Corpse Decay Time", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
      { section: "gus", iniSection: "ServerSettings", key: "AutoSavePeriodMinutes", label: "Auto-Save Interval (min)", type: "number", min: 0, max: 120, defaultValue: 15, description: "How often the server saves to disk. Set to 0 to disable ARK's auto-save and manage saves manually via RCON." },
    ],
  },
  {
    id: "misc",
    title: "Misc Settings",
    fields: [
      { section: "gus", iniSection: "ServerSettings", key: "ServerCrosshair", label: "Server Crosshair", type: "boolean" },
      { section: "gus", iniSection: "ServerSettings", key: "ShowFloatingDamageText", label: "Show Damage Numbers", type: "boolean", description: "Show floating damage numbers above targets." },
      { section: "gus", iniSection: "ServerSettings", key: "ShowMapPlayerLocation", label: "Show Player Location", type: "boolean", description: "Show each player's location on the map." },
      { section: "gus", iniSection: "ServerSettings", key: "AllowThirdPersonPlayer", label: "Third Person Camera", type: "boolean" },
      { section: "gus", iniSection: "ServerSettings", key: "AlwaysNotifyPlayerJoined", label: "Notify Player Joined", type: "boolean" },
      { section: "gus", iniSection: "ServerSettings", key: "AlwaysNotifyPlayerLeft", label: "Notify Player Left", type: "boolean" },
      { section: "gus", iniSection: "ServerSettings", key: "GlobalVoiceChat", label: "Global Voice Chat", type: "boolean" },
      { section: "gus", iniSection: "ServerSettings", key: "ProximityChat", label: "Proximity Chat Only", type: "boolean" },
      { section: "gus", iniSection: "ServerSettings", key: "AllowHitMarkers", label: "Hit Markers", type: "boolean" },
      { section: "gus", iniSection: "ServerSettings", key: "ClampItemStats", label: "Clamp Item Stats", type: "boolean", description: "Prevent items from having stats above official limits." },
      { section: "gus", iniSection: "ServerSettings", key: "DisableWeatherFog", label: "Disable Weather Fog", type: "boolean", description: "Disables foggy weather across all maps." },
      { section: "gus", iniSection: "ServerSettings", key: "AllowFlyingStaminaRecovery", label: "Flying Stamina Recovery", type: "boolean", description: "Flyers passively recover stamina while a rider stands on them mid-flight." },
      { section: "gus", iniSection: "ServerSettings", key: "MaxTamedDinos", label: "Max Tamed Dinos (Server)", type: "number", min: 0, max: 50000, step: 100, defaultValue: 5000, description: "Total tamed dino cap across all tribes. 0 = unlimited." },
      { section: "gus", iniSection: "ServerSettings", key: "MaxPersonalTamedDinos", label: "Max Tamed Dinos (Per Tribe)", type: "number", min: 0, max: 5000, step: 50, defaultValue: 0, description: "Per-tribe tamed dino cap. 0 = use server default." },
      { section: "gus", iniSection: "ServerSettings", key: "NPCNetworkStasisRangeScalePlayerCountStart", label: "Stasis Scale: Player Count Start", type: "number", min: 1, max: 200, defaultValue: 24, description: "Player count at which NPC stasis range begins to shrink." },
      { section: "gus", iniSection: "ServerSettings", key: "NPCNetworkStasisRangeScalePlayerCountEnd", label: "Stasis Scale: Player Count End", type: "number", min: 1, max: 200, defaultValue: 70, description: "Player count at which stasis range reaches its minimum." },
      { section: "gus", iniSection: "ServerSettings", key: "NPCNetworkStasisRangeScalePercentEnd", label: "Stasis Scale: Percent End", type: "number", min: 0, max: 1, step: 0.05, defaultValue: 0.5, description: "Minimum stasis range as a fraction of the default (0.5 = 50% at max players)." },
    ],
  },
  // ── Breeding (extended) ────────────────────────────────────────────────────
  {
    id: "breeding_extended",
    title: "Breeding (Extended)",
    fields: [
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "BabyFoodConsumptionSpeedMultiplier", label: "Baby Food Drain", type: "number", min: 0.01, max: 10, step: 0.05, defaultValue: 1.0, description: "Lower value = babies eat less frequently. Must reduce when using high BabyMatureSpeedMultiplier to prevent starvation." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "BabyCuddleGracePeriodMultiplier", label: "Imprint Grace Period", type: "number", min: 0.01, max: 10, step: 0.1, defaultValue: 1.0, description: "Extends the grace window before imprint quality drops if a cuddle is missed. Higher = more forgiving." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "BabyCuddleLoseImprintQualitySpeedMultiplier", label: "Imprint Quality Loss Speed", type: "number", min: 0.01, max: 10, step: 0.1, defaultValue: 1.0, description: "Higher = imprint quality drops faster if cuddles are missed. Lower = more forgiving." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "MatingSpeedMultiplier", label: "Mating Speed", type: "number", min: 0.1, max: 10, step: 0.1, defaultValue: 1.0, description: "How fast the mating bar fills when dinos are near each other." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "LayEggIntervalMultiplier", label: "Egg Lay Interval", type: "number", min: 0.01, max: 10, step: 0.1, defaultValue: 1.0, description: "Lower = dinos lay unfertilized eggs more often." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "PassiveTameIntervalMultiplier", label: "Passive Tame Interval", type: "number", min: 0.01, max: 10, step: 0.1, defaultValue: 1.0, description: "Lower = passive tames (like Moschops) accept food more frequently." },
    ],
  },
  // ── Player & Dino (extended) ───────────────────────────────────────────────
  {
    id: "player_dino_extended",
    title: "Player & Dino (Extended)",
    fields: [
      { section: "gus", iniSection: "ServerSettings", key: "TamedDinoDamageMultiplier", label: "Tamed Dino Damage", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
      { section: "gus", iniSection: "ServerSettings", key: "TamedDinoResistanceMultiplier", label: "Tamed Dino Resistance", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0, description: "Lower = tamed dinos take more damage." },
      { section: "gus", iniSection: "ServerSettings", key: "HarvestHealthMultiplier", label: "Resource Health", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0, description: "Higher = resources take more hits to deplete. Combine with Harvest Amount for best feel." },
      { section: "gus", iniSection: "ServerSettings", key: "FuelConsumptionIntervalMultiplier", label: "Fuel Consumption Interval", type: "number", min: 0.01, max: 10, step: 0.1, defaultValue: 1.0, description: "Higher = generators and campfires consume fuel less frequently." },
      { section: "gus", iniSection: "ServerSettings", key: "FishingLootQualityMultiplier", label: "Fishing Loot Quality", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
      { section: "gus", iniSection: "ServerSettings", key: "SupplyCrateLootQualityMultiplier", label: "Supply Crate Loot Quality", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
      { section: "gus", iniSection: "ServerSettings", key: "UseCorpseLifeSpanMultiplier", label: "Corpse Lifespan", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0, description: "Higher = death bags and wild corpses persist longer." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "DinoHarvestingDamageMultiplier", label: "Dino Harvesting Damage", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0, description: "Damage dinos deal to harvestable resources." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "PlayerHarvestingDamageMultiplier", label: "Player Harvesting Damage", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0, description: "Damage players deal to harvestable resources." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "TamedDinoCharacterFoodDrainMultiplier", label: "Tamed Dino Food Drain", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "TamedDinoTorporDrainMultiplier", label: "Tamed Dino Torpor Drain", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "WildDinoCharacterFoodDrainMultiplier", label: "Wild Dino Food Drain", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "WildDinoTorporDrainMultiplier", label: "Wild Dino Torpor Drain", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "MaxFallSpeedMultiplier", label: "Max Fall Speed", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0, description: "Higher = players/dinos survive higher falls before taking damage." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "PoopIntervalMultiplier", label: "Poop Interval", type: "number", min: 0.01, max: 10, step: 0.1, defaultValue: 1.0, description: "Lower = creatures poop more often." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "HairGrowthSpeedMultiplier", label: "Hair Growth Speed", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "GlobalCorpseDecompositionTimeMultiplier", label: "Corpse Decomposition Time", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "CraftingSkillBonusMultiplier", label: "Crafting Skill Bonus", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0, description: "Scales bonus from Crafting Skill stat when crafting items." },
    ],
  },
  // ── XP Multipliers ────────────────────────────────────────────────────────
  {
    id: "xp_multipliers",
    title: "XP Multipliers",
    fields: [
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "GenericXPMultiplier", label: "Generic XP", type: "number", min: 0, max: 100, step: 0.1, defaultValue: 1.0, description: "Scales XP from generic actions not covered by the other categories." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "KillXPMultiplier", label: "Kill XP", type: "number", min: 0, max: 100, step: 0.1, defaultValue: 1.0 },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "HarvestXPMultiplier", label: "Harvest XP", type: "number", min: 0, max: 100, step: 0.1, defaultValue: 1.0 },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "CraftXPMultiplier", label: "Craft XP", type: "number", min: 0, max: 100, step: 0.1, defaultValue: 1.0 },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "SpecialXPMultiplier", label: "Special XP", type: "number", min: 0, max: 100, step: 0.1, defaultValue: 1.0, description: "XP from quests and special events." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "OverrideMaxExperiencePointsPlayer", label: "Player Max XP Override", type: "number", min: 0, max: 1000000, step: 1000, defaultValue: 0, description: "Override the max XP a player can earn. 0 = use default level cap." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "OverrideMaxExperiencePointsDino", label: "Dino Max XP Override", type: "number", min: 0, max: 1000000, step: 1000, defaultValue: 0, description: "Override the max XP a dino can earn. 0 = use default." },
    ],
  },
  // ── PvP Settings (Game.ini) ────────────────────────────────────────────────
  {
    id: "pvp_gameini",
    title: "PvP (Advanced)",
    fields: [
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bIncreasePvPRespawnInterval", label: "Increase Respawn on Repeat Deaths", type: "boolean", description: "Adds a respawn time penalty when the same player is killed repeatedly in a short window." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "IncreasePvPRespawnIntervalBaseAmount", label: "Respawn Penalty (seconds)", type: "number", min: 0, max: 600, step: 5, defaultValue: 60.0, description: "Base seconds added to respawn per repeat kill event." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "IncreasePvPRespawnIntervalCheckPeriod", label: "Respawn Penalty Window (seconds)", type: "number", min: 0, max: 3600, step: 30, defaultValue: 300.0, description: "Time window in which repeat kills count toward the penalty." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "IncreasePvPRespawnIntervalMultiplier", label: "Respawn Penalty Multiplier", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 2.0 },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "PvPZoneStructureDamageMultiplier", label: "PvP Zone Structure Damage", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 6.0, description: "Damage multiplier for structures inside PvP zones." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "StructureDamageRepairCooldown", label: "Structure Repair Cooldown (seconds)", type: "number", min: 0, max: 300, step: 5, defaultValue: 180, description: "Seconds a structure cannot be repaired after taking damage." },
    ],
  },
  // ── PvE Settings (Game.ini) ────────────────────────────────────────────────
  {
    id: "pve_gameini",
    title: "PvE (Game.ini)",
    fields: [
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bDisableFriendlyFire", label: "Disable Friendly Fire", type: "boolean", description: "Required for PvE — prevents players and tamed dinos from damaging allies." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bPvEDisableFriendlyFire", label: "Disable Friendly Fire (PvE Context)", type: "boolean", description: "Companion to Disable Friendly Fire for PvE-specific code paths. Enable both for full PvE." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bPvEAllowTribeWar", label: "Allow Tribe Wars in PvE", type: "boolean", description: "Allows tribes in PvE to mutually declare war, enabling temporary PvP between them." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bPvEAllowTribeWarCancel", label: "Allow Tribe War Cancellation", type: "boolean", description: "Allows tribes to cancel a declared war before it begins." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bAutoPvETimer", label: "Auto PvE Timer", type: "boolean", description: "Enables automatic scheduled PvP→PvE switching based on time of day." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bAutoPvEUseSystemTime", label: "Auto PvE Use System Time", type: "boolean", description: "When true, the Auto PvE timer uses the server's local wall-clock time. When false, uses in-game day/night time." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "AutoPvEStartTimeSeconds", label: "Auto PvE Start (seconds)", type: "number", min: 0, max: 86400, step: 900, defaultValue: 0, description: "Time of day (in seconds) when PvE mode begins." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "AutoPvEStopTimeSeconds", label: "Auto PvE Stop (seconds)", type: "number", min: 0, max: 86400, step: 900, defaultValue: 0, description: "Time of day (in seconds) when PvE mode ends (PvP resumes)." },
    ],
  },
  // ── Leveling & Respecs ────────────────────────────────────────────────────
  {
    id: "leveling",
    title: "Leveling & Respecs",
    fields: [
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bAllowUnlimitedRespecs", label: "Unlimited Respecs", type: "boolean", description: "Removes the 24-hour cooldown on Mindwipe Tonic. Players can respec freely." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bAllowFlyerSpeedLeveling", label: "Flyer Speed Leveling", type: "boolean", description: "Allow flyers to have their speed stat leveled up." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bAllowSpeedLeveling", label: "Creature Speed Leveling", type: "boolean", description: "Allow all creatures (not just flyers) to level movement speed." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bUseSingleplayerSettings", label: "Use Singleplayer Settings", type: "boolean", description: "Applies singleplayer difficulty and stat scaling to a multiplayer server." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bShowCreativeMode", label: "Show Creative Mode", type: "boolean", description: "Enables Creative Mode in the inventory screen." },
    ],
  },
  // ── Engrams ───────────────────────────────────────────────────────────────
  {
    id: "engrams",
    title: "Engrams",
    fields: [
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bAutoUnlockAllEngrams", label: "Auto Unlock All Engrams", type: "boolean", description: "All engrams are automatically unlocked for all players. Players still need the required level." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bOnlyAllowSpecifiedEngrams", label: "Only Allow Specified Engrams", type: "boolean", description: "Only engrams listed in EngramEntryAutoUnlocks are available. All others are hidden." },
    ],
  },
  // ── Custom Recipes ────────────────────────────────────────────────────────
  {
    id: "custom_recipes",
    title: "Custom Recipes",
    fields: [
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bAllowCustomRecipes", label: "Allow Custom Recipes", type: "boolean", description: "Enables the custom recipe system — players can create named food/consumable recipes." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "CustomRecipeEffectivenessMultiplier", label: "Recipe Effectiveness", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0, description: "Scales the stat bonuses provided by custom recipes." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "CustomRecipeSkillMultiplier", label: "Recipe Skill Bonus", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0, description: "Scales how much Crafting Skill affects custom recipe output quality." },
    ],
  },
  // ── Platform Saddles ──────────────────────────────────────────────────────
  {
    id: "platform_saddles",
    title: "Platform Saddles",
    fields: [
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bAllowPlatformSaddleMultiFloors", label: "Platform Saddle Multi-Floor", type: "boolean", description: "Allows building multiple stacked floors on platform saddles." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bFlyerPlatformAllowUnalignedDinoBasing", label: "Flyer Platform Unaligned Dino Basing", type: "boolean", description: "Allows dinos to stand on flyer platform saddles regardless of alignment." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bIgnoreStructuresPreventionVolumes", label: "Ignore Build Prevention Volumes", type: "boolean", description: "Allows building in areas that would otherwise block structures (e.g., artifact caves, obelisk platforms)." },
    ],
  },
  // ── Dino Control ─────────────────────────────────────────────────────────
  {
    id: "dino_control",
    title: "Dino Control",
    fields: [
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bDisableDinoTaming", label: "Disable Taming", type: "boolean", description: "Prevents all dino taming." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bDisableDinoBreeding", label: "Disable Breeding", type: "boolean", description: "Prevents all dino breeding and egg hatching." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bDisableDinoRiding", label: "Disable Riding", type: "boolean", description: "Prevents players from riding tamed dinos." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bAllowUnclaimDinos", label: "Allow Unclaim Dinos", type: "boolean", description: "Allows tribe members to unclaim (release ownership of) their tamed dinos." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bUseTameLimitForStructuresOnly", label: "Tame Limit for Structures Only", type: "boolean", description: "When true, the tame cap only applies to dinos used as structure foundations (rafts etc.) — not general tames." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bUseDinoLevelUpAnimations", label: "Dino Level Up Animations", type: "boolean", description: "Shows the level-up visual effect when a tamed dino gains a level." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "DestroyTamesOverLevelClamp", label: "Destroy Tames Over Level Cap", type: "number", min: 0, max: 9999, defaultValue: 0, description: "Destroys tamed dinos over this level on server start. 0 = disabled. Used to enforce max-level caps set via OverrideMaxExperiencePointsDino." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bPassiveDefensesDamageRiderlessDinos", label: "Passive Defenses Damage Riderless Dinos", type: "boolean", description: "Plant species X and other passive defenses deal damage to tamed dinos that have no rider." },
    ],
  },
  // ── Resource Management ───────────────────────────────────────────────────
  {
    id: "resources",
    title: "Resource Management",
    fields: [
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "ResourceNoReplenishRadiusPlayers", label: "Resource Exclusion Radius (Players)", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0, description: "Multiplier on the radius around players where resources don't respawn." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "ResourceNoReplenishRadiusStructures", label: "Resource Exclusion Radius (Structures)", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0, description: "Multiplier on the radius around structures where resources don't respawn." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "LimitNonPlayerDroppedItemsCount", label: "Max Non-Player Dropped Items", type: "number", min: 0, max: 5000, step: 50, defaultValue: 0, description: "Max number of dropped items (from dino kills etc.) within the range below. 0 = disabled." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "LimitNonPlayerDroppedItemsRange", label: "Non-Player Item Limit Range", type: "number", min: 0, max: 10000, step: 100, defaultValue: 0, description: "Radius (unreal units) checked for the non-player item limit above." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "GlobalPoweredBatteryDurabilityDecreasePerSecond", label: "Battery Drain Rate", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 3.0, description: "Durability lost per second for powered batteries." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bDisableLootCrates", label: "Disable Supply Drops", type: "boolean", description: "Prevents supply drops (orbital supply drops / beacons) from spawning." },
    ],
  },
  // ── Turret & Defense Limits ───────────────────────────────────────────────
  {
    id: "turrets",
    title: "Turret & Defense Limits",
    fields: [
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bLimitTurretsInRange", label: "Enable Turret Limit", type: "boolean", description: "Enables the turret count limit per radius. Recommended on all servers to prevent performance degradation." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bHardLimitTurretsInRange", label: "Hard Turret Limit", type: "boolean", description: "When true, prevents placing turrets that would exceed the limit. When false, only issues a warning." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "LimitTurretsNum", label: "Turret Limit (count)", type: "number", min: 1, max: 1000, step: 10, defaultValue: 100, description: "Maximum turrets allowed within the radius below." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "LimitTurretsRange", label: "Turret Limit Radius (units)", type: "number", min: 1000, max: 100000, step: 1000, defaultValue: 10000, description: "Radius (unreal units) checked for the turret limit. 10000 ≈ the default official range." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "DinoTurretDamageMultiplier", label: "Dino Turret Damage", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0, description: "Scales the damage that auto-turrets deal to dinos." },
    ],
  },
  // ── Tribe Settings ────────────────────────────────────────────────────────
  {
    id: "tribe_extended",
    title: "Tribe (Extended)",
    fields: [
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "MaxAlliancesPerTribe", label: "Max Alliances Per Tribe", type: "number", min: 0, max: 100, defaultValue: 10, description: "Maximum number of alliances a tribe can belong to. 0 = unlimited." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "MaxTribesPerAlliance", label: "Max Tribes Per Alliance", type: "number", min: 0, max: 100, defaultValue: 10, description: "Maximum number of tribes in a single alliance. 0 = unlimited." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "MaxNumberOfPlayersInTribe", label: "Max Players Per Tribe", type: "number", min: 0, max: 200, defaultValue: 0, description: "Maximum players allowed in a single tribe. 0 = unlimited." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "MaxTribeLogs", label: "Max Tribe Log Entries", type: "number", min: 100, max: 10000, step: 100, defaultValue: 500, description: "How many entries to keep in the tribe log." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "TribeSlotReuseCooldown", label: "Tribe Slot Reuse Cooldown (seconds)", type: "number", min: 0, max: 86400, step: 600, defaultValue: 0, description: "Cooldown before a vacated tribe slot can be filled by a new member." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "FastDecayInterval", label: "Fast Decay Interval (seconds)", type: "number", min: 0, max: 86400, step: 3600, defaultValue: 43200, description: "How quickly solo/pillar structures decay when the fast decay option is enabled in game settings." },
    ],
  },
  // ── Decay & Cleanup ───────────────────────────────────────────────────────
  {
    id: "decay",
    title: "Decay & Cleanup",
    fields: [
      { section: "gus", iniSection: "ServerSettings", key: "DisableStructureDecayPvE", label: "Disable Structure Decay (PvE)", type: "boolean", description: "Structures never decay in PvE mode. Removes maintenance pressure for casual servers." },
      { section: "gus", iniSection: "ServerSettings", key: "DisableDinoDecayPvE", label: "Disable Dino Decay (PvE)", type: "boolean", description: "Tamed dinos never become unclaim-eligible in PvE. Prevents accidental loss." },
      { section: "gus", iniSection: "ServerSettings", key: "OnlyAutoDestroyCoreStructures", label: "Only Auto-Destroy Core Structures", type: "boolean", description: "Only lone foundations and pillars decay on their own. Walls and ceilings connected to a decaying foundation collapse when it does." },
      { section: "gus", iniSection: "ServerSettings", key: "AutoDestroyDecayedDinos", label: "Auto-Destroy Decayed Dinos", type: "boolean", description: "Decayed tames are automatically removed when the server loads, instead of sitting as claimable dinos." },
      { section: "gus", iniSection: "ServerSettings", key: "AutoDestroyOldStructuresMultiplier", label: "Auto-Destroy Old Structures Rate", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 0, description: "0 = disabled. Higher values = faster auto-destruction of old abandoned structures." },
      { section: "gus", iniSection: "ServerSettings", key: "PvEStructureDecayDestructionPeriod", label: "PvE Decay Period (days)", type: "number", min: 0, max: 90, defaultValue: 0, description: "0 = use server default. Days before abandoned structures decay in PvE." },
      { section: "gus", iniSection: "ServerSettings", key: "PvEStructureDecayPeriodMultiplier", label: "PvE Decay Period Multiplier", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
    ],
  },
  // ── Structure Pickup & Locking ────────────────────────────────────────────
  {
    id: "structure_pickup",
    title: "Structure Pickup & Locking",
    fields: [
      { section: "gus", iniSection: "ServerSettings", key: "ForceAllStructureLocking", label: "Force All Structures Locked", type: "boolean", description: "All newly placed structures default to locked. Players must manually unlock." },
      { section: "gus", iniSection: "ServerSettings", key: "AlwaysAllowStructurePickup", label: "Always Allow Structure Pickup", type: "boolean", description: "Remove the 30-second pickup timer. Structures can be picked up at any time." },
      { section: "gus", iniSection: "ServerSettings", key: "PvEAllowStructuresAtSupplyDrops", label: "Build Near Supply Drops (PvE)", type: "boolean", description: "Allow structures to be placed near orbital supply drops in PvE." },
      { section: "gus", iniSection: "ServerSettings", key: "AllowCrateSpawnsOnTopOfStructures", label: "Supply Drops Land on Structures", type: "boolean", description: "Supply drops will land on top of structures instead of being blocked by them." },
      { section: "gus", iniSection: "ServerSettings", key: "bDisableStructurePlacementCollision", label: "Disable Structure Placement Collision", type: "boolean", description: "Allows structures to be placed overlapping other structures or terrain (creative-mode building)." },
    ],
  },
  // ── Download / Upload / Cluster Transfer ─────────────────────────────────
  {
    id: "transfers",
    title: "Download / Upload / Cluster Transfer",
    fields: [
      { section: "gus", iniSection: "ServerSettings", key: "NoTributeDownloads", label: "No Tribute Downloads", type: "boolean", description: "Prevents downloading characters, dinos, and items from the Obelisk/Terminal tribute system." },
      { section: "gus", iniSection: "ServerSettings", key: "PreventDownloadSurvivors", label: "Prevent Download: Survivors", type: "boolean", description: "Prevents players from downloading survivor data from other servers." },
      { section: "gus", iniSection: "ServerSettings", key: "PreventDownloadDinos", label: "Prevent Download: Dinos", type: "boolean", description: "Prevents downloading tamed dinos from other servers." },
      { section: "gus", iniSection: "ServerSettings", key: "PreventDownloadItems", label: "Prevent Download: Items", type: "boolean", description: "Prevents downloading items/inventory from other servers." },
      { section: "gus", iniSection: "ServerSettings", key: "PreventUploadSurvivors", label: "Prevent Upload: Survivors", type: "boolean", description: "Prevents uploading your survivor to the Obelisk for cross-server transfer." },
      { section: "gus", iniSection: "ServerSettings", key: "PreventUploadDinos", label: "Prevent Upload: Dinos", type: "boolean", description: "Prevents uploading tamed dinos to the Obelisk." },
      { section: "gus", iniSection: "ServerSettings", key: "PreventUploadItems", label: "Prevent Upload: Items", type: "boolean", description: "Prevents uploading items to the Obelisk." },
      { section: "gus", iniSection: "ServerSettings", key: "MaxTributeDinos", label: "Max Tribute Dinos", type: "number", min: 0, max: 200, defaultValue: 20, description: "Maximum dinos that can be held in Obelisk tribute storage simultaneously." },
      { section: "gus", iniSection: "ServerSettings", key: "MaxTributeItems", label: "Max Tribute Items", type: "number", min: 0, max: 1000, defaultValue: 50, description: "Maximum items that can be held in Obelisk tribute storage simultaneously." },
      { section: "gus", iniSection: "ServerSettings", key: "TributeItemExpirationSeconds", label: "Tribute Item Expiry (seconds)", type: "number", min: 0, max: 2592000, step: 3600, defaultValue: 86400, description: "How long items remain in Obelisk storage before expiring. Default: 86400 (24 hours)." },
      { section: "gus", iniSection: "ServerSettings", key: "TributeCharacterExpirationSeconds", label: "Tribute Character Expiry (seconds)", type: "number", min: 0, max: 2592000, step: 3600, defaultValue: 86400, description: "How long uploaded survivor data stays in Obelisk storage." },
      { section: "gus", iniSection: "ServerSettings", key: "TributeDinoExpirationSeconds", label: "Tribute Dino Expiry (seconds)", type: "number", min: 0, max: 2592000, step: 3600, defaultValue: 86400, description: "How long uploaded dinos stay in Obelisk storage." },
    ],
  },
  // ── Cryopod ───────────────────────────────────────────────────────────────
  {
    id: "cryopod",
    title: "Cryopod",
    fields: [
      { section: "gus", iniSection: "ServerSettings", key: "EnableCryopodNerf", label: "Enable Cryopod Nerf", type: "boolean", description: "Applies a temporary damage debuff to dinos released from a cryopod. Prevents cryopod spam tactics in PvP." },
      { section: "gus", iniSection: "ServerSettings", key: "CryopodNerfDuration", label: "Nerf Duration (seconds)", type: "number", min: 0, max: 3600, step: 10, defaultValue: 10.0, description: "How long the cryopod damage debuff lasts after a dino is released." },
      { section: "gus", iniSection: "ServerSettings", key: "CryopodNerfDamagePct", label: "Nerf Damage Percent", type: "number", min: 0, max: 1, step: 0.05, defaultValue: 0.01, description: "Damage reduction applied during the nerf (0.01 = 99% less damage; 1.0 = no reduction)." },
      { section: "gus", iniSection: "ServerSettings", key: "CryopodNerfIncomingDamageMultiplierMax", label: "Nerf Incoming Damage Cap", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0, description: "Cap on incoming damage to the just-released dino during the nerf window." },
    ],
  },
  // ── Chat & Admin ──────────────────────────────────────────────────────────
  {
    id: "chat_admin",
    title: "Chat & Admin",
    fields: [
      { section: "gus", iniSection: "ServerSettings", key: "ChatFloodPunishmentDuration", label: "Chat Flood Punishment (seconds)", type: "number", min: 0, max: 3600, step: 10, defaultValue: 0, description: "Mutes a player for this many seconds if they spam chat. 0 = disabled." },
      { section: "gus", iniSection: "ServerSettings", key: "BanListURL", label: "Ban List URL", type: "string", placeholder: "http://arkdedicated.com/banlist.txt", description: "URL to a remote ban list. The server fetches and enforces this list on connect. Use WildCard's official URL or host your own." },
      { section: "gus", iniSection: "ServerSettings", key: "AdminLogging", label: "Admin Logging", type: "boolean", description: "Log all admin commands to in-game chat (visible to admins only)." },
    ],
  },
  // ── Message of the Day ────────────────────────────────────────────────────
  {
    id: "motd",
    title: "Message of the Day",
    fields: [
      { section: "gus", iniSection: "MessageOfTheDay", key: "Message", label: "MOTD Message", type: "string", placeholder: "Welcome to the server!", description: "Shown to players in a pop-up when they join. Use \\n for line breaks." },
      { section: "gus", iniSection: "MessageOfTheDay", key: "Duration", label: "MOTD Display Time (seconds)", type: "number", min: 1, max: 120, defaultValue: 20, description: "How long the MOTD pop-up is displayed before auto-closing." },
    ],
  },
  // ── Ragnarok ─────────────────────────────────────────────────────────────
  {
    id: "ragnarok",
    title: "Ragnarok",
    fields: [
      { section: "gus", iniSection: "Ragnarok", key: "AllowMultipleTamedUnicorns", label: "Multiple Tamed Unicorns", type: "boolean", description: "Allows more than one tamed Unicorn per server. By default only one wild Unicorn spawns at a time." },
      { section: "gus", iniSection: "Ragnarok", key: "UnicornSpawnInterval", label: "Unicorn Respawn Interval (hours)", type: "number", min: 1, max: 720, defaultValue: 24, description: "Hours between Unicorn respawns on Ragnarok." },
      { section: "gus", iniSection: "Ragnarok", key: "BossSpawnInterval", label: "Boss Spawn Interval (hours)", type: "number", min: 1, max: 720, defaultValue: 24, description: "Hours between Dragon/Manticore boss arena event spawns on Ragnarok." },
    ],
  },
  // ── Lost Colony (Genesis 2) ───────────────────────────────────────────────
  {
    id: "lost_colony",
    title: "Lost Colony (Genesis 2)",
    fields: [
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bDisableDefaultMapItemSets", label: "Disable Default TEK Suit Spawn", type: "boolean", description: "Disables the TEK suit that players spawn with on Lost Colony. Recommended for vanilla-feeling servers." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bDisableWorldBuffs", label: "Disable World Buffs", type: "boolean", description: "Disables the world effect buffs granted by Lost Colony missions entirely." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bEnableWorldBuffScaling", label: "Enable World Buff Scaling", type: "boolean", description: "When true, Lost Colony world effects scale from server settings rather than applying flat values." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "WorldBuffScalingEfficacy", label: "World Buff Scaling Efficacy", type: "number", min: 0, max: 5, step: 0.1, defaultValue: 1.0, description: "How effective world buff scaling is (0.5 = 50% less effective; 2.0 = double). Only active when World Buff Scaling is enabled." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "AdjustableMutagenSpawnDelayMultiplier", label: "Mutagen Respawn Delay", type: "number", min: 0.01, max: 10, step: 0.1, defaultValue: 1.0, description: "Scales the Mutagen respawn interval. Default is every 8 hours. Also affects Aberration. Lower = more frequent." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "BaseHexagonRewardMultiplier", label: "Hexagon Reward Multiplier", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0, description: "Scales the base Hexagon reward from Lost Colony missions." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bDisableHexagonStore", label: "Disable Hexagon Store", type: "boolean", description: "Disables the Hexagon store on Lost Colony entirely." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "HexagonCostMultiplier", label: "Hexagon Cost Multiplier", type: "number", min: 0, max: 10, step: 0.1, defaultValue: 1.0, description: "Scales the Hexagon cost of all items in the store." },
      { section: "game", iniSection: "/script/shootergame.shootergamemode", key: "bHexStoreAllowOnlyEngramTradeOption", label: "Hexagon Store: Engrams Only", type: "boolean", description: "Restricts the Hexagon store to only engram purchases — disables all other item types." },
    ],
  },
];

// ---------------------------------------------------------------------------
// Launch Parameters (CLI-only flags — cannot be set via INI)
// ---------------------------------------------------------------------------

export type LaunchParamType = "boolean" | "number" | "string";
export type LaunchParamCategory =
  | "network"
  | "gameplay"
  | "admin"
  | "performance"
  | "cluster"
  | "access";

export interface LaunchParameter {
  key: string;
  flag: string;
  type: LaunchParamType;
  defaultValue: boolean | number | string;
  description: string;
  category: LaunchParamCategory;
}

/**
 * Launch parameters that MUST be passed on the command line (no INI equivalent).
 * Server name, ports, passwords, and rates all go in GameUserSettings.ini.
 */
export const LAUNCH_PARAMETERS: LaunchParameter[] = [
  // Performance / anti-cheat
  // Anti-cheat
  {
    key: "NoBattlEye",
    flag: "-NoBattlEye",
    type: "boolean",
    defaultValue: true,
    description: "Disable BattlEye anti-cheat. Recommended for private/community servers.",
    category: "performance",
  },
  {
    key: "UseBattlEye",
    flag: "-UseBattlEye",
    type: "boolean",
    defaultValue: false,
    description: "Enable BattlEye anti-cheat. Players must also have it enabled to join.",
    category: "performance",
  },
  // Performance
  {
    key: "lowmemory",
    flag: "-lowmemory",
    type: "boolean",
    defaultValue: false,
    description: "Enable low-memory mode. Reduces RAM usage — useful on 4–8 GB systems but lowers quality.",
    category: "performance",
  },
  {
    key: "nosteamclient",
    flag: "-nosteamclient",
    type: "boolean",
    defaultValue: false,
    description: "Start without Steam client integration (LAN / offline mode).",
    category: "performance",
  },
  {
    key: "culture",
    flag: "-culture=",
    type: "string",
    defaultValue: "",
    description: "Server locale / language code (e.g. en, de, fr). Leave blank for default.",
    category: "performance",
  },
  // Admin / logging
  {
    key: "UseServerNetSpeedCheck",
    flag: "-UseServerNetSpeedCheck",
    type: "boolean",
    defaultValue: false,
    description: "Enable server-side network speed checks to detect speed-hacking clients.",
    category: "admin",
  },
  {
    key: "servergamelog",
    flag: "-servergamelog",
    type: "boolean",
    defaultValue: false,
    description: "Enable server-side game log file (logs kills, tames, admin commands).",
    category: "admin",
  },
  {
    key: "ServerRCONOutputTribeLogs",
    flag: "-ServerRCONOutputTribeLogs",
    type: "boolean",
    defaultValue: false,
    description: "Output tribe log events to the RCON connection.",
    category: "admin",
  },
  {
    key: "NotifyAdminCommandsInChat",
    flag: "-NotifyAdminCommandsInChat",
    type: "boolean",
    defaultValue: false,
    description: "Broadcast admin commands to all players in chat.",
    category: "admin",
  },
  // Gameplay
  {
    key: "ForceRespawnDinos",
    flag: "-ForceRespawnDinos",
    type: "boolean",
    defaultValue: false,
    description: "Destroy all wild dinos on startup and force a fresh spawn.",
    category: "gameplay",
  },
  {
    key: "NoDinos",
    flag: "-NoDinos",
    type: "boolean",
    defaultValue: false,
    description: "Prevent wild dinos from spawning entirely.",
    category: "gameplay",
  },
  {
    key: "ActiveEvent",
    flag: "-ActiveEvent=",
    type: "string",
    defaultValue: "",
    description: "Enable a seasonal event (e.g. Summer, Winter, Easter, Eggcellent, FearEvolved). Leave blank for none.",
    category: "gameplay",
  },
  // Access control
  {
    key: "crossplay",
    flag: "-crossplay",
    type: "boolean",
    defaultValue: false,
    description: "Enable crossplay — allows Xbox, PlayStation, and PC players to join the same server.",
    category: "access",
  },
  {
    key: "epiconly",
    flag: "-epiconly",
    type: "boolean",
    defaultValue: false,
    description: "Restrict server to Epic Games Store players only.",
    category: "access",
  },
  {
    key: "exclusivejoin",
    flag: "-exclusivejoin",
    type: "boolean",
    defaultValue: false,
    description: "Whitelist-only mode — only players on the server whitelist can join.",
    category: "access",
  },
  // Cluster
  {
    key: "ClusterID",
    flag: "-clusterid=",
    type: "string",
    defaultValue: "",
    description: "Cluster identifier. Servers sharing the same ID allow cross-ARK travel.",
    category: "cluster",
  },
  {
    key: "ClusterDirOverride",
    flag: "-ClusterDirOverride=",
    type: "string",
    defaultValue: "",
    description: "Absolute path to the shared cluster data directory.",
    category: "cluster",
  },
  {
    key: "NoTransferFromFiltering",
    flag: "-NoTransferFromFiltering",
    type: "boolean",
    defaultValue: false,
    description: "Prevent character/dino/item uploads from servers outside this cluster.",
    category: "cluster",
  },
];

/** Return all launch parameters for a specific category. */
export function getLaunchParamsByCategory(
  category: LaunchParamCategory
): LaunchParameter[] {
  return LAUNCH_PARAMETERS.filter((p) => p.category === category);
}

// ---------------------------------------------------------------------------
// Notification Events
// ---------------------------------------------------------------------------

export const NOTIFICATION_EVENTS = {
  SERVER_STARTED: "server_started",
  SERVER_STOPPED: "server_stopped",
  SERVER_CRASHED: "server_crashed",
  SERVER_START_FAILED: "server_start_failed",
  SERVER_UPDATED: "server_updated",
  UPDATE_AVAILABLE: "update_available",
  UPDATE_STARTED: "update_started",
  UPDATE_FAILED: "update_failed",
  BACKUP_COMPLETED: "backup_completed",
  BACKUP_FAILED: "backup_failed",
  SCHEDULED_RESTART: "scheduled_restart",
  RCON_FAILED: "rcon_failed",
  MOD_INSTALLED: "mod_installed",
  LOW_DISK_SPACE: "low_disk_space",
  SERVER_INSTALL_COMPLETE: "server_install_complete",
  SERVER_INSTALL_FAILED: "server_install_failed",
} as const;

export type NotificationEventType =
  (typeof NOTIFICATION_EVENTS)[keyof typeof NOTIFICATION_EVENTS];

export const NOTIFICATION_EVENT_LABELS: Record<NotificationEventType, string> = {
  server_started:          "Server Started",
  server_stopped:          "Server Stopped",
  server_crashed:          "Server Crashed",
  server_start_failed:     "Server Failed to Start",
  server_updated:          "Server Updated",
  update_available:        "Update Available",
  update_started:          "Update Started",
  update_failed:           "Update Failed",
  backup_completed:        "Backup Completed",
  backup_failed:           "Backup Failed",
  scheduled_restart:       "Scheduled Restart",
  rcon_failed:             "RCON Connection Failed",
  mod_installed:           "Mod Installed",
  low_disk_space:          "Low Disk Space",
  server_install_complete: "Server Install Complete",
  server_install_failed:   "Server Install Failed",
};

// ---------------------------------------------------------------------------
// Server Status
// ---------------------------------------------------------------------------

export const SERVER_STATUS = {
  STOPPED: "stopped",
  STARTING: "starting",
  RUNNING: "running",
  STOPPING: "stopping",
  UPDATING: "updating",
  BACKING_UP: "backing_up",
  ERROR: "error",
} as const;

export type ServerStatus = (typeof SERVER_STATUS)[keyof typeof SERVER_STATUS];

export const SERVER_STATUS_COLORS: Record<ServerStatus, string> = {
  stopped:   "text-muted-foreground border-muted",
  starting:  "text-neon-cyan border-neon-cyan animate-pulse",
  running:   "text-neon-green border-neon-green",
  stopping:  "text-neon-cyan border-neon-cyan animate-pulse",
  updating:  "text-neon-purple border-neon-purple animate-pulse",
  backing_up:"text-neon-purple border-neon-purple animate-pulse",
  error:     "text-neon-red border-neon-red",
};

// ---------------------------------------------------------------------------
// Schedule Types
// ---------------------------------------------------------------------------

export const SCHEDULE_TYPES = {
  BACKUP:    "backup",
  UPDATE:    "update",
  RESTART:   "restart",
  BROADCAST: "broadcast",
} as const;

export type ScheduleType = (typeof SCHEDULE_TYPES)[keyof typeof SCHEDULE_TYPES];

export const SCHEDULE_TYPE_LABELS: Record<ScheduleType, string> = {
  backup:    "Auto-Backup",
  update:    "Auto-Update",
  restart:   "Auto-Restart",
  broadcast: "Scheduled Broadcast",
};

// ---------------------------------------------------------------------------
// Common cron presets for the CronBuilder UI component
// ---------------------------------------------------------------------------

export interface CronPreset {
  label: string;
  expression: string;
  description: string;
}

export const CRON_PRESETS: CronPreset[] = [
  { label: "Every hour",           expression: "0 * * * *",    description: "Runs at the top of every hour." },
  { label: "Every 2 hours",        expression: "0 */2 * * *",  description: "Runs every 2 hours." },
  { label: "Every 4 hours",        expression: "0 */4 * * *",  description: "Runs every 4 hours." },
  { label: "Every 6 hours",        expression: "0 */6 * * *",  description: "Runs every 6 hours." },
  { label: "Every 12 hours",       expression: "0 */12 * * *", description: "Runs twice a day." },
  { label: "Daily at 3 AM",        expression: "0 3 * * *",    description: "Runs once a day at 3:00 AM." },
  { label: "Daily at 6 AM",        expression: "0 6 * * *",    description: "Runs once a day at 6:00 AM." },
  { label: "Weekly (Sunday 3 AM)", expression: "0 3 * * 0",    description: "Runs every Sunday at 3:00 AM." },
  { label: "Custom",               expression: "",              description: "Enter a custom cron expression." },
];
