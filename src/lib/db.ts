/**
 * db.ts — Typed SQLite helper functions using @tauri-apps/plugin-sql.
 *
 * All database access from the frontend goes through these helpers.
 * The underlying tauri-plugin-sql runs migrations automatically on first open
 * (configured in src-tauri/src/lib.rs).
 */

import Database from "@tauri-apps/plugin-sql";

// Singleton DB connection — opened on first use.
let _db: Database | null = null;

async function getDb(): Promise<Database> {
  if (!_db) {
    _db = await Database.load("sqlite:lokiasam.db");
  }
  return _db;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServerRow {
  id: string;
  name: string;
  map_id: string;
  install_path: string;
  port: number;
  query_port: number;
  rcon_port: number;
  rcon_password: string;
  max_players: number;
  server_password: string | null;
  admin_password: string;
  cluster_id: string | null;
  preset_id: string | null;
  status: string;
  pid: number | null;
  created_at: string;
  updated_at: string;
}

export interface ServerConfigRow {
  server_id: string;
  game_user_settings_json: string;
  game_ini_json: string;
  launch_args_json: string;
  updated_at: string;
}

export interface ScheduleRow {
  id: string;
  server_id: string;
  schedule_type: string;
  cron_expression: string;
  enabled: number;
  config_json: string;
  last_run: string | null;
  next_run: string | null;
  created_at: string;
}

export interface ClusterRow {
  id: string;
  name: string;
  cluster_dir_override: string | null;
  settings_json: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// App Settings
// ---------------------------------------------------------------------------

/** Retrieve a global app setting value. Returns null if the key doesn't exist. */
export async function getAppSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM app_settings WHERE key = ?",
    [key]
  );
  return rows.length > 0 ? rows[0].value : null;
}

/** Upsert a global app setting. */
export async function setAppSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    [key, value]
  );
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

/** Fetch all server rows ordered by name. */
export async function getServers(): Promise<ServerRow[]> {
  const db = await getDb();
  return db.select<ServerRow[]>("SELECT * FROM servers ORDER BY name ASC");
}

/** Fetch a single server row by ID. Returns null if not found. */
export async function getServer(id: string): Promise<ServerRow | null> {
  const db = await getDb();
  const rows = await db.select<ServerRow[]>(
    "SELECT * FROM servers WHERE id = ?",
    [id]
  );
  return rows.length > 0 ? rows[0] : null;
}

export interface CreateServerInput {
  id: string;
  name: string;
  mapId: string;
  installPath: string;
  port: number;
  queryPort: number;
  rconPort: number;
  rconPassword: string;
  maxPlayers: number;
  serverPassword?: string;
  adminPassword: string;
  clusterId?: string;
  presetId?: string;
}

/** Insert a new server record. Returns the server ID. */
export async function createServer(input: CreateServerInput): Promise<string> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO servers
       (id, name, map_id, install_path, port, query_port, rcon_port, rcon_password,
        max_players, server_password, admin_password, cluster_id, preset_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped')`,
    [
      input.id,
      input.name,
      input.mapId,
      input.installPath,
      input.port,
      input.queryPort,
      input.rconPort,
      input.rconPassword,
      input.maxPlayers,
      input.serverPassword ?? null,
      input.adminPassword,
      input.clusterId ?? null,
      input.presetId ?? null,
    ]
  );
  return input.id;
}

/** Delete a server record and all its related config/mods/schedules (CASCADE). */
export async function deleteServerRecord(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM servers WHERE id = ?", [id]);
}

// ---------------------------------------------------------------------------
// Server Config
// ---------------------------------------------------------------------------

/** Upsert the server_config row for a server. */
export async function saveServerConfig(
  serverId: string,
  gameUserSettingsJson: string,
  gameIniJson: string,
  launchArgsJson: string
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO server_config (server_id, game_user_settings_json, game_ini_json, launch_args_json, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(server_id) DO UPDATE SET
       game_user_settings_json = excluded.game_user_settings_json,
       game_ini_json           = excluded.game_ini_json,
       launch_args_json        = excluded.launch_args_json,
       updated_at              = excluded.updated_at`,
    [serverId, gameUserSettingsJson, gameIniJson, launchArgsJson]
  );
}

/** Fetch server_config for a server. Returns null if not configured yet. */
export async function getServerConfig(serverId: string): Promise<ServerConfigRow | null> {
  const db = await getDb();
  const rows = await db.select<ServerConfigRow[]>(
    "SELECT * FROM server_config WHERE server_id = ?",
    [serverId]
  );
  return rows.length > 0 ? rows[0] : null;
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

export interface CreateScheduleInput {
  id: string;
  serverId: string;
  scheduleType: string;
  cronExpression: string;
  enabled: boolean;
  configJson: string;
}

/** Insert a schedule record. */
export async function createSchedule(input: CreateScheduleInput): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO schedules (id, server_id, schedule_type, cron_expression, enabled, config_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.serverId,
      input.scheduleType,
      input.cronExpression,
      input.enabled ? 1 : 0,
      input.configJson,
    ]
  );
}

/** Fetch all schedules for a server. */
export async function getServerSchedules(serverId: string): Promise<ScheduleRow[]> {
  const db = await getDb();
  return db.select<ScheduleRow[]>(
    "SELECT * FROM schedules WHERE server_id = ? ORDER BY schedule_type ASC",
    [serverId]
  );
}

// ---------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------

/** Fetch all clusters. */
export async function getClusters(): Promise<ClusterRow[]> {
  const db = await getDb();
  return db.select<ClusterRow[]>("SELECT * FROM clusters ORDER BY name ASC");
}

/** Check if a server name is already in use. */
export async function isServerNameTaken(name: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<{ id: string }[]>(
    "SELECT id FROM servers WHERE name = ?",
    [name]
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Server runtime status helpers (called after Tauri commands)
// ---------------------------------------------------------------------------

/** Update a server's status and optional PID. Sets updated_at to now. */
export async function updateServerStatus(
  id: string,
  status: string,
  pid: number | null
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE servers SET status = ?, pid = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [status, pid ?? null, id]
  );
}

/** Fetch servers whose status is 'running' and have a stored PID.
 *  Called on app startup to reconcile state from a previous session. */
export async function getRunningServers(): Promise<ServerRow[]> {
  const db = await getDb();
  return db.select<ServerRow[]>(
    "SELECT * FROM servers WHERE status = 'running' AND pid IS NOT NULL"
  );
}

// ---------------------------------------------------------------------------
// Aggregate helpers used by ServerCard
// ---------------------------------------------------------------------------

/** Return the number of enabled mods attached to a server. */
export async function getServerModCount(serverId: string): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ count: number }[]>(
    "SELECT COUNT(*) as count FROM server_mods WHERE server_id = ? AND enabled = 1",
    [serverId]
  );
  return rows[0]?.count ?? 0;
}

/** Return the ISO timestamp of the most recent backup, or null if none exist. */
export async function getLastBackupTime(serverId: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ created_at: string }[]>(
    "SELECT created_at FROM backups WHERE server_id = ? ORDER BY created_at DESC LIMIT 1",
    [serverId]
  );
  return rows[0]?.created_at ?? null;
}

/** Return the next_run ISO timestamp for the restart/update schedule, or null. */
export async function getNextScheduledRestart(serverId: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ next_run: string | null }[]>(
    `SELECT next_run FROM schedules
     WHERE server_id = ? AND schedule_type IN ('restart', 'update') AND enabled = 1
     ORDER BY next_run ASC LIMIT 1`,
    [serverId]
  );
  return rows[0]?.next_run ?? null;
}
