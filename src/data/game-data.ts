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
 *             Astraeos, Ragnarok, Valguero, Lost Colony, Genesis Part 1
 *   Upcoming: Genesis Part 2, Lost Island, Fjordur, Crystal Isles (2027+)
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
  {
    id: "genesis1",
    displayName: "Genesis: Part 1",
    mapPath: "Genesis_WP",
    isOfficial: true,
    dlcRequired: true,
    dlcName: "Genesis: Part 1",
    released: true,
    isMod: false,
  },

  // ── Official / Announced but Not Yet Released ─────────────────────────────
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
      TamingSpeedMultiplier: 3.0,
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
      { section: "gus", iniSection: "ServerSettings", key: "AutoSavePeriodMinutes", label: "Auto-Save Interval (min)", type: "number", min: 1, max: 120, defaultValue: 15, description: "How often the server saves to disk." },
    ],
  },
  {
    id: "misc",
    title: "Misc Settings",
    fields: [
      { section: "gus", iniSection: "ServerSettings", key: "ServerCrosshair", label: "Server Crosshair", type: "boolean" },
      { section: "gus", iniSection: "ServerSettings", key: "ShowMapPlayerLocation", label: "Show Player Location", type: "boolean", description: "Show each player's location on the map." },
      { section: "gus", iniSection: "ServerSettings", key: "AllowThirdPersonPlayer", label: "Third Person Camera", type: "boolean" },
      { section: "gus", iniSection: "ServerSettings", key: "AlwaysNotifyPlayerJoined", label: "Notify Player Joined", type: "boolean" },
      { section: "gus", iniSection: "ServerSettings", key: "AlwaysNotifyPlayerLeft", label: "Notify Player Left", type: "boolean" },
      { section: "gus", iniSection: "ServerSettings", key: "GlobalVoiceChat", label: "Global Voice Chat", type: "boolean" },
      { section: "gus", iniSection: "ServerSettings", key: "ProximityChat", label: "Proximity Chat Only", type: "boolean" },
      { section: "gus", iniSection: "ServerSettings", key: "AllowHitMarkers", label: "Hit Markers", type: "boolean" },
      { section: "gus", iniSection: "ServerSettings", key: "ClampItemStats", label: "Clamp Item Stats", type: "boolean", description: "Prevent items from having stats above official limits." },
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
