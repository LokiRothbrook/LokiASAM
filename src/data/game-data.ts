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
   * (e.g. `ArkAscendedServer.exe TheIsland_WP?SessionName=...`).
   */
  mapPath: string;
  /** True if this is an official WildCard / Studio Wildcard map. */
  isOfficial: boolean;
  /** True if the player needs to own a paid DLC to access this map. */
  dlcRequired: boolean;
  /** Name of the DLC (if dlcRequired is true). */
  dlcName?: string;
  /** Whether this map is currently released in ASA (false = announced/upcoming). */
  released: boolean;
}

/**
 * All ASA maps. To add a new map, append an entry here — no other file needs editing.
 * Maps marked `released: false` are shown in the UI as "Coming Soon" and cannot be
 * selected during server creation.
 */
export const ARK_MAPS: ArkMap[] = [
  {
    id: "theisland",
    displayName: "The Island",
    mapPath: "TheIsland_WP",
    isOfficial: true,
    dlcRequired: false,
    released: true,
  },
  {
    id: "scorched",
    displayName: "Scorched Earth",
    mapPath: "ScorchedEarth_WP",
    isOfficial: true,
    dlcRequired: true,
    dlcName: "Scorched Earth",
    released: true,
  },
  {
    id: "aberration",
    displayName: "Aberration",
    mapPath: "Aberration_WP",
    isOfficial: true,
    dlcRequired: true,
    dlcName: "Aberration",
    released: true,
  },
  {
    id: "thecenter",
    displayName: "The Center",
    mapPath: "TheCenter_WP",
    isOfficial: true,
    dlcRequired: false,
    released: true,
  },
  {
    id: "extinction",
    displayName: "Extinction",
    mapPath: "Extinction_WP",
    isOfficial: true,
    dlcRequired: true,
    dlcName: "Extinction",
    released: true,
  },
  {
    id: "genesis1",
    displayName: "Genesis: Part 1",
    mapPath: "Genesis_WP",
    isOfficial: true,
    dlcRequired: true,
    dlcName: "Genesis: Part 1",
    released: false,
  },
  {
    id: "genesis2",
    displayName: "Genesis: Part 2",
    mapPath: "Gen2_WP",
    isOfficial: true,
    dlcRequired: true,
    dlcName: "Genesis: Part 2",
    released: false,
  },
  {
    id: "lostisland",
    displayName: "Lost Island",
    mapPath: "LostIsland_WP",
    isOfficial: true,
    dlcRequired: false,
    released: false,
  },
  {
    id: "fjordur",
    displayName: "Fjordur",
    mapPath: "Fjordur_WP",
    isOfficial: true,
    dlcRequired: false,
    released: false,
  },
  {
    id: "crystalisles",
    displayName: "Crystal Isles",
    mapPath: "CrystalIsles_WP",
    isOfficial: true,
    dlcRequired: false,
    released: false,
  },
];

/** Returns only maps that are currently released and selectable. */
export function getReleasedMaps(): ArkMap[] {
  return ARK_MAPS.filter((m) => m.released);
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
 * of GameUserSettings.ini. Only the fields managed by LokiASAM are listed here.
 * Keys match the exact INI key names used by ASA.
 */
export interface GameUserSettingsConfig {
  // [SessionSettings]
  SessionName: string;
  ServerPassword: string;
  ServerAdminPassword: string;
  MaxPlayers: number;
  QueryPort: number;
  Port: number;

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
  AllowFlyerCarryPvE: boolean;
  DisablePvEGoodBerryGlobalSpoilingTime: boolean;
  PreventOfflinePvP: boolean;
  PreventOfflinePvPInterval: number;

  // [ServerSettings] — admin / RCON
  RCONEnabled: boolean;
  RCONPort: number;
  ServerCrosshair: boolean;
  ShowMapPlayerLocation: boolean;
  EnablePvPGamma: boolean;
  AdminLogging: boolean;

  // [ServerSettings] — tribe / structure
  MaxNumberOfPlayersInTribe: number;
  TribeNameChangeCooldown: number;
  StructureDamageMultiplier: number;
  StructureResistanceMultiplier: number;
  PvEStructureDecayDestructionPeriod: number;
  PvEStructureDecayPeriodMultiplier: number;

  // [ServerSettings] — misc
  NightTimeSpeedScale: number;
  DayTimeSpeedScale: number;
  DayCycleSpeedScale: number;
  GlobalSpoilingTimeMultiplier: number;
  GlobalItemDecompositionTimeMultiplier: number;
  GlobalCorpseDecompositionTimeMultiplier: number;
}

// ---------------------------------------------------------------------------
// Game.ini typed config
// ---------------------------------------------------------------------------

/**
 * Typed representation of the [/script/shootergame.shootergamemode] section
 * of Game.ini. Only the fields managed by LokiASAM are listed here.
 */
export interface GameIniConfig {
  // Engrams
  bOnlyAllowSpecifiedEngrams: boolean;
  OverrideEngramEntries: string[];

  // Supply drops
  ConfigOverrideSupplyCrateItems: string[];

  // Stat clamps
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
  AllowFlyerCarryPvE: false,
  DisablePvEGoodBerryGlobalSpoilingTime: false,
  PreventOfflinePvP: false,
  PreventOfflinePvPInterval: 900,
  RCONEnabled: true,
  RCONPort: 27020,
  ServerCrosshair: true,
  ShowMapPlayerLocation: false,
  EnablePvPGamma: false,
  AdminLogging: false,
  MaxNumberOfPlayersInTribe: 0,
  TribeNameChangeCooldown: 15,
  StructureDamageMultiplier: 1.0,
  StructureResistanceMultiplier: 1.0,
  PvEStructureDecayDestructionPeriod: 0,
  PvEStructureDecayPeriodMultiplier: 1.0,
  NightTimeSpeedScale: 1.0,
  DayTimeSpeedScale: 1.0,
  DayCycleSpeedScale: 1.0,
  GlobalSpoilingTimeMultiplier: 1.0,
  GlobalItemDecompositionTimeMultiplier: 1.0,
  GlobalCorpseDecompositionTimeMultiplier: 1.0,
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
// Server Presets
// ---------------------------------------------------------------------------

export interface ServerPreset {
  id: string;
  displayName: string;
  description: string;
  /** Short tags shown as badges on the preset card. */
  tags: string[];
  /** Overrides applied on top of DEFAULT_GAME_USER_SETTINGS. */
  gameUserSettings: Partial<GameUserSettingsConfig>;
  /** Overrides applied on top of DEFAULT_GAME_INI. */
  gameIni: Partial<GameIniConfig>;
}

/**
 * All server presets available in the creation wizard.
 * To add a preset: append here only. No wizard or form JSX needs editing.
 */
export const SERVER_PRESETS: ServerPreset[] = [
  {
    id: "vanilla",
    displayName: "Vanilla / Official",
    description:
      "Mirrors official WildCard server rates as closely as possible. Best for a hardcore, authentic ASA experience.",
    tags: ["Official Rates", "Hardcore", "PvE"],
    gameUserSettings: {
      AllowPvP: false,
      XPMultiplier: 1.0,
      TamingSpeedMultiplier: 1.0,
      HarvestAmountMultiplier: 1.0,
    },
    gameIni: {},
  },
  {
    id: "pvp",
    displayName: "PvP",
    description:
      "Competitive PvP settings with slightly boosted rates to keep the game moving. Offline raid protection enabled.",
    tags: ["PvP", "Competitive", "Boosted x2"],
    gameUserSettings: {
      AllowPvP: true,
      EnablePvPGamma: true,
      PreventOfflinePvP: true,
      PreventOfflinePvPInterval: 900,
      XPMultiplier: 2.0,
      TamingSpeedMultiplier: 3.0,
      HarvestAmountMultiplier: 2.0,
      MatingIntervalMultiplier: 0.5,
      EggHatchSpeedMultiplier: 5.0,
      BabyMatureSpeedMultiplier: 5.0,
    },
    gameIni: {},
  },
  {
    id: "pve",
    displayName: "PvE",
    description:
      "Cooperative PvE with boosted rates to make progression enjoyable for smaller tribes and solo players.",
    tags: ["PvE", "Cooperative", "Boosted x3"],
    gameUserSettings: {
      AllowPvP: false,
      AllowCaveBuildingPvE: true,
      AllowFlyerCarryPvE: true,
      XPMultiplier: 3.0,
      TamingSpeedMultiplier: 5.0,
      HarvestAmountMultiplier: 3.0,
      ResourcesRespawnPeriodMultiplier: 0.5,
      MatingIntervalMultiplier: 0.25,
      EggHatchSpeedMultiplier: 10.0,
      BabyMatureSpeedMultiplier: 10.0,
      BabyCuddleIntervalMultiplier: 0.5,
    },
    gameIni: {},
  },
  {
    id: "boosted",
    displayName: "Boosted / Casual",
    description:
      "Very high rates across the board for a relaxed, fast-paced experience. Great for small friend groups.",
    tags: ["Casual", "High Rates", "PvE"],
    gameUserSettings: {
      AllowPvP: false,
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
    },
    gameIni: {},
  },
  {
    id: "custom",
    displayName: "Custom",
    description:
      "Start from scratch. All settings are initialized to vanilla defaults. Configure everything yourself.",
    tags: ["Custom", "Manual"],
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
// Launch Parameters
// ---------------------------------------------------------------------------

export type LaunchParamType = "boolean" | "number" | "string";
export type LaunchParamCategory =
  | "network"
  | "gameplay"
  | "admin"
  | "performance"
  | "cluster";

export interface LaunchParameter {
  /** Unique key used as the DB field name and the INI/arg identifier. */
  key: string;
  /**
   * The CLI flag format. Use `?Key=` for query-string params
   * (appended to the map path) and `-Key` for standalone flags.
   */
  flag: string;
  type: LaunchParamType;
  defaultValue: boolean | number | string;
  description: string;
  category: LaunchParamCategory;
}

/**
 * All ASA dedicated server launch parameters managed by LokiASAM.
 * These are appended to the server executable command line.
 * Reference: https://ark.wiki.gg/wiki/Server_configuration (ASA section)
 */
export const LAUNCH_PARAMETERS: LaunchParameter[] = [
  // Network
  {
    key: "Port",
    flag: "?Port=",
    type: "number",
    defaultValue: 7777,
    description: "Game UDP port that clients connect to.",
    category: "network",
  },
  {
    key: "QueryPort",
    flag: "?QueryPort=",
    type: "number",
    defaultValue: 27015,
    description: "Steam query UDP port for server browser listings.",
    category: "network",
  },
  {
    key: "RCONEnabled",
    flag: "?RCONEnabled=",
    type: "boolean",
    defaultValue: true,
    description: "Enable the Source RCON interface for remote administration.",
    category: "admin",
  },
  {
    key: "RCONPort",
    flag: "?RCONPort=",
    type: "number",
    defaultValue: 27020,
    description: "TCP port the RCON server listens on.",
    category: "admin",
  },
  {
    key: "ServerPassword",
    flag: "?ServerPassword=",
    type: "string",
    defaultValue: "",
    description: "Password required for players to join. Leave empty for public.",
    category: "network",
  },
  {
    key: "ServerAdminPassword",
    flag: "?ServerAdminPassword=",
    type: "string",
    defaultValue: "",
    description:
      "Admin password used for in-game admin commands and RCON authentication.",
    category: "admin",
  },
  {
    key: "MaxPlayers",
    flag: "?MaxPlayers=",
    type: "number",
    defaultValue: 70,
    description: "Maximum number of concurrent players allowed.",
    category: "network",
  },

  // Gameplay
  {
    key: "AllowPvP",
    flag: "?bAllowPvP=",
    type: "boolean",
    defaultValue: false,
    description: "Enable player-vs-player damage.",
    category: "gameplay",
  },
  {
    key: "ForceNoHUD",
    flag: "-ForceNoHUD",
    type: "boolean",
    defaultValue: false,
    description: "Disable the HUD for all players (unusual, rarely needed).",
    category: "gameplay",
  },

  // Performance
  {
    key: "UseBattlEye",
    flag: "-UseBattlEye",
    type: "boolean",
    defaultValue: false,
    description: "Enable BattlEye anti-cheat. Requires players to also have it enabled.",
    category: "performance",
  },
  {
    key: "NoBattlEye",
    flag: "-NoBattlEye",
    type: "boolean",
    defaultValue: true,
    description: "Disable BattlEye anti-cheat (recommended for private servers).",
    category: "performance",
  },
  {
    key: "nosteamclient",
    flag: "-nosteamclient",
    type: "boolean",
    defaultValue: false,
    description: "Start without Steam client integration (LAN mode).",
    category: "performance",
  },
  {
    key: "culture",
    flag: "-culture=",
    type: "string",
    defaultValue: "en",
    description: "Server locale / language code (e.g. en, de, fr).",
    category: "performance",
  },

  // Cluster
  {
    key: "ClusterID",
    flag: "?ClusterID=",
    type: "string",
    defaultValue: "",
    description:
      "Cluster identifier. Servers sharing the same ClusterID allow cross-ARK travel.",
    category: "cluster",
  },
  {
    key: "ClusterDirOverride",
    flag: "?ClusterDirOverride=",
    type: "string",
    defaultValue: "",
    description:
      "Absolute path to the shared cluster data directory. Must be the same for all servers in the cluster.",
    category: "cluster",
  },
  {
    key: "NoTransferFromFiltering",
    flag: "?NoTransferFromFiltering",
    type: "boolean",
    defaultValue: false,
    description:
      "Block transfers of items/dinos/characters from servers not in this cluster.",
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

/**
 * All event types that LokiASAM can emit notifications for.
 * Used as keys in notification_configs.events_json and in_app_notifications.event_type.
 * To add a new event type: add it here — the notification config UI picks it up automatically.
 */
export const NOTIFICATION_EVENTS = {
  SERVER_STARTED: "server_started",
  SERVER_STOPPED: "server_stopped",
  SERVER_CRASHED: "server_crashed",
  SERVER_UPDATED: "server_updated",
  UPDATE_AVAILABLE: "update_available",
  BACKUP_COMPLETED: "backup_completed",
  BACKUP_FAILED: "backup_failed",
  PLAYER_JOINED: "player_joined",
  PLAYER_LEFT: "player_left",
  SCHEDULED_RESTART: "scheduled_restart",
  RCON_FAILED: "rcon_failed",
  MOD_INSTALLED: "mod_installed",
  LOW_DISK_SPACE: "low_disk_space",
} as const;

export type NotificationEventType =
  (typeof NOTIFICATION_EVENTS)[keyof typeof NOTIFICATION_EVENTS];

/** Human-readable labels for each notification event type. */
export const NOTIFICATION_EVENT_LABELS: Record<NotificationEventType, string> = {
  server_started: "Server Started",
  server_stopped: "Server Stopped",
  server_crashed: "Server Crashed",
  server_updated: "Server Updated",
  update_available: "Update Available",
  backup_completed: "Backup Completed",
  backup_failed: "Backup Failed",
  player_joined: "Player Joined",
  player_left: "Player Left",
  scheduled_restart: "Scheduled Restart",
  rcon_failed: "RCON Connection Failed",
  mod_installed: "Mod Installed",
  low_disk_space: "Low Disk Space",
};

// ---------------------------------------------------------------------------
// Server Status
// ---------------------------------------------------------------------------

/**
 * All possible runtime statuses for a managed server.
 * Stored in the `servers.status` column and emitted via Tauri events.
 */
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

/** Badge color class for each server status (maps to neon theme CSS variables). */
export const SERVER_STATUS_COLORS: Record<ServerStatus, string> = {
  stopped: "text-muted-foreground border-muted",
  starting: "text-neon-cyan border-neon-cyan animate-pulse",
  running: "text-neon-green border-neon-green",
  stopping: "text-neon-cyan border-neon-cyan animate-pulse",
  updating: "text-neon-purple border-neon-purple animate-pulse",
  backing_up: "text-neon-purple border-neon-purple animate-pulse",
  error: "text-neon-red border-neon-red",
};

// ---------------------------------------------------------------------------
// Schedule Types
// ---------------------------------------------------------------------------

/**
 * Types of automated schedules LokiASAM can run.
 * Used in the `schedules.schedule_type` column.
 */
export const SCHEDULE_TYPES = {
  BACKUP: "backup",
  UPDATE: "update",
  RESTART: "restart",
  BROADCAST: "broadcast",
} as const;

export type ScheduleType = (typeof SCHEDULE_TYPES)[keyof typeof SCHEDULE_TYPES];

export const SCHEDULE_TYPE_LABELS: Record<ScheduleType, string> = {
  backup: "Auto-Backup",
  update: "Auto-Update",
  restart: "Auto-Restart",
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
  { label: "Every hour", expression: "0 * * * *", description: "Runs at the top of every hour." },
  { label: "Every 2 hours", expression: "0 */2 * * *", description: "Runs every 2 hours." },
  { label: "Every 4 hours", expression: "0 */4 * * *", description: "Runs every 4 hours." },
  { label: "Every 6 hours", expression: "0 */6 * * *", description: "Runs every 6 hours." },
  { label: "Every 12 hours", expression: "0 */12 * * *", description: "Runs twice a day." },
  { label: "Daily at 3 AM", expression: "0 3 * * *", description: "Runs once a day at 3:00 AM." },
  { label: "Daily at 6 AM", expression: "0 6 * * *", description: "Runs once a day at 6:00 AM." },
  { label: "Weekly (Sunday 3 AM)", expression: "0 3 * * 0", description: "Runs every Sunday at 3:00 AM." },
  { label: "Custom", expression: "", description: "Enter a custom cron expression." },
];
