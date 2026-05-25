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
  status: string;
  pid: number | null;
  uptimeSeconds: number | null;
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

export interface ServerConfigJson {
  gameUserSettings: Record<string, unknown>;
  gameIni: Record<string, unknown>;
  launchArgs: Record<string, unknown>;
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
  startServer:   (serverId: string) => invoke<void>("start_server", { serverId }),
  stopServer:    (serverId: string, graceful: boolean) => invoke<void>("stop_server", { serverId, graceful }),
  restartServer: (serverId: string, graceful: boolean) => invoke<void>("restart_server", { serverId, graceful }),
  getServerStatus: (serverId: string) => invoke<ServerStatus>("get_server_status", { serverId }),
  cloneServer:   (sourceId: string, newName: string, newPorts: PortConfig) =>
    invoke<string>("clone_server", { sourceId, newName, newPorts }),
  deleteServer:  (serverId: string, deleteFiles: boolean) =>
    invoke<void>("delete_server", { serverId, deleteFiles }),

  // SteamCMD / installation
  installSteamcmd:          (targetDir: string) => invoke<void>("install_steamcmd", { targetDir }),
  validateSteamcmd:         (path: string) => invoke<boolean>("validate_steamcmd", { path }),
  installServer:            (serverId: string) => invoke<void>("install_server", { serverId }),
  updateServer:             (serverId: string) => invoke<void>("update_server", { serverId }),
  validateServerFiles:      (serverId: string) => invoke<void>("validate_server_files", { serverId }),
  checkServerUpdateAvailable: (serverId: string) =>
    invoke<boolean>("check_server_update_available", { serverId }),

  // RCON
  rconConnect:    (serverId: string) => invoke<void>("rcon_connect", { serverId }),
  rconSend:       (serverId: string, command: string) => invoke<string>("rcon_send", { serverId, command }),
  rconDisconnect: (serverId: string) => invoke<void>("rcon_disconnect", { serverId }),
  rconGetPlayers: (serverId: string) => invoke<ArkPlayer[]>("rcon_get_players", { serverId }),

  // Config / INI
  readServerConfig:  (serverId: string) => invoke<ServerConfigJson>("read_server_config", { serverId }),
  writeServerConfig: (serverId: string, config: ServerConfigJson) =>
    invoke<void>("write_server_config", { serverId, config }),
  importIniFiles:    (gusPath: string, gameIniPath: string) =>
    invoke<ServerConfigJson>("import_ini_files", { gusPath, gameIniPath }),

  // Backups
  createBackup:  (serverId: string, triggeredBy: string) =>
    invoke<BackupRecord>("create_backup", { serverId, triggeredBy }),
  restoreBackup: (serverId: string, backupId: string) =>
    invoke<void>("restore_backup", { serverId, backupId }),
  deleteBackup:  (backupId: string) => invoke<void>("delete_backup", { backupId }),
  pruneBackups:  (serverId: string) => invoke<number>("prune_backups", { serverId }),

  // Mods
  installMods:  (serverId: string) => invoke<void>("install_mods", { serverId }),
  addMod:       (serverId: string, modId: string, modName: string) =>
    invoke<void>("add_mod", { serverId, modId, modName }),
  removeMod:    (serverId: string, modId: string) => invoke<void>("remove_mod", { serverId, modId }),
  reorderMods:  (serverId: string, orderedModIds: string[]) =>
    invoke<void>("reorder_mods", { serverId, orderedModIds }),

  // System stats
  getProcessStats:    (pid: number) => invoke<ProcessStats>("get_process_stats", { pid }),
  queryServer:        (ip: string, port: number) => invoke<ServerQueryResult>("query_server", { ip, port }),
  checkPortAvailable: (port: number) => invoke<boolean>("check_port_available", { port }),

  // Notifications
  sendDiscordNotification: (webhookUrl: string, payload: DiscordPayload) =>
    invoke<void>("send_discord_notification", { webhookUrl, payload }),
  sendEmailNotification:   (smtpConfig: SmtpConfig, payload: EmailPayload) =>
    invoke<void>("send_email_notification", { smtpConfig, payload }),
  sendOsNotification:      (title: string, body: string) =>
    invoke<void>("send_os_notification", { title, body }),

  // Clusters
  createCluster:          (name: string, clusterDirOverride?: string) =>
    invoke<string>("create_cluster", { name, clusterDirOverride }),
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
