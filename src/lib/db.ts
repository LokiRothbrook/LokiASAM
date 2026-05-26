/**
 * db.ts — Typed SQLite helper functions using @tauri-apps/plugin-sql.
 *
 * All database access from the frontend goes through these helpers.
 * Call initDb(absoluteDbPath) once on startup before using any other
 * function in this module. Migrations are applied manually inside initDb.
 */

import Database from "@tauri-apps/plugin-sql";

// Singleton DB connection — populated by initDb().
let _db: Database | null = null;

/**
 * Open (or reuse) the database at an absolute filesystem path and apply
 * all schema migrations idempotently.  Must be called before any other
 * function in this module.
 */
export async function initDb(absoluteDbPath: string): Promise<void> {
  if (_db) return;
  _db = await Database.load(`sqlite:${absoluteDbPath}`);
  await runMigrations(_db);
}

async function getDb(): Promise<Database> {
  if (!_db) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return _db;
}

/** Apply all schema migrations idempotently. Safe to call on any DB state. */
async function runMigrations(db: Database): Promise<void> {
  await db.execute("PRAGMA journal_mode=WAL");
  await db.execute("PRAGMA foreign_keys=ON");

  // ── Migration 001: core tables ──────────────────────────────────────────
  await db.execute(`CREATE TABLE IF NOT EXISTS servers (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL UNIQUE,
    map_id            TEXT NOT NULL,
    install_path      TEXT NOT NULL,
    port              INTEGER NOT NULL DEFAULT 7777,
    query_port        INTEGER NOT NULL DEFAULT 27015,
    rcon_port         INTEGER NOT NULL DEFAULT 27020,
    rcon_password     TEXT NOT NULL DEFAULT '',
    max_players       INTEGER NOT NULL DEFAULT 70,
    server_password   TEXT,
    admin_password    TEXT NOT NULL DEFAULT '',
    cluster_id        TEXT,
    preset_id         TEXT,
    status            TEXT NOT NULL DEFAULT 'stopped',
    pid               INTEGER,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS server_config (
    server_id               TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    game_user_settings_json TEXT NOT NULL DEFAULT '{}',
    game_ini_json           TEXT NOT NULL DEFAULT '{}',
    launch_args_json        TEXT NOT NULL DEFAULT '{}',
    updated_at              DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS server_mods (
    id                TEXT PRIMARY KEY,
    server_id         TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    mod_id            TEXT NOT NULL,
    mod_name          TEXT NOT NULL,
    mod_thumbnail_url TEXT,
    install_order     INTEGER NOT NULL DEFAULT 0,
    enabled           INTEGER NOT NULL DEFAULT 1,
    added_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(server_id, mod_id)
  )`);

  // clusters includes settings_json (migration 002 column) so new DBs get it
  // directly; old copied DBs already have it from the ALTER TABLE below.
  await db.execute(`CREATE TABLE IF NOT EXISTS clusters (
    id                   TEXT PRIMARY KEY,
    name                 TEXT NOT NULL UNIQUE,
    cluster_dir_override TEXT,
    settings_json        TEXT NOT NULL DEFAULT '{}',
    created_at           DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS schedules (
    id              TEXT PRIMARY KEY,
    server_id       TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    schedule_type   TEXT NOT NULL,
    cron_expression TEXT NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    config_json     TEXT NOT NULL DEFAULT '{}',
    last_run        DATETIME,
    next_run        DATETIME,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS backups (
    id              TEXT PRIMARY KEY,
    server_id       TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    file_path       TEXT NOT NULL,
    file_size_bytes INTEGER NOT NULL DEFAULT 0,
    map_id          TEXT NOT NULL,
    triggered_by    TEXT NOT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS notification_configs (
    id          TEXT PRIMARY KEY,
    server_id   TEXT,
    channel     TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    config_json TEXT NOT NULL DEFAULT '{}',
    events_json TEXT NOT NULL DEFAULT '[]',
    UNIQUE(server_id, channel)
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS in_app_notifications (
    id         TEXT PRIMARY KEY,
    server_id  TEXT,
    event_type TEXT NOT NULL,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    severity   TEXT NOT NULL DEFAULT 'info',
    read       INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Reserved for future file-integrity tracking — not yet used by any query.
  await db.execute(`CREATE TABLE IF NOT EXISTS file_cache (
    cache_key    TEXT PRIMARY KEY,
    file_path    TEXT NOT NULL,
    size_bytes   INTEGER NOT NULL DEFAULT 0,
    sha256_hash  TEXT,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Indexes
  await db.execute("CREATE INDEX IF NOT EXISTS idx_server_mods_server_id ON server_mods(server_id)");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_schedules_server_id ON schedules(server_id)");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_backups_server_id ON backups(server_id)");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_notifications_server_id ON in_app_notifications(server_id)");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON in_app_notifications(created_at)");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_notifications_read ON in_app_notifications(read)");

  // Seed default settings (only for brand-new DBs)
  await db.execute(`INSERT OR IGNORE INTO app_settings (key, value) VALUES
    ('setup_complete', 'false'),
    ('base_dir', ''),
    ('backup_dir', ''),
    ('steamcmd_path', ''),
    ('steamcmd_mode', 'auto'),
    ('app_version', '0.1.0'),
    ('theme_accent', 'purple'),
    ('asa_update_available', 'false'),
    ('asa_last_checked', ''),
    ('asa_cached_build_id', ''),
    ('asa_latest_build_id', ''),
    ('asa_auto_check_hours', '0')`);

  // ── Migration 002: add settings_json to clusters if missing (old DBs) ──
  try {
    await db.execute("ALTER TABLE clusters ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'");
  } catch {
    // Column already exists — safe to ignore.
  }
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

/** Fetch a single schedule by ID. Returns null if not found. */
export async function getScheduleById(scheduleId: string): Promise<ScheduleRow | null> {
  const db = await getDb();
  const rows = await db.select<ScheduleRow[]>(
    "SELECT * FROM schedules WHERE id = ?",
    [scheduleId]
  );
  return rows.length > 0 ? rows[0] : null;
}

// ---------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------

/** Fetch all clusters. */
export async function getClusters(): Promise<ClusterRow[]> {
  const db = await getDb();
  return db.select<ClusterRow[]>("SELECT * FROM clusters ORDER BY name ASC");
}

/** Fetch a single cluster by ID. Returns null if not found. */
export async function getCluster(id: string): Promise<ClusterRow | null> {
  const db = await getDb();
  const rows = await db.select<ClusterRow[]>(
    "SELECT * FROM clusters WHERE id = ?",
    [id]
  );
  return rows.length > 0 ? rows[0] : null;
}

/** Insert a new cluster record. */
export async function createClusterRecord(
  id: string,
  name: string,
  clusterDirOverride: string | null
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO clusters (id, name, cluster_dir_override, settings_json)
     VALUES (?, ?, ?, '{}')`,
    [id, name, clusterDirOverride ?? null]
  );
}

/** Delete a cluster record. Servers in the cluster should have cluster_id cleared first. */
export async function deleteClusterRecord(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM clusters WHERE id = ?", [id]);
}

/** Fetch all servers belonging to a specific cluster. */
export async function getServersInCluster(clusterId: string): Promise<ServerRow[]> {
  const db = await getDb();
  return db.select<ServerRow[]>(
    "SELECT * FROM servers WHERE cluster_id = ? ORDER BY name ASC",
    [clusterId]
  );
}

/** Set or clear a server's cluster_id. Pass null to remove from cluster. */
export async function setServerCluster(
  serverId: string,
  clusterId: string | null
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE servers SET cluster_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [clusterId, serverId]
  );
}

/** Fetch clusters with server count for the list page. */
export async function getClustersWithServerCount(): Promise<
  Array<ClusterRow & { server_count: number }>
> {
  const db = await getDb();
  return db.select<Array<ClusterRow & { server_count: number }>>(
    `SELECT c.*, COUNT(s.id) as server_count
     FROM clusters c
     LEFT JOIN servers s ON s.cluster_id = c.id
     GROUP BY c.id
     ORDER BY c.name ASC`
  );
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

// ---------------------------------------------------------------------------
// Mods
// ---------------------------------------------------------------------------

export interface ModRow {
  id: string;
  server_id: string;
  mod_id: string;
  mod_name: string;
  mod_thumbnail_url: string | null;
  install_order: number;
  enabled: number;
  added_at: string;
}

/** Return all mods for a server ordered by install_order ascending. */
export async function getServerMods(serverId: string): Promise<ModRow[]> {
  const db = await getDb();
  return db.select<ModRow[]>(
    "SELECT * FROM server_mods WHERE server_id = ? ORDER BY install_order ASC",
    [serverId]
  );
}

/** Add a mod to the server_mods table if it doesn't already exist. */
export async function addServerMod(
  serverId: string,
  modId: string,
  modName: string,
  thumbnailUrl?: string | null
): Promise<void> {
  const db = await getDb();
  // Find the current max install_order to append at the end.
  const rows = await db.select<{ max_order: number | null }[]>(
    "SELECT MAX(install_order) as max_order FROM server_mods WHERE server_id = ?",
    [serverId]
  );
  const nextOrder = (rows[0]?.max_order ?? -1) + 1;
  const id = crypto.randomUUID();
  await db.execute(
    `INSERT OR IGNORE INTO server_mods
       (id, server_id, mod_id, mod_name, mod_thumbnail_url, install_order, enabled)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [id, serverId, modId, modName, thumbnailUrl ?? null, nextOrder]
  );
}

/** Remove a mod from a server's mod list. */
export async function removeServerMod(serverId: string, modId: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM server_mods WHERE server_id = ? AND mod_id = ?",
    [serverId, modId]
  );
}

/** Toggle the enabled flag on a mod. */
export async function toggleServerMod(
  serverId: string,
  modId: string,
  enabled: boolean
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE server_mods SET enabled = ? WHERE server_id = ? AND mod_id = ?",
    [enabled ? 1 : 0, serverId, modId]
  );
}

/**
 * Reorder mods by updating each row's install_order to match the provided array index.
 * `orderedModIds` must contain every mod_id currently attached to the server.
 * All updates run in a single transaction so partial reorders are never persisted.
 */
export async function reorderServerMods(
  serverId: string,
  orderedModIds: string[]
): Promise<void> {
  const db = await getDb();
  await db.execute("BEGIN");
  try {
    for (let i = 0; i < orderedModIds.length; i++) {
      await db.execute(
        "UPDATE server_mods SET install_order = ? WHERE server_id = ? AND mod_id = ?",
        [i, serverId, orderedModIds[i]]
      );
    }
    await db.execute("COMMIT");
  } catch (err) {
    await db.execute("ROLLBACK").catch(() => {});
    throw err;
  }
}

/** Return the number of enabled mods attached to a server. */
export async function getServerModCount(serverId: string): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ count: number }[]>(
    "SELECT COUNT(*) as count FROM server_mods WHERE server_id = ? AND enabled = 1",
    [serverId]
  );
  return rows[0]?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

export interface BackupRow {
  id: string;
  server_id: string;
  file_path: string;
  file_size_bytes: number;
  map_id: string;
  triggered_by: string;
  created_at: string;
}

/** Insert a backup record returned by the Rust create_backup command. */
export async function insertBackup(record: BackupRow): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO backups (id, server_id, file_path, file_size_bytes, map_id, triggered_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.server_id,
      record.file_path,
      record.file_size_bytes,
      record.map_id,
      record.triggered_by,
      record.created_at,
    ]
  );
}

/** Fetch all backup records for a server, newest first. */
export async function getServerBackups(serverId: string): Promise<BackupRow[]> {
  const db = await getDb();
  return db.select<BackupRow[]>(
    "SELECT * FROM backups WHERE server_id = ? ORDER BY created_at DESC",
    [serverId]
  );
}

/** Remove a backup record from the database (after the file has been deleted). */
export async function deleteBackupRecord(backupId: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM backups WHERE id = ?", [backupId]);
}

// ---------------------------------------------------------------------------
// Schedule mutations
// ---------------------------------------------------------------------------

/** Delete a schedule record from the database. */
export async function deleteScheduleRecord(scheduleId: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM schedules WHERE id = ?", [scheduleId]);
}

/** Enable or disable a schedule. */
export async function updateScheduleEnabled(
  scheduleId: string,
  enabled: boolean
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE schedules SET enabled = ? WHERE id = ?",
    [enabled ? 1 : 0, scheduleId]
  );
}

/** Update last_run and next_run after a schedule fires. */
export async function updateScheduleRun(
  scheduleId: string,
  lastRun: string,
  nextRun: string | null
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE schedules SET last_run = ?, next_run = ? WHERE id = ?",
    [lastRun, nextRun, scheduleId]
  );
}

/** Update the cron expression and config for a schedule. */
export async function updateScheduleConfig(
  scheduleId: string,
  cronExpression: string,
  configJson: string,
  nextRun: string
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE schedules SET cron_expression = ?, config_json = ?, next_run = ? WHERE id = ?",
    [cronExpression, configJson, nextRun, scheduleId]
  );
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

// ---------------------------------------------------------------------------
// In-app Notifications
// ---------------------------------------------------------------------------

export interface InAppNotificationRow {
  id: string;
  server_id: string | null;
  event_type: string;
  title: string;
  body: string;
  severity: string;
  read: number;
  created_at: string;
}

export interface LogNotificationInput {
  id: string;
  serverId: string | null;
  eventType: string;
  title: string;
  body: string;
  severity: "info" | "success" | "warning" | "error";
}

/** Insert a new notification into the in_app_notifications log. */
export async function logNotification(input: LogNotificationInput): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO in_app_notifications (id, server_id, event_type, title, body, severity, read)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [input.id, input.serverId ?? null, input.eventType, input.title, input.body, input.severity]
  );
}

export interface GetNotificationsFilter {
  serverId?: string | null;
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
}

/** Fetch notification rows, newest first. */
export async function getNotifications(
  filter: GetNotificationsFilter = {}
): Promise<InAppNotificationRow[]> {
  const db = await getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.serverId !== undefined) {
    if (filter.serverId === null) {
      conditions.push("server_id IS NULL");
    } else {
      conditions.push("server_id = ?");
      params.push(filter.serverId);
    }
  }
  if (filter.unreadOnly) {
    conditions.push("read = 0");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;

  return db.select<InAppNotificationRow[]>(
    `SELECT * FROM in_app_notifications ${where}
     ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
}

/** Return the count of unread notifications. */
export async function getUnreadNotificationCount(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ count: number }[]>(
    "SELECT COUNT(*) as count FROM in_app_notifications WHERE read = 0"
  );
  return rows[0]?.count ?? 0;
}

/** Mark a single notification as read. */
export async function markNotificationRead(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE in_app_notifications SET read = 1 WHERE id = ?", [id]);
}

/** Mark all notifications as read. */
export async function markAllNotificationsRead(): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE in_app_notifications SET read = 1 WHERE read = 0");
}

/** Delete notifications older than `days` days. */
export async function pruneOldNotifications(days: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    `DELETE FROM in_app_notifications
     WHERE created_at < datetime('now', '-' || ? || ' days')`,
    [days]
  );
}

// ---------------------------------------------------------------------------
// Notification Configs
// ---------------------------------------------------------------------------

export interface NotificationConfigRow {
  id: string;
  server_id: string | null;
  channel: string;
  enabled: number;
  config_json: string;
  events_json: string;
}

export interface SaveNotificationConfigInput {
  id: string;
  serverId: string | null;
  channel: string;
  enabled: boolean;
  configJson: string;
  eventsJson: string;
}

/** Fetch all notification configs for a server (and global fallbacks). */
export async function getNotificationConfigs(
  serverId: string | null
): Promise<NotificationConfigRow[]> {
  const db = await getDb();
  if (serverId) {
    // Return per-server configs + global configs (server_id IS NULL)
    return db.select<NotificationConfigRow[]>(
      `SELECT * FROM notification_configs
       WHERE server_id = ? OR server_id IS NULL
       ORDER BY server_id NULLS LAST`,
      [serverId]
    );
  }
  return db.select<NotificationConfigRow[]>(
    "SELECT * FROM notification_configs WHERE server_id IS NULL"
  );
}

/** Fetch notification configs for a specific server only (no global fallback). */
export async function getServerNotificationConfigs(
  serverId: string
): Promise<NotificationConfigRow[]> {
  const db = await getDb();
  return db.select<NotificationConfigRow[]>(
    "SELECT * FROM notification_configs WHERE server_id = ?",
    [serverId]
  );
}

/** Upsert a notification config (insert or replace on server_id+channel conflict). */
export async function saveNotificationConfig(
  input: SaveNotificationConfigInput
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO notification_configs (id, server_id, channel, enabled, config_json, events_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_id, channel) DO UPDATE SET
       enabled     = excluded.enabled,
       config_json = excluded.config_json,
       events_json = excluded.events_json`,
    [
      input.id,
      input.serverId ?? null,
      input.channel,
      input.enabled ? 1 : 0,
      input.configJson,
      input.eventsJson,
    ]
  );
}

/** Delete a notification config row. */
export async function deleteNotificationConfig(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM notification_configs WHERE id = ?", [id]);
}
