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

export interface ServerStatus {
  serverId: string;
  /** One of: stopped | starting | running | stopping | updating | error | crashed */
  status: string;
  pid: number | null;
  uptimeSeconds: number | null;
}

/** Full parameter set passed to `start_server`. All values come from SQLite. */
export interface StartServerParams {
  serverId: string;
  installPath: string;
  /** ASA map identifier, e.g. "TheIsland_WP". */
  mapPath: string;
  port: number;
  queryPort: number;
  rconPort: number;
  maxPlayers: number;
  serverPassword?: string;
  adminPassword: string;
  /** Additional CLI flags like ["-NoBattlEye", "-servergamelog"]. */
  extraArgs: string[];
  /** CurseForge mod IDs to pass as -mods=id1,id2,... on startup. */
  modIds: string[];
  /** Linux only: path to the Proton-GE installation directory. */
  protonPath?: string;
  /** Linux only: path to the Steam compatibility prefix (WINEPREFIX). */
  prefixPath?: string;
}

export interface ProtonEntry {
  path: string;
  version: string;
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
  steamId: string;
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
}

export interface ScheduleConfig {
  serverId: string;
  scheduleType: string;
  cronExpression: string;
  configJson: string;
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
  /** Re-register a PID from a previous session. Returns false if the process
   *  already exited (crashed while the app was closed). */
  registerRunningServer: (serverId: string, pid: number) =>
    invoke<boolean>("register_running_server", { serverId, pid }),
  cloneServer: (sourceId: string, newName: string, newPorts: PortConfig) =>
    invoke<string>("clone_server", { sourceId, newName, newPorts }),
  /** Delete server files from disk. DB record deletion is done separately via db.ts. */
  deleteServer: (serverId: string, installPath: string, deleteFiles: boolean) =>
    invoke<void>("delete_server", { serverId, installPath, deleteFiles }),

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
  checkServerUpdateAvailable: (serverId: string) =>
    invoke<boolean>("check_server_update_available", { serverId }),

  // RCON
  rconConnect: (serverId: string, host: string, port: number, password: string) =>
    invoke<void>("rcon_connect", { serverId, host, port, password }),
  rconSend:       (serverId: string, command: string) => invoke<string>("rcon_send", { serverId, command }),
  rconDisconnect: (serverId: string) => invoke<void>("rcon_disconnect", { serverId }),
  rconGetPlayers: (serverId: string) => invoke<ArkPlayer[]>("rcon_get_players", { serverId }),

  // Log watcher
  watchServerLog: (serverId: string, logPath: string) =>
    invoke<void>("watch_server_log", { serverId, logPath }),
  stopLogWatch: (serverId: string) => invoke<void>("stop_log_watch", { serverId }),

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
  /**
   * Zip the server's ShooterGame/Saved directory into backup_dir.
   * Emits backup://progress/{serverId} events. Returns a BackupRecord to
   * persist in SQLite via db.insertBackup().
   */
  createBackup: (
    serverId: string,
    serverName: string,
    installPath: string,
    backupDir: string,
    mapId: string,
    triggeredBy: string,
  ) => invoke<BackupRecord>("create_backup", { serverId, serverName, installPath, backupDir, mapId, triggeredBy }),
  /**
   * Extract backup zip over ShooterGame/Saved. The frontend must stop the
   * server before calling this and restart it after.
   */
  restoreBackup: (serverId: string, backupFilePath: string, installPath: string) =>
    invoke<void>("restore_backup", { serverId, backupFilePath, installPath }),
  /** Delete the zip file from disk. Frontend removes the SQLite record via db.deleteBackupRecord(). */
  deleteBackup: (filePath: string) => invoke<void>("delete_backup", { filePath }),

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
  addMod:       (serverId: string, modId: string, modName: string) =>
    invoke<void>("add_mod", { serverId, modId, modName }),
  removeMod:    (serverId: string, modId: string) => invoke<void>("remove_mod", { serverId, modId }),
  reorderMods:  (serverId: string, orderedModIds: string[]) =>
    invoke<void>("reorder_mods", { serverId, orderedModIds }),

  // System stats
  /**
   * Validate a directory path: creates it if needed, tests write access,
   * and returns available disk space on that volume.
   */
  checkDir: (path: string) => invoke<DirCheckResult>("check_dir", { path }),
  checkFileExists: (path: string) => invoke<boolean>("check_file_exists", { path }),
  /** Recursively delete a directory. Idempotent — returns Ok if path doesn't exist. */
  deleteDirectory: (path: string) => invoke<void>("delete_directory", { path }),
  getProcessStats:    (pid: number) => invoke<ProcessStats>("get_process_stats", { pid }),
  getPlatform:        () => invoke<string>("get_platform"),
  /** Tell the backend whether first-time setup is complete.
   *  Controls close-to-tray: if not done, the X button exits the process. */
  setSetupComplete:   (complete: boolean) => invoke<void>("set_setup_complete", { complete }),
  queryServer:        (ip: string, port: number) => invoke<ServerQueryResult>("query_server", { ip, port }),
  checkPortAvailable: (port: number) => invoke<boolean>("check_port_available", { port }),

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
  createSchedule: (config: ScheduleConfig) => invoke<string>("create_schedule", { config }),
  deleteSchedule: (scheduleId: string) => invoke<void>("delete_schedule", { scheduleId }),
  toggleSchedule: (scheduleId: string, enabled: boolean) =>
    invoke<void>("toggle_schedule", { scheduleId, enabled }),
};
