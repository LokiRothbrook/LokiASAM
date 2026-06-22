/**
 * tauri-commands.ts
 *
 * Typed wrappers around Tauri `invoke()` calls.
 * Every Rust command registered in lib.rs has a corresponding typed function here.
 * Import from this file in hooks and components — never call `invoke` directly.
 *
 * All commands gracefully throw when called outside Tauri (e.g. Next.js dev preview).
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";

/** Calls a Tauri command. Throws a descriptive error outside the desktop app. */
function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (
    typeof window === "undefined" ||
    !(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  ) {
    return Promise.reject(
      new Error(`Tauri command "${cmd}" is only available inside the desktop app.`)
    );
  }
  return tauriInvoke<T>(cmd, args);
}

// ---------------------------------------------------------------------------
// Types (mirror Rust structs — camelCase matches serde rename_all = "camelCase")
// ---------------------------------------------------------------------------

export interface PortConfig {
  port: number;
  queryPort: number;
  rconPort: number;
}

export interface PortDef {
  port: number;
  protocol: "tcp" | "udp";
}

export interface PortStatus {
  port: number;
  protocol: string;
  covered: boolean;
}

export interface FirewallStatus {
  /** "none" | "ufw" | "firewalld" | "iptables" | "nftables" | "windows" */
  firewallType: string;
  /** false = no active firewall detected; no action needed */
  active: boolean;
  ports: PortStatus[];
}

export interface ServerStatus {
  serverId: string;
  /** One of: stopped | starting | running | stopping | updating | error | crashed | start-failed */
  status: string;
  pid: number | null;
  uptimeSeconds: number | null;
  /** Populated for `start-failed` — last ~800 chars of stderr from the failed process. */
  error?: string;
}

/**
 * Full parameter set passed to `start_server`.
 * Passwords, RCON, MaxPlayers, and gameplay settings all live in
 * GameUserSettings.ini — they are NOT included here.
 */
export interface StartServerParams {
  serverId: string;
  /** Human-readable server name — used for log context only. */
  serverName: string;
  installPath: string;
  /** ASA map identifier, e.g. "TheIsland_WP". */
  mapPath: string;
  port: number;
  queryPort: number;
  /** NOT passed on CLI — used internally by Rust for RCON readiness polling. */
  rconPort: number;
  /** NOT passed on CLI — used internally by Rust for graceful shutdown (saveworld/doexit). */
  rconPassword: string;
  /** Additional CLI-only flags like ["-NoBattlEye", "-ForceRespawnDinos"]. */
  extraArgs: string[];
  /** CurseForge mod IDs to pass as -mods=id1,id2,... on startup. */
  modIds: string[];
  /** Linux only: path to the Proton-GE installation directory. */
  protonPath?: string;
  /** Linux only: path to the Steam compatibility prefix (WINEPREFIX). */
  prefixPath?: string;
  /** When set, appended as ?AltSaveDirectoryName= in the map query string so ASA saves to SavedArks/{name}. */
  altSaveDirectoryName?: string;
}

export interface ProtonEntry {
  path: string;
  version: string;
}

export interface ProtonUpdateInfo {
  latestVersion: string;
  currentVersion: string;
  updateAvailable: boolean;
  downloadUrl: string;
}

export interface ProcessStats {
  cpuPercent: number;
  memoryMb: number;
  pid: number;
}

export interface ServerQueryResult {
  name: string;
  map: string;
  players: number;
  maxPlayers: number;
  version: string;
}

export interface ArkPlayer {
  name: string;
  playerId: string;  // EOS ID in ASA (32-char alphanumeric)
}

export interface RconLogLine {
  timestampMs: number;
  text: string;
  kind: "command" | "response" | "chat" | "system" | "error";
}

export interface ArchivedLogInfo {
  filename: string;
  sizeBytes: number;
  timestamp: string;
  fullPath: string;
}

export interface CrashInfo {
  folderName: string;
  timestamp: string;
  hasCallStack: boolean;
  files: string[];
  fullPath: string;
}

export interface CrashFile {
  name: string;
  content: string;
}

export interface CrashReport {
  folderName: string;
  files: CrashFile[];
}

export interface OtherLogInfo {
  filename: string;
  sizeBytes: number;
  timestamp: string;
  fullPath: string;
}

export interface ChatLogInfo {
  filename: string;
  date: string;
  sizeBytes: number;
  fullPath: string;
}

/** Emitted on rcon://status/{id} and rcon://status-any when connection state changes. */
export interface RconStatusPayload {
  serverId: string;
  /** "connecting" | "connected" | "disconnected" */
  status: string;
  host?: string;
  port?: number;
  error?: string;
}

/**
 * Serialized INI configuration for a server.
 * `gameUserSettings` and `gameIni` are nested objects:
 *   { "[Section]": { "Key": "Value", ... } }
 * `launchArgs` is a flat key→value map of launch parameters.
 */
export interface ServerConfigJson {
  gameUserSettings: Record<string, Record<string, string>>;
  gameIni: Record<string, Record<string, string>>;
  launchArgs: Record<string, string>;
}

export interface BackupRecord {
  id: string;
  serverId: string;
  filePath: string;
  fileSizeBytes: number;
  mapId: string;
  triggeredBy: string;
  createdAt: string;
  /** server | player | full | ini */
  backupType: string;
  /** Comma-separated tier flags assigned by frontend: H, D, W, M */
  tiers: string;
  playerEosid: string | null;
  playerName: string | null;
}

export interface IniBackupRecord {
  id: string;
  serverId: string;
  folderPath: string;
  createdAt: string;
}

/** Result of comparing the shared cache against the Steam UpToDateCheck API. */
export interface UpdateCheckResult {
  updateAvailable: boolean;
  cachedBuildId: string;
  latestBuildId: string;
}

/** Fields pre-filled from an existing server installation's INI files. */
export interface DetectedServerConfig {
  exeFound: boolean;
  sessionName: string | null;
  port: number | null;
  queryPort: number | null;
  rconPort: number | null;
  adminPassword: string | null;
  serverPassword: string | null;
  maxPlayers: number | null;
  buildId: string | null;
}

export interface DiscordPayload {
  title: string;
  description: string;
  color: number;
  serverName: string;
  eventType: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  fromAddress: string;
  toAddress: string;
  useTls: boolean;
}

export interface EmailPayload {
  subject: string;
  body: string;
}

export interface DirCheckResult {
  writable: boolean;
  freeBytes: number;
  error: string | null;
  /** Target path does not exist yet and will be created on install. */
  isNew: boolean;
  /** A LokiASAM database was found inside the target path (existing install). */
  hasLokiasam: boolean;
  /** Target path exists but contains no files or subdirectories. */
  isEmpty: boolean;
}

export interface MigrateProgress {
  phase: string;
  message: string;
  percent: number;
}

/** One fully-hydrated schedule entry sent to Rust via sync_schedules. */
export interface ScheduleEntry {
  scheduleId: string;
  serverId: string;
  serverName: string;
  installPath: string;
  mapPath: string;
  mapId: string;
  port: number;
  queryPort: number;
  rconPort: number;
  rconPassword: string;
  extraArgs: string[];
  modIds: string[];
  protonPath?: string;
  prefixPath?: string;
  steamcmdPath: string;
  baseDir: string;
  backupDir: string;
  scheduleType: string;
  enabled: boolean;
  configJson: string;
  /** Unix timestamp in milliseconds (from cron-parser). */
  nextRunMs: number;
}

/** Payload emitted by `scheduler://fired` when an entry fires. */
export interface SchedulerFiredPayload {
  scheduleId: string;
  serverId: string;
  serverName: string;
  scheduleType: string;
  success: boolean;
  error?: string;
  /** All backup records created by this firing (player backups produce one per player). */
  backupRecords: BackupRecord[];
}

// ---------------------------------------------------------------------------
// Typed command wrappers — grouped by domain
// ---------------------------------------------------------------------------

export const tauriCmd = {
  // Server lifecycle
  /** Spawn the ASA server process. Returns the OS PID — persist it in SQLite. */
  startServer: (params: StartServerParams) =>
    invoke<number>("start_server", { params }),
  stopServer: (serverId: string, graceful: boolean) =>
    invoke<void>("stop_server", { serverId, graceful }),
  /** Restart with the same params. Returns the new PID. */
  restartServer: (params: StartServerParams, graceful: boolean) =>
    invoke<number>("restart_server", { params, graceful }),
  getServerStatus: (serverId: string) =>
    invoke<ServerStatus>("get_server_status", { serverId }),
  /** Scan for running ASA server processes by install path. Returns the live
   *  PID for each server found, or null if not running. */
  scanRunningServers: (servers: Array<{ serverId: string; installPath: string }>) =>
    invoke<Array<{ serverId: string; pid: number | null }>>("scan_running_servers", { servers }),
  /**
   * Copy server installation files from sourceInstallPath to destInstallPath.
   * ShooterGame/Saved is excluded so player data is not carried over.
   * All SQLite record creation is handled by the frontend.
   */
  cloneServer: (sourceInstallPath: string, destInstallPath: string) =>
    invoke<void>("clone_server", { sourceInstallPath, destInstallPath }),
  /** Delete server files and optional data from disk. DB record deletion is done separately via db.ts. */
  deleteServer: (
    serverId: string,
    installPath: string,
    backupDir: string,
    baseDir: string,
    saveFolderName: string,
    deleteFiles: boolean,
    deleteBackups: boolean,
    deleteLogs: boolean,
    deleteSaves: boolean,
  ) => invoke<void>("delete_server", { serverId, installPath, backupDir, baseDir, saveFolderName, deleteFiles, deleteBackups, deleteLogs, deleteSaves }),
  /** Return on-disk byte counts for a server's backups, logs, and save data. */
  getServerDiskUsage: (serverId: string, backupDir: string, baseDir: string, saveFolderName: string) =>
    invoke<{ backupBytes: number; logBytes: number; saveBytes: number }>("get_server_disk_usage", { serverId, backupDir, baseDir, saveFolderName }),

  // SteamCMD / installation
  /** Download and extract SteamCMD to targetDir. Streams to steamcmd://output/setup. */
  installSteamcmd: (targetDir: string) =>
    invoke<void>("install_steamcmd", { targetDir }),
  /** Run steamcmd +quit to verify the binary works. Streams to steamcmd://output/validate. */
  validateSteamcmd: (path: string) =>
    invoke<boolean>("validate_steamcmd", { path }),
  /**
   * Install the ASA server via a shared cache.
   * SteamCMD downloads into `cacheDir` first, then files are copied to `installPath`.
   * Re-running is safe — SteamCMD only downloads changed files, keeping installs fast.
   * @param cacheDir - Shared cache path, e.g. `{baseDir}/.cache/asa-server`.
   */
  installServer: (
    serverId: string,
    installPath: string,
    cacheDir: string,
    steamcmdPath: string,
  ) => invoke<void>("install_server", { serverId, installPath, cacheDir, steamcmdPath }),
  /**
   * Update the server via the shared cache, then sync to `installPath`.
   * ShooterGame/Saved (player data + configs) is never overwritten.
   * @param cacheDir - Shared cache path, e.g. `{baseDir}/.cache/asa-server`.
   */
  updateServer: (
    serverId: string,
    installPath: string,
    cacheDir: string,
    steamcmdPath: string,
  ) => invoke<void>("update_server", { serverId, installPath, cacheDir, steamcmdPath }),
  validateServerFiles: (
    serverId: string,
    installPath: string,
    cacheDir: string,
    steamcmdPath: string,
  ) => invoke<void>("validate_server_files", { serverId, installPath, cacheDir, steamcmdPath }),
  /**
   * Compare the shared cache build ID against the Steam UpToDateCheck API.
   * Lightweight — does NOT run SteamCMD.
   */
  checkAsaUpdate: (cacheDir: string) =>
    invoke<UpdateCheckResult>("check_asa_update", { cacheDir }),
  /** Read the build ID installed at a specific server path. Null if not installed. */
  getInstalledBuildId: (installPath: string) =>
    invoke<string | null>("get_installed_build_id", { installPath }),
  /**
   * Run SteamCMD to update the shared cache. Returns the new build ID.
   * Streams to steamcmd://output/{serverId}.
   */
  updateCache: (serverId: string, cacheDir: string, steamcmdPath: string) =>
    invoke<string>("update_cache", { serverId, cacheDir, steamcmdPath }),
  /**
   * Copy the shared cache to a specific server directory without running SteamCMD.
   * Preserves ShooterGame/Saved. Streams to steamcmd://output/{serverId}.
   */
  applyCacheToServer: (serverId: string, installPath: string, cacheDir: string) =>
    invoke<void>("apply_cache_to_server", { serverId, installPath, cacheDir }),
  /** Inspect an existing folder: checks for the server exe and parses INI files. */
  detectServerInstall: (installPath: string) =>
    invoke<DetectedServerConfig>("detect_server_install", { installPath }),
  /** Fetch game version for a build ID from the Steam News API and store it.
   *  Returns the version string (e.g. "49.23") or null if unavailable. */
  fetchBuildVersion: (buildId: string) =>
    invoke<string | null>("fetch_build_version", { buildId }),

  // RCON — connection
  rconConnect: (serverId: string, host: string, port: number, password: string) =>
    invoke<void>("rcon_connect", { serverId, host, port, password }),
  rconSend:        (serverId: string, command: string) => invoke<string>("rcon_send", { serverId, command }),
  rconDisconnect:  (serverId: string) => invoke<void>("rcon_disconnect", { serverId }),
  rconIsConnected: (serverId: string) => invoke<boolean>("rcon_is_connected", { serverId }),
  // RCON — players
  rconGetPlayers:       (serverId: string) => invoke<ArkPlayer[]>("rcon_get_players", { serverId }),
  /** null = no RCON connection established yet; [] = connected but 0 players online. */
  rconGetCachedPlayers: (serverId: string) => invoke<ArkPlayer[] | null>("rcon_get_cached_players", { serverId }),
  // RCON — log buffer
  rconGetLog:   (serverId: string) => invoke<RconLogLine[]>("rcon_get_log", { serverId }),
  rconClearLog: (serverId: string) => invoke<void>("rcon_clear_log", { serverId }),
  // RCON — file-based lists
  rconReadBanList:   (installPath: string) => invoke<string[]>("rcon_read_ban_list", { installPath }),
  rconReadWhitelist: (installPath: string) => invoke<string[]>("rcon_read_whitelist", { installPath }),
  // Graceful shutdown
  gracefulStopServer: (
    serverId: string,
    rconPort: number,
    rconPassword: string,
    warnPlayers: boolean,
    warnMinutes: number,
    warnMessage: string,
  ) => invoke<void>("graceful_stop_server", { serverId, rconPort, rconPassword, warnPlayers, warnMinutes, warnMessage }),

  // Graceful countdown restart / update
  startGracefulRestart: (params: {
    serverId: string;
    warnSeconds: number;
    rconPort: number;
    rconPassword: string;
    message: string;
    cancelMessage: string;
    startParams: StartServerParams;
  }) => invoke<void>("start_graceful_restart", { params }),

  startGracefulUpdate: (params: {
    serverId: string;
    serverName: string;
    warnSeconds: number;
    rconPort: number;
    rconPassword: string;
    message: string;
    cancelMessage: string;
    installPath: string;
    cacheDir: string;
    steamcmdPath: string;
    restartAfter: boolean;
    startParams: StartServerParams | null;
  }) => invoke<void>("start_graceful_update", { params }),

  cancelCountdown: (serverId: string) =>
    invoke<void>("cancel_countdown", { serverId }),

  proceedNow: (serverId: string) =>
    invoke<void>("proceed_now", { serverId }),

  // Log watcher
  watchServerLog: (serverId: string, logPath: string) =>
    invoke<void>("watch_server_log", { serverId, logPath }),
  stopLogWatch: (serverId: string) => invoke<void>("stop_log_watch", { serverId }),

  // Log archive
  listArchivedLogs: (serverId: string) =>
    invoke<ArchivedLogInfo[]>("list_archived_logs", { serverId }),
  readArchivedLog: (serverId: string, filename: string, offset: number, limit: number) =>
    invoke<string[]>("read_archived_log", { serverId, filename, offset, limit }),
  deleteArchivedLog: (serverId: string, filename: string) =>
    invoke<void>("delete_archived_log", { serverId, filename }),

  // Crash reports (stored in central LokiASAM logs folder)
  listCrashes: (serverId: string) =>
    invoke<CrashInfo[]>("list_crashes", { serverId }),
  readCrashReport: (serverId: string, folderName: string) =>
    invoke<CrashReport>("read_crash_report", { serverId, folderName }),
  deleteCrashReport: (serverId: string, folderName: string) =>
    invoke<void>("delete_crash_report", { serverId, folderName }),

  // Other server logs (secondary engine logs collected at startup)
  listOtherLogs: (serverId: string) =>
    invoke<OtherLogInfo[]>("list_other_logs", { serverId }),
  readOtherLog: (serverId: string, filename: string, offset: number, limit: number) =>
    invoke<string[]>("read_other_log", { serverId, filename, offset, limit }),

  // Chat logs
  listChatLogs: (serverId: string) =>
    invoke<ChatLogInfo[]>("list_chat_logs", { serverId }),
  readChatLog: (serverId: string, filename: string, offset: number, limit: number) =>
    invoke<string[]>("read_chat_log", { serverId, filename, offset, limit }),

  // Log maintenance
  cleanupLogs: (serverId: string, olderThanDays: number) =>
    invoke<number>("cleanup_logs", { serverId, olderThanDays }),
  getLogStorageRoot: () =>
    invoke<string>("get_log_storage_root"),

  // Config / INI
  /** Read GameUserSettings.ini and Game.ini from the server's install path. */
  readServerConfig: (installPath: string) =>
    invoke<ServerConfigJson>("read_server_config", { installPath }),
  /** Write config JSON back to GameUserSettings.ini and Game.ini on disk. */
  writeServerConfig: (installPath: string, config: ServerConfigJson) =>
    invoke<void>("write_server_config", { installPath, config }),
  /** Parse the user's existing INI files and return structured JSON. */
  importIniFiles: (gusPath: string, gameIniPath: string) =>
    invoke<ServerConfigJson>("import_ini_files", { gusPath, gameIniPath }),

  // Backups
  /** Server backup: SaveWorld → cleanup ARK files → 7z SavedArks+SaveGames. */
  createServerBackup: (
    serverId: string, serverName: string, installPath: string, mapPath: string,
    mapId: string, backupDir: string, triggeredBy: string, tier = "", saveFolderName?: string,
  ) => invoke<BackupRecord>("create_server_backup", { serverId, serverName, installPath, mapPath, mapId, backupDir, triggeredBy, tier, saveFolderName: saveFolderName ?? null }),

  /** Player backup: 7z a single .arkprofile file. */
  createPlayerBackup: (
    serverId: string, serverName: string, installPath: string, mapPath: string,
    mapId: string, backupDir: string, eosId: string, playerName: string, triggeredBy: string, tier = "",
  ) => invoke<BackupRecord>("create_player_backup", { serverId, serverName, installPath, mapPath, mapId, backupDir, eosId, playerName, triggeredBy, tier }),

  /** Back up every .arkprofile in SavedArks/{mapPath}/ in one call. */
  backupAllPlayers: (
    serverId: string, serverName: string, installPath: string, mapPath: string,
    mapId: string, backupDir: string, triggeredBy: string, saveFolderName?: string,
  ) => invoke<BackupRecord[]>("backup_all_players", { serverId, serverName, installPath, mapPath, mapId, backupDir, triggeredBy, saveFolderName: saveFolderName ?? null }),

  /** INI backup: copy loose INI files into a rotating timestamped folder. */
  createIniBackup: (serverId: string, installPath: string, backupDir: string) =>
    invoke<IniBackupRecord>("create_ini_backup", { serverId, installPath, backupDir }),
  /** Wipe server save files. tier: "map" | "players" | "full". Server must be stopped. */
  wipeServerSaves: (installPath: string, saveFolderName: string, tier: "map" | "players" | "full") =>
    invoke<void>("wipe_server_saves", { installPath, saveFolderName, tier }),
  /** Create a symlink (Linux) or NTFS junction point (Windows) from
   *  {installPath}/ShooterGame/Saved/SavedArks/{saveFolderName}
   *  → {baseDir}/Saves/{saveFolderName}/
   *  so -SaveDirectoryOverride writes saves to the managed Saves folder. */
  createSaveLink: (installPath: string, saveFolderName: string, baseDir: string) =>
    invoke<void>("create_save_link", { installPath, saveFolderName, baseDir }),

  /** Full backup: 7z the entire install_path directory. */
  createFullBackup: (
    serverId: string, serverName: string, installPath: string, mapId: string,
    backupDir: string, triggeredBy: string, tier = "",
  ) => invoke<BackupRecord>("create_full_backup", { serverId, serverName, installPath, mapId, backupDir, triggeredBy, tier }),

  /** List timestamped INI snapshot folder names for a server, newest first. */
  listIniBackups: (serverId: string, backupDir: string) =>
    invoke<string[]>("list_ini_backups", { serverId, backupDir }),

  /** Restore a server backup: extract 7z over SavedArks+SaveGames. */
  restoreServerBackup: (serverId: string, backupFilePath: string, installPath: string) =>
    invoke<void>("restore_server_backup", { serverId, backupFilePath, installPath }),

  /** Restore a player backup: extract 7z into SavedArks/{mapPath}. */
  restorePlayerBackup: (serverId: string, backupFilePath: string, installPath: string, mapPath: string) =>
    invoke<void>("restore_player_backup", { serverId, backupFilePath, installPath, mapPath }),

  /** Restore an INI backup: copy loose INI files back to Config/{platform}. */
  restoreIniBackup: (backupFolderPath: string, installPath: string, platform: string) =>
    invoke<void>("restore_ini_backup", { backupFolderPath, installPath, platform }),

  /** Restore a full backup: extract 7z over the entire install_path. */
  restoreFullBackup: (serverId: string, backupFilePath: string, installPath: string) =>
    invoke<void>("restore_full_backup", { serverId, backupFilePath, installPath }),

  /** Delete a backup archive or INI folder from disk. */
  deleteBackup: (filePath: string) => invoke<void>("delete_backup", { filePath }),

  /** Delete ARK's own timestamped .ark backups and .profilebak files. */
  cleanupArkOwnBackups: (installPath: string, mapPath: string) =>
    invoke<number>("cleanup_ark_own_backups", { installPath, mapPath }),

  /** Estimate total uncompressed size of a directory in bytes. */
  estimateDirSize: (dirPath: string) => invoke<number>("estimate_dir_size", { dirPath }),

  /** Rename a backup file on disk (used when tier flags change). */
  renameBackupFile: (oldPath: string, newPath: string) =>
    invoke<void>("rename_backup_file", { oldPath, newPath }),

  /** Check whether a backup file still exists on disk. */
  backupFileExists: (filePath: string) => invoke<boolean>("backup_file_exists", { filePath }),

  /** Scan the server's backup directory tree and return all discovered .7z files. */
  scanBackupDir: (serverId: string, backupDir: string, mapId: string) =>
    invoke<BackupRecord[]>("scan_backup_dir", { serverId, backupDir, mapId }),

  // Mods
  /**
   * Download all listed mods via SteamCMD, cache them, and copy to the server.
   * Streams progress to `mods://progress/{serverId}`.
   */
  installMods: (params: {
    serverId: string;
    steamcmdPath: string;
    baseDir: string;
    installPath: string;
    modIds: string[];
  }) => invoke<void>("install_mods", params),
  /**
   * Open CurseForge in a dedicated WebviewWindow sized for the mod browser.
   * Pass the list of already-added mod IDs so the injected button reflects state.
   */
  openModBrowser: (
    serverId: string,
    serverName: string,
    addedModIds: string[],
  ) => invoke<void>("open_mod_browser", { serverId, serverName, addedModIds }),
  /** Close the mod browser window. Emits mod://browser-closed. */
  closeModBrowser: () =>
    invoke<void>("close_mod_browser", {}),
  /**
   * Open a hidden WebviewWindow that navigates through each mod ID on CurseForge,
   * verifying the mod belongs to ASA and extracting its name.  Returns immediately;
   * results arrive as Tauri events: mod://add-to-server (source:"verify"),
   * mod://verify-fail, mod://verify-skip, and mod://verify-complete.
   */
  startModVerification: (modIds: string[], serverId: string, addedModIds: string[]) =>
    invoke<void>("start_mod_verification", { modIds, serverId, addedModIds }),
  /** Close the hidden mod-verify window. */
  closeModVerify: () =>
    invoke<void>("close_mod_verify", {}),
  // System stats
  /**
   * Validate a directory path: creates it if needed, tests write access,
   * and returns available disk space on that volume.
   */
  checkDir: (path: string) => invoke<DirCheckResult>("check_dir", { path }),
  checkFileExists: (path: string) => invoke<boolean>("check_file_exists", { path }),
  wipeLokiAsamDir: (path: string, fullWipe: boolean) => invoke<void>("wipe_lokiasam_dir", { path, fullWipe }),
  /** Recursively delete a directory. Idempotent — returns Ok if path doesn't exist. */
  deleteDirectory: (path: string) => invoke<void>("delete_directory", { path }),
  /**
   * Request cancellation of a running operation by key.
   * Known keys: "steamcmd_install", "proton_download", "server_{serverId}".
   */
  abortOperation: (opId: string) => invoke<void>("abort_operation", { opId }),
  /**
   * Move the base directory from oldDir to newDir.
   * Tries an atomic rename first; falls back to copy+delete for cross-volume moves.
   * Streams progress to `base-dir://migrate-progress`.
   * Returns the new DB path `{newDir}/lokiasam/lokiasam.db` on success.
   */
  moveBaseDir: (oldDir: string, newDir: string, createBackup: boolean) =>
    invoke<string>("move_base_dir", { oldDir, newDir, createBackup }),
  getProcessStats:    (pid: number, installPath?: string) => invoke<ProcessStats>("get_process_stats", { pid, installPath: installPath ?? null }),
  getPlatform:        () => invoke<string>("get_platform"),
  /** Open the Rust-side stats recorder DB connection at the given absolute path.
   *  Must be called after initDb() has run all migrations on the same file. */
  initStatsRecorder:  (dbPath: string) => invoke<void>("init_stats_recorder", { dbPath }),
  /** Tell the backend whether first-time setup is complete.
   *  Controls close-to-tray: if not done, the X button exits the process. */
  setSetupComplete:   (complete: boolean) => invoke<void>("set_setup_complete", { complete }),
  /** Update the close-to-tray preference and show/hide the tray icon. */
  setCloseToTray:     (enabled: boolean) => invoke<void>("set_close_to_tray", { enabled }),
  queryServer:        (ip: string, port: number) => invoke<ServerQueryResult>("query_server", { ip, port }),
  checkPortAvailable: (port: number) => invoke<boolean>("check_port_available", { port }),
  /** Exit the app immediately, bypassing close-to-tray logic. */
  forceQuit: () => invoke<void>("force_quit"),
  /** Open a directory in the platform file manager (xdg-open / Explorer). */
  openFolder: (path: string) => invoke<void>("open_folder", { path }),

  // Proton-GE (Linux)
  /** Scan well-known Steam locations and {baseDir}/proton/ for GE-Proton installs. */
  scanForProton: (baseDir: string) => invoke<ProtonEntry[]>("scan_for_proton", { baseDir }),
  /** Validate that a directory contains a usable Proton-GE install. */
  validateProtonPath: (path: string) => invoke<boolean>("validate_proton_path", { path }),
  /**
   * Download the latest GE-Proton release to {targetDir} and return the
   * extracted path. Streams progress to `proton://output/download`.
   */
  downloadProtonGe: (targetDir: string) => invoke<string>("download_proton_ge", { targetDir }),
  /** Query GitHub for the latest GE-Proton release without downloading. */
  checkProtonGeUpdate: (currentPath: string) =>
    invoke<ProtonUpdateInfo>("check_proton_ge_update", { currentPath }),

  // Notifications
  sendDiscordNotification: (webhookUrl: string, payload: DiscordPayload) =>
    invoke<void>("send_discord_notification", { webhookUrl, payload }),
  sendEmailNotification:   (smtpConfig: SmtpConfig, payload: EmailPayload) =>
    invoke<void>("send_email_notification", { smtpConfig, payload }),
  sendOsNotification:      (title: string, body: string) =>
    invoke<void>("send_os_notification", { title, body }),

  // Clusters
  createCluster:          (name: string, baseDir: string, clusterDirOverride?: string) =>
    invoke<string>("create_cluster", { name, baseDir, clusterDirOverride }),
  deleteCluster:          (clusterId: string) => invoke<void>("delete_cluster", { clusterId }),
  addServerToCluster:     (serverId: string, clusterId: string) =>
    invoke<void>("add_server_to_cluster", { serverId, clusterId }),
  removeServerFromCluster: (serverId: string) =>
    invoke<void>("remove_server_from_cluster", { serverId }),

  // Scheduler
  /** Atomically replace all active schedule entries in the Rust scheduler. */
  syncSchedules: (entries: ScheduleEntry[]) =>
    invoke<void>("sync_schedules", { entries }),

  // AppImage desktop integration (Linux only)
  /**
   * Check whether LokiASAM is running as an AppImage and whether it is
   * already registered in the user's application menu.
   */
  checkAppimageIntegration: () =>
    invoke<{ isAppimage: boolean; isInstalled: boolean }>("check_appimage_integration"),
  /** Install the .desktop file and icon to ~/.local/share/ (AppImage only). */
  installAppimageIntegration: () => invoke<void>("install_appimage_integration"),
  /** Remove the .desktop file and icons installed by installAppimageIntegration. */
  uninstallAppimageIntegration: () => invoke<void>("uninstall_appimage_integration"),

  // Bootstrap
  /** Read the bootstrap file. Returns null if first-time setup has never run. */
  readBootstrap: () => invoke<{ baseDir: string } | null>("read_bootstrap"),
  /**
   * Persist base_dir to the bootstrap file.  Also creates {base_dir}/lokiasam/
   * and migrates the old database from app_data_dir if present.
   */
  writeBootstrap: (baseDir: string) => invoke<void>("write_bootstrap", { baseDir }),

  // CFCore retry
  /** Emit a standard "start-failed" status event after all CFCore auto-retries are exhausted. */
  forceServerStartFailed: (serverId: string, error: string) =>
    invoke<void>("force_server_start_failed", { serverId, error }),

  // Amazon Root CA certificate
  /** Download Amazon Root CA 1 to tempDir and return the saved file path. */
  downloadAmazonRootCa: (tempDir: string) =>
    invoke<string>("download_amazon_root_ca", { tempDir }),
  /** Install the downloaded cert into the Windows cert store (Windows) or Wine prefix (Linux). */
  installAmazonRootCa: (certPath: string, protonPath?: string, prefixPath?: string) =>
    invoke<void>("install_amazon_root_ca", { certPath, protonPath, prefixPath }),
  /** Check whether Amazon Root CA 1 is already installed. */
  checkAmazonRootCaInstalled: (protonPath?: string, prefixPath?: string) =>
    invoke<boolean>("check_amazon_root_ca_installed", { protonPath, prefixPath }),

  // Firewall management
  /** Check firewall status for the given ports. Non-elevated on all platforms. */
  checkFirewallPorts: (ports: PortDef[]) =>
    invoke<FirewallStatus>("check_firewall_ports", { ports }),
  /** Add firewall rules for the given ports. Triggers UAC / pkexec elevation. */
  addFirewallRules: (ports: PortDef[], protonPath?: string) =>
    invoke<void>("add_firewall_rules", { ports, protonPath }),
  /** Remove firewall rules. Called when user opts in during server deletion. */
  removeFirewallRules: (ports: PortDef[]) =>
    invoke<void>("remove_firewall_rules", { ports }),
  /** Return all ports currently tracked by LokiASAM's firewall state. */
  getAllFirewallPorts: () =>
    invoke<PortDef[]>("get_all_firewall_ports"),
};
