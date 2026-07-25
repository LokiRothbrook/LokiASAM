/**
 * db.ts — Typed SQLite helper functions using @tauri-apps/plugin-sql.
 *
 * All database access from the frontend goes through these helpers.
 * Call initDb(absoluteDbPath) once on startup before using any other
 * function in this module. Migrations are applied manually inside initDb.
 */

import Database from "@tauri-apps/plugin-sql";
import { CronExpressionParser } from "cron-parser";

// Singleton DB connection — populated by initDb().
let _db: Database | null = null;

/**
 * Parse a SQLite datetime string as UTC.
 * SQLite's CURRENT_TIMESTAMP returns "YYYY-MM-DD HH:MM:SS" with no timezone
 * marker. JavaScript's Date constructor treats that format as local time in
 * most engines, causing displayed times to be off by the user's UTC offset.
 * Normalising to ISO UTC ("T" separator + "Z") fixes the parse.
 */
export function parseDbDate(ts: string): Date {
  if (!ts.includes("T")) {
    return new Date(ts.replace(" ", "T") + "Z");
  }
  return new Date(ts);
}

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
    id                     TEXT PRIMARY KEY,
    name                   TEXT NOT NULL UNIQUE,
    map_id                 TEXT NOT NULL,
    install_path           TEXT NOT NULL,
    port                   INTEGER NOT NULL DEFAULT 7777,
    query_port             INTEGER NOT NULL DEFAULT 27015,
    rcon_port              INTEGER NOT NULL DEFAULT 27020,
    max_players            INTEGER NOT NULL DEFAULT 70,
    server_password        TEXT,
    admin_password         TEXT NOT NULL DEFAULT '',
    cluster_id             TEXT,
    preset_id              TEXT,
    status                 TEXT NOT NULL DEFAULT 'stopped',
    pid                    INTEGER,
    update_available       INTEGER NOT NULL DEFAULT 0,
    update_automation_json TEXT NOT NULL DEFAULT '{}',
    created_at             DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at             DATETIME DEFAULT CURRENT_TIMESTAMP
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
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    backup_type     TEXT NOT NULL DEFAULT 'server',
    tiers           TEXT NOT NULL DEFAULT '',
    player_eosid    TEXT,
    player_name     TEXT
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS player_name_map (
    server_id   TEXT NOT NULL,
    eos_id      TEXT NOT NULL,
    player_name TEXT NOT NULL,
    last_seen   TEXT NOT NULL,
    PRIMARY KEY (server_id, eos_id)
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
    ('theme_preset', 'storm'),
    ('theme_accent', 'blue'),
    ('asa_update_available', 'false'),
    ('asa_last_checked', ''),
    ('asa_cached_build_id', ''),
    ('asa_latest_build_id', ''),
    ('asa_auto_check_hours', 'startup'),
    ('app_update_check_mode', 'startup'),
    ('auto_restart_downed', 'ask'),
    ('full_backup_warning_dismissed', 'false')`);

  // ── Migration 002: add settings_json to clusters if missing (old DBs) ──
  try {
    await db.execute("ALTER TABLE clusters ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'");
  } catch {
    // Column already exists — safe to ignore.
  }

  // ── Migration 003: add locked_by_map to server_mods (old DBs) ───────────
  try {
    await db.execute("ALTER TABLE server_mods ADD COLUMN locked_by_map INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists — safe to ignore.
  }

  // ── Migration 004: per-server update tracking + automation ───────────────
  // update_available: set by the global check when this server's installed
  //   build is behind the shared cache. Persists across reboots; cleared only
  //   when the server is actually updated.
  // update_automation_json: per-server update automation settings (mode,
  //   time, restart behaviour). Replaces the old schedule_type='update' rows.
  try {
    await db.execute("ALTER TABLE servers ADD COLUMN update_available INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists — safe to ignore.
  }
  try {
    await db.execute("ALTER TABLE servers ADD COLUMN update_automation_json TEXT NOT NULL DEFAULT '{}'");
  } catch {
    // Column already exists — safe to ignore.
  }
  // Remove old cron-based update schedules — superseded by update_automation_json.
  await db.execute("DELETE FROM schedules WHERE schedule_type = 'update'");

  // ── Migration 005: per-server graceful shutdown settings ─────────────────
  try {
    await db.execute("ALTER TABLE servers ADD COLUMN shutdown_warn_players INTEGER NOT NULL DEFAULT 1");
  } catch { /* already exists */ }
  try {
    await db.execute("ALTER TABLE servers ADD COLUMN shutdown_warn_minutes INTEGER NOT NULL DEFAULT 5");
  } catch { /* already exists */ }
  try {
    await db.execute("ALTER TABLE servers ADD COLUMN shutdown_message TEXT NOT NULL DEFAULT 'Server will shut down in {time}.'");
  } catch { /* already exists */ }

  // ── Migration 007: per-server auto_start flag ─────────────────────────────
  // auto_start = 1 means this server always starts when the app opens,
  // regardless of what state it was in when the app closed.
  try {
    await db.execute("ALTER TABLE servers ADD COLUMN auto_start INTEGER NOT NULL DEFAULT 0");
  } catch { /* already exists */ }

  // ── Migration 014: restart / update warning settings ─────────────────────
  try { await db.execute("ALTER TABLE servers ADD COLUMN restart_warn_players INTEGER NOT NULL DEFAULT 0"); } catch { /* exists */ }
  try { await db.execute("ALTER TABLE servers ADD COLUMN restart_warn_minutes INTEGER NOT NULL DEFAULT 5"); } catch { /* exists */ }
  try { await db.execute("ALTER TABLE servers ADD COLUMN restart_message TEXT NOT NULL DEFAULT 'Server restarting in {time}.'"); } catch { /* exists */ }
  try { await db.execute("ALTER TABLE servers ADD COLUMN restart_cancel_message TEXT NOT NULL DEFAULT 'Restart has been canceled.'"); } catch { /* exists */ }
  try { await db.execute("ALTER TABLE servers ADD COLUMN update_warn_players INTEGER NOT NULL DEFAULT 0"); } catch { /* exists */ }
  try { await db.execute("ALTER TABLE servers ADD COLUMN update_warn_minutes INTEGER NOT NULL DEFAULT 5"); } catch { /* exists */ }
  try { await db.execute("ALTER TABLE servers ADD COLUMN update_message TEXT NOT NULL DEFAULT 'Server going down for update in {time}.'"); } catch { /* exists */ }
  try { await db.execute("ALTER TABLE servers ADD COLUMN update_cancel_message TEXT NOT NULL DEFAULT 'Update has been canceled.'"); } catch { /* exists */ }

  // Reset partial "updating" status — the update did not complete and must be re-triggered.
  // update_available remains 1 so the badge shows.
  // startup_queued and update_queued are intentionally preserved — StartupRecoveryManager
  // detects them on launch and re-queues them automatically.
  await db.execute(
    "UPDATE servers SET status = 'stopped' WHERE status = 'updating'"
  );

  // ── Migration 006: server stats history tables ────────────────────────────
  // Raw 60-second samples retained for 30 days; rolled up to daily after that.
  await db.execute(`CREATE TABLE IF NOT EXISTS server_stats_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   TEXT    NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    sampled_at  INTEGER NOT NULL,
    cpu_pct     REAL,
    mem_mb      REAL,
    players     INTEGER
  )`);
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_stats_history_server_time ON server_stats_history(server_id, sampled_at)"
  );

  // Daily avg + max aggregates retained for 1 year.
  await db.execute(`CREATE TABLE IF NOT EXISTS server_stats_daily (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   TEXT    NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    day_ts      INTEGER NOT NULL,
    avg_cpu     REAL,
    max_cpu     REAL,
    avg_mem     REAL,
    max_mem     REAL,
    avg_players REAL,
    max_players INTEGER,
    UNIQUE(server_id, day_ts)
  )`);
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_stats_daily_server_day ON server_stats_daily(server_id, day_ts)"
  );

  // ── Migration 008: backup system v2 ──────────────────────────────────────
  try { await db.execute("ALTER TABLE backups ADD COLUMN backup_type TEXT NOT NULL DEFAULT 'server'"); } catch { /* exists */ }
  try { await db.execute("ALTER TABLE backups ADD COLUMN tiers TEXT NOT NULL DEFAULT ''"); } catch { /* exists */ }
  try { await db.execute("ALTER TABLE backups ADD COLUMN player_eosid TEXT"); } catch { /* exists */ }
  try { await db.execute("ALTER TABLE backups ADD COLUMN player_name TEXT"); } catch { /* exists */ }
  await db.execute(`CREATE TABLE IF NOT EXISTS player_name_map (
    server_id   TEXT NOT NULL,
    eos_id      TEXT NOT NULL,
    player_name TEXT NOT NULL,
    last_seen   TEXT NOT NULL,
    PRIMARY KEY (server_id, eos_id)
  )`);
  // Rename old generic "backup" schedule rows to the new typed name.
  await db.execute("UPDATE schedules SET schedule_type = 'backup_server' WHERE schedule_type = 'backup'");
  try { await db.execute("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('full_backup_warning_dismissed', 'false')"); } catch { /* exists */ }

  // ── Migration 009: firewall rule tracking ────────────────────────────────
  // Tracks ports we have opened in the system firewall (iptables fallback).
  // UFW and firewalld derive state from the system directly; this table is
  // used as a fallback when the live firewall state cannot be read without root.
  await db.execute(`CREATE TABLE IF NOT EXISTS firewall_rules (
    port     INTEGER NOT NULL,
    protocol TEXT    NOT NULL CHECK(protocol IN ('tcp', 'udp')),
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (port, protocol)
  )`);

  // ── Migration 010: player connection history ─────────────────────────────
  await db.execute(`CREATE TABLE IF NOT EXISTS player_connections (
    id           TEXT PRIMARY KEY,
    server_id    TEXT NOT NULL,
    eos_id       TEXT NOT NULL,
    ip_address   TEXT NOT NULL,
    connected_at DATETIME NOT NULL
  )`);
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_player_connections_server_eos ON player_connections(server_id, eos_id)"
  );
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_player_connections_ip ON player_connections(server_id, ip_address)"
  );

  // ── Migration 011: fix hourly backup cron (was every 6h, now every 1h) ───
  await db.execute(
    "UPDATE schedules SET cron_expression = '0 * * * *' WHERE schedule_type IN ('backup_server','backup_player') AND cron_expression = '0 */6 * * *'"
  );

  // ── Migration 012: consolidate per-tier schedule rows into single rows ────
  // Old format: up to 4 rows per (server, type) each with { tier: "H"|"D"|"W"|"M", keep: N }
  // New format: 1 row per (server, type) with all tiers in config_json:
  //   { hourly: { enabled, keep }, daily: { enabled, keep }, weekly: { enabled, keep }, monthly: { enabled, keep } }
  {
    const done = await db.select<{ value: string }[]>(
      "SELECT value FROM app_settings WHERE key = 'migration_012_done'"
    );
    if (!done.length || done[0]?.value !== "true") {
      type OldRow = { id: string; server_id: string; schedule_type: string; config_json: string; enabled: number };
      const rows = await db.select<OldRow[]>(
        "SELECT id, server_id, schedule_type, config_json, enabled FROM schedules WHERE schedule_type IN ('backup_server','backup_player') ORDER BY rowid ASC"
      );

      const groups = new Map<string, OldRow[]>();
      for (const row of rows) {
        const key = `${row.server_id}:${row.schedule_type}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(row);
      }

      const tierMap: Record<string, string> = { H: "hourly", D: "daily", W: "weekly", M: "monthly" };
      const keepDefaults: Record<string, number> = { hourly: 24, daily: 7, weekly: 4, monthly: 3 };

      for (const [, groupRows] of groups) {
        const merged: Record<string, { enabled: boolean; keep: number }> = {
          hourly:  { enabled: false, keep: keepDefaults.hourly },
          daily:   { enabled: false, keep: keepDefaults.daily },
          weekly:  { enabled: false, keep: keepDefaults.weekly },
          monthly: { enabled: false, keep: keepDefaults.monthly },
        };

        let needsUpdate = false;
        for (const row of groupRows) {
          try {
            const cfg = JSON.parse(row.config_json ?? "{}") as Record<string, unknown>;
            if (typeof cfg.tier === "string") {
              // Old single-tier format
              needsUpdate = true;
              const key = tierMap[(cfg.tier as string).toUpperCase()];
              if (key) {
                merged[key] = {
                  enabled: row.enabled === 1,
                  keep: typeof cfg.keep === "number" && cfg.keep > 0 ? cfg.keep : keepDefaults[key],
                };
              }
            } else if (cfg.hourly !== undefined || cfg.daily !== undefined || cfg.weekly !== undefined || cfg.monthly !== undefined) {
              // Already new format — still merge in case of multiple new-format rows
              for (const k of ["hourly", "daily", "weekly", "monthly"]) {
                const tc = cfg[k] as { enabled?: boolean; keep?: number } | undefined;
                if (tc) merged[k] = { enabled: tc.enabled ?? false, keep: tc.keep ?? keepDefaults[k] };
              }
            }
          } catch { /* skip malformed rows */ }
        }

        if (!needsUpdate && groupRows.length <= 1) continue;

        const anyEnabled = Object.values(merged).some((v) => v.enabled);
        const cron = merged.hourly.enabled ? "0 * * * *"
                   : merged.daily.enabled  ? "0 2 * * *"
                   : merged.weekly.enabled ? "0 3 * * 0"
                   : "0 4 1 * *";

        await db.execute(
          "UPDATE schedules SET config_json = ?, cron_expression = ?, enabled = ? WHERE id = ?",
          [JSON.stringify(merged), cron, anyEnabled ? 1 : 0, groupRows[0].id]
        );

        for (const row of groupRows.slice(1)) {
          await db.execute("DELETE FROM schedules WHERE id = ?", [row.id]);
        }
      }

      await db.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('migration_012_done', 'true')"
      );
    }
  }

  // ── Migration 013: convert ancient {"retention":N} backup config to tier format ──
  // Pre-tier-system rows had { "retention": N } with no hourly/daily/weekly/monthly keys.
  // Convert them so the new hourly backup tick can handle them correctly.
  {
    const done = await db.select<{ value: string }[]>(
      "SELECT value FROM app_settings WHERE key = 'migration_013_done'"
    );
    if (!done.length || done[0]?.value !== "true") {
      type Row = { id: string; config_json: string };
      const rows = await db.select<Row[]>(
        "SELECT id, config_json FROM schedules WHERE schedule_type IN ('backup_server','backup_player','backup_full')"
      );
      for (const row of rows) {
        try {
          const cfg = JSON.parse(row.config_json ?? "{}") as Record<string, unknown>;
          if (cfg.retention !== undefined && cfg.hourly === undefined) {
            const keep = typeof cfg.retention === "number" && cfg.retention > 0
              ? cfg.retention : 24;
            const newCfg = {
              hourly:  { enabled: true,  keep },
              daily:   { enabled: false, keep: 7 },
              weekly:  { enabled: false, keep: 4 },
              monthly: { enabled: false, keep: 3 },
            };
            await db.execute(
              "UPDATE schedules SET config_json = ?, cron_expression = '0 * * * *' WHERE id = ?",
              [JSON.stringify(newCfg), row.id]
            );
          }
        } catch { /* skip malformed */ }
      }
      await db.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('migration_013_done', 'true')"
      );
    }
  }

  // ── Migration 015: build version cache + per-server installed_build_id ─────
  // build_version_cache: maps Steam build IDs to human-readable version strings
  //   (e.g. "49.23"). Populated lazily: "internet" source comes from the Steam
  //   News API right after a cache update; "server" source from A2S_INFO when
  //   the server actually starts. "server" always wins over "internet".
  // installed_build_id: the build ID currently installed at this server's path,
  //   populated by Rust on install/update.
  await db.execute(`CREATE TABLE IF NOT EXISTS build_version_cache (
    build_id     TEXT PRIMARY KEY,
    game_version TEXT,
    source       TEXT NOT NULL DEFAULT 'internet',
    fetched_at   INTEGER NOT NULL DEFAULT 0
  )`);
  try {
    await db.execute("ALTER TABLE servers ADD COLUMN installed_build_id TEXT");
  } catch { /* already exists */ }

  // ── Migration 016: save folder name for -SaveDirectoryOverride ─────────────
  try {
    await db.execute("ALTER TABLE servers ADD COLUMN save_folder_name TEXT NOT NULL DEFAULT ''");
  } catch { /* already exists */ }

  // ── Migration 017: active event id (null = no event) ──────────────────────
  try {
    await db.execute("ALTER TABLE servers ADD COLUMN active_event TEXT");
  } catch { /* already exists */ }

  // ── Migration 018: memory limit restart + backup broadcast message ─────────
  try { await db.execute("ALTER TABLE servers ADD COLUMN memory_limit_gb REAL"); } catch { /* exists */ }
  try { await db.execute("ALTER TABLE servers ADD COLUMN backup_broadcast_message TEXT NOT NULL DEFAULT 'Server backup in progress — lag may occur.'"); } catch { /* exists */ }

  // ── Migration 019: user-defined custom mod maps ──────────────────────────
  await db.execute(`CREATE TABLE IF NOT EXISTS custom_maps (
    id          TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    mod_id       TEXT NOT NULL,
    map_path     TEXT NOT NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // ── Migration 020: drop rcon_password — admin_password is now the single
  // source of truth for both RCON auth and ServerAdminPassword. The two used
  // to drift apart (rcon_password was set once at creation/import and never
  // touched again), which silently broke RCON whenever the admin password
  // changed. No data needs to be copied first: admin_password already holds
  // the correct value for every server (set at creation/import from the real
  // password), while rcon_password could be stale or, for imported servers, a
  // random placeholder that never matched the real password at all.
  try {
    await db.execute("ALTER TABLE servers DROP COLUMN rcon_password");
  } catch { /* already dropped, or pre-existing DB without the column */ }

  // ── Migration 021: move custom mod sections from Game.ini to GameUserSettings.ini ──
  // The Mod Settings editor used to write custom [ModName] sections into
  // Game.ini, which most mods never actually read their config from — ASA mods
  // read custom sections from GameUserSettings.ini. Move any previously-saved
  // custom sections over so existing configs aren't silently ignored by mods.
  {
    const done = await db.select<{ value: string }[]>(
      "SELECT value FROM app_settings WHERE key = 'migration_021_done'"
    );
    if (!done.length || done[0]?.value !== "true") {
      const GAME_INI_STANDARD_SECTIONS = new Set(["/script/shootergame.shootergamemode"]);
      type Row = { server_id: string; game_ini_json: string; game_user_settings_json: string };
      const rows = await db.select<Row[]>(
        "SELECT server_id, game_ini_json, game_user_settings_json FROM server_config"
      );
      for (const row of rows) {
        try {
          const gameIni = JSON.parse(row.game_ini_json ?? "{}") as Record<string, Record<string, string>>;
          const gus = JSON.parse(row.game_user_settings_json ?? "{}") as Record<string, Record<string, string>>;
          const customKeys = Object.keys(gameIni).filter(
            (k) => !GAME_INI_STANDARD_SECTIONS.has(k.toLowerCase())
          );
          if (customKeys.length === 0) continue;

          for (const key of customKeys) {
            gus[key] = { ...(gus[key] ?? {}), ...gameIni[key] };
            delete gameIni[key];
          }
          await db.execute(
            "UPDATE server_config SET game_ini_json = ?, game_user_settings_json = ? WHERE server_id = ?",
            [JSON.stringify(gameIni), JSON.stringify(gus), row.server_id]
          );
        } catch { /* skip malformed */ }
      }
      await db.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('migration_021_done', 'true')"
      );
    }
  }

  // ── Migration 022: drop server_uptime_sessions — dead feature, never wired
  // up to any UI (no reader or writer anywhere in the app). DROP is
  // naturally idempotent, no done-flag needed.
  await db.execute("DROP TABLE IF EXISTS server_uptime_sessions");
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
  max_players: number;
  server_password: string | null;
  /** ServerAdminPassword — single source of truth for both the INI value and RCON auth. */
  admin_password: string;
  cluster_id: string | null;
  preset_id: string | null;
  status: string;
  pid: number | null;
  update_available: number;       // 0 | 1 — set by global update check
  update_automation_json: string; // UpdateAutomation JSON blob
  shutdown_warn_players: number;     // 0 | 1
  shutdown_warn_minutes: number;     // default 5
  shutdown_message: string;          // template with {time} placeholder
  restart_warn_players: number;      // 0 | 1
  restart_warn_minutes: number;      // default 5
  restart_message: string;           // template with {time} placeholder
  restart_cancel_message: string;
  update_warn_players: number;       // 0 | 1
  update_warn_minutes: number;       // default 5
  update_message: string;            // template with {time} placeholder
  update_cancel_message: string;
  auto_start: number;                // 0 | 1 — always start on app launch
  installed_build_id: string | null; // populated by Rust on install/update
  save_folder_name: string;          // legacy column — no longer used; kept for schema compatibility
  active_event: string | null;       // ARK event id (e.g. "FearEvolved"); null = no active event
  memory_limit_gb: number | null;    // restart server if RAM exceeds this; null = disabled
  backup_broadcast_message: string;  // RCON broadcast sent before each scheduled backup
  created_at: string;
  updated_at: string;
}

export interface BuildVersionRow {
  build_id: string;
  game_version: string | null;
  source: string; // "internet" | "server"
}

export interface UpdateAutomation {
  mode: "off" | "immediately" | "at_time";
  update_time: string;   // "HH:MM" used when mode === "at_time"
  restart_after_update: boolean;
  only_if_running: boolean;
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
  maxPlayers: number;
  saveFolderName?: string;
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
       (id, name, map_id, install_path, port, query_port, rcon_port,
        max_players, server_password, admin_password, cluster_id, preset_id, status, save_folder_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped', ?)`,
    [
      input.id,
      input.name,
      input.mapId,
      input.installPath,
      input.port,
      input.queryPort,
      input.rconPort,
      input.maxPlayers,
      input.serverPassword ?? null,
      input.adminPassword,
      input.clusterId ?? null,
      input.presetId ?? null,
      input.saveFolderName ?? "",
    ]
  );
  return input.id;
}

/**
 * Update the stored ServerAdminPassword (used for both the INI value and RCON
 * auth). Called whenever ConfigTab saves a config that changed
 * ServerSettings.ServerAdminPassword, so the RCON connection never goes stale.
 */
export async function updateServerAdminPassword(id: string, adminPassword: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE servers SET admin_password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [adminPassword, id]
  );
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

/** Set the active ARK event for a server (null to clear). */
export async function setServerActiveEvent(id: string, eventId: string | null): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE servers SET active_event = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [eventId ?? null, id]
  );
}

export async function updateServerMemoryLimit(id: string, limitGb: number | null): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE servers SET memory_limit_gb = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [limitGb ?? null, id]
  );
}

export async function updateBackupBroadcastMessage(id: string, message: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE servers SET backup_broadcast_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [message, id]
  );
}

export async function updateServerMap(id: string, mapId: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE servers SET map_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [mapId, id]
  );
}

/** Set the update_available flag for a single server. */
export async function setServerUpdateAvailable(
  id: string,
  available: boolean
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE servers SET update_available = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [available ? 1 : 0, id]
  );
}

export async function setServerInstalledBuild(id: string, buildId: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE servers SET installed_build_id = ? WHERE id = ?",
    [buildId, id]
  );
}

/** Read/write per-server update automation settings. */
export async function setServerUpdateAutomation(
  id: string,
  automation: import("./db").UpdateAutomation
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE servers SET update_automation_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [JSON.stringify(automation), id]
  );
}

export async function updateServerShutdownSettings(
  id: string,
  warnPlayers: boolean,
  warnMinutes: number,
  message: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE servers SET shutdown_warn_players = ?, shutdown_warn_minutes = ?, shutdown_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [warnPlayers ? 1 : 0, warnMinutes, message, id]
  );
}

export async function updateServerRestartSettings(
  id: string,
  warnPlayers: boolean,
  warnMinutes: number,
  message: string,
  cancelMessage: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE servers SET restart_warn_players = ?, restart_warn_minutes = ?, restart_message = ?, restart_cancel_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [warnPlayers ? 1 : 0, warnMinutes, message, cancelMessage, id]
  );
}

export async function updateServerUpdateSettings(
  id: string,
  warnPlayers: boolean,
  warnMinutes: number,
  message: string,
  cancelMessage: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE servers SET update_warn_players = ?, update_warn_minutes = ?, update_message = ?, update_cancel_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [warnPlayers ? 1 : 0, warnMinutes, message, cancelMessage, id]
  );
}

/** Set the auto_start flag for a server. */
export async function setServerAutoStart(id: string, autoStart: boolean): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE servers SET auto_start = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [autoStart ? 1 : 0, id]
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
  /** 1 if this mod is required by the server's map and cannot be removed without changing the map. */
  locked_by_map: number;
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
  thumbnailUrl?: string | null,
  lockedByMap?: boolean
): Promise<void> {
  const db = await getDb();
  const rows = await db.select<{ max_order: number | null }[]>(
    "SELECT MAX(install_order) as max_order FROM server_mods WHERE server_id = ?",
    [serverId]
  );
  const nextOrder = (rows[0]?.max_order ?? -1) + 1;
  const id = crypto.randomUUID();
  await db.execute(
    `INSERT OR IGNORE INTO server_mods
       (id, server_id, mod_id, mod_name, mod_thumbnail_url, install_order, enabled, locked_by_map)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    [id, serverId, modId, modName, thumbnailUrl ?? null, nextOrder, lockedByMap ? 1 : 0]
  );
}

/** Update the locked_by_map flag on an existing mod entry. */
export async function setModMapLock(
  serverId: string,
  modId: string,
  locked: boolean
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE server_mods SET locked_by_map = ? WHERE server_id = ? AND mod_id = ?",
    [locked ? 1 : 0, serverId, modId]
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

/** Copy all mods from sourceServerId to targetServerId. Skips duplicates. */
export async function copyServerMods(sourceServerId: string, targetServerId: string): Promise<void> {
  const sourceMods = await getServerMods(sourceServerId);
  for (const mod of sourceMods) {
    await addServerMod(targetServerId, mod.mod_id, mod.mod_name);
    if (mod.locked_by_map) {
      await setModMapLock(targetServerId, mod.mod_id, true);
    }
  }
}

/** Copy the server config (INI + launch args) from sourceServerId to targetServerId. */
export async function copyServerConfig(sourceServerId: string, targetServerId: string): Promise<void> {
  const src = await getServerConfig(sourceServerId);
  if (!src) return;
  await saveServerConfig(
    targetServerId,
    src.game_user_settings_json,
    src.game_ini_json,
    src.launch_args_json,
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
  /** manual | schedule | pre_update | pre_restart | config_save */
  triggered_by: string;
  created_at: string;
  /** server | player | full | ini */
  backup_type: string;
  /** Comma-separated tier flags: H, D, W, M — or empty for manual/full */
  tiers: string;
  player_eosid: string | null;
  player_name: string | null;
}

/** Insert a backup record. */
export async function insertBackup(record: BackupRow): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO backups
      (id, server_id, file_path, file_size_bytes, map_id, triggered_by, created_at,
       backup_type, tiers, player_eosid, player_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.server_id,
      record.file_path,
      record.file_size_bytes,
      record.map_id,
      record.triggered_by,
      record.created_at,
      record.backup_type ?? 'server',
      record.tiers ?? '',
      record.player_eosid ?? null,
      record.player_name ?? null,
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

/** Fetch backups for a server filtered by type, newest first. */
export async function getServerBackupsByType(
  serverId: string,
  backupType: string
): Promise<BackupRow[]> {
  const db = await getDb();
  return db.select<BackupRow[]>(
    "SELECT * FROM backups WHERE server_id = ? AND backup_type = ? ORDER BY created_at DESC",
    [serverId, backupType]
  );
}

/** Fetch all backups across every server, newest first (used by global /backups page). */
export async function getAllBackups(): Promise<BackupRow[]> {
  const db = await getDb();
  return db.select<BackupRow[]>(
    "SELECT * FROM backups ORDER BY created_at DESC"
  );
}

/** Fetch all player backups for a specific EOS ID on a server. */
export async function getPlayerBackups(
  serverId: string,
  eosId: string
): Promise<BackupRow[]> {
  const db = await getDb();
  return db.select<BackupRow[]>(
    "SELECT * FROM backups WHERE server_id = ? AND player_eosid = ? ORDER BY created_at DESC",
    [serverId, eosId]
  );
}

/** Update the tier flags on an existing backup (for TimeShift promotion). */
export async function updateBackupTiers(backupId: string, tiers: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE backups SET tiers = ? WHERE id = ?", [tiers, backupId]);
}

/** Remove a backup record from the database (after the file has been deleted). */
export async function deleteBackupRecord(backupId: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM backups WHERE id = ?", [backupId]);
}

/**
 * Prune manual backups for a server+type down to `keep` most recent.
 * Called after every manual backup insertion.
 */
export async function pruneManualBackups(
  serverId: string,
  backupType: string,
  keep: number,
): Promise<void> {
  if (keep <= 0) return;
  const db = await getDb();
  const rows = await db.select<{ id: string; file_path: string }[]>(
    `SELECT id, file_path FROM backups
     WHERE server_id = ? AND backup_type = ? AND triggered_by = 'manual'
     ORDER BY created_at DESC`,
    [serverId, backupType],
  );
  const toDelete = rows.slice(keep);
  for (const row of toDelete) {
    await import("@/lib/tauri-commands").then(({ tauriCmd }) =>
      tauriCmd.deleteBackup(row.file_path).catch(() => {})
    );
    await db.execute("DELETE FROM backups WHERE id = ?", [row.id]);
  }
}

// ---------------------------------------------------------------------------
// Player name map
// ---------------------------------------------------------------------------

/** Bulk upsert multiple players from a listplayers result. */
export async function upsertPlayerNames(
  serverId: string,
  players: { eosId: string; name: string }[]
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  for (const p of players) {
    await db.execute(
      `INSERT INTO player_name_map (server_id, eos_id, player_name, last_seen)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(server_id, eos_id) DO UPDATE SET player_name = excluded.player_name, last_seen = excluded.last_seen`,
      [serverId, p.eosId, p.name, now]
    );
  }
}

/** Return an eosId → playerName map for a server. */
export async function getPlayerNameMap(serverId: string): Promise<Record<string, string>> {
  const db = await getDb();
  const rows = await db.select<{ eos_id: string; player_name: string }[]>(
    "SELECT eos_id, player_name FROM player_name_map WHERE server_id = ?",
    [serverId]
  );
  return Object.fromEntries(rows.map((r) => [r.eos_id, r.player_name]));
}

/** Return all known players for a server (for the player backup browser). */
export async function getKnownPlayers(
  serverId: string
): Promise<{ eosId: string; playerName: string; lastSeen: string }[]> {
  const db = await getDb();
  const rows = await db.select<{ eos_id: string; player_name: string; last_seen: string }[]>(
    "SELECT eos_id, player_name, last_seen FROM player_name_map WHERE server_id = ? ORDER BY last_seen DESC",
    [serverId]
  );
  return rows.map((r) => ({ eosId: r.eos_id, playerName: r.player_name, lastSeen: r.last_seen }));
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

/** If next_run is in the past (stale), recompute the next occurrence from the cron expression. */
function resolveNextRun(nextRun: string | null, cronExpr: string | null): string | null {
  if (nextRun) {
    const ms = new Date(nextRun).getTime();
    if (!isNaN(ms) && ms > Date.now()) return nextRun;
  }
  if (!cronExpr) return nextRun;
  try {
    const next = CronExpressionParser.parse(cronExpr).next().toDate();
    return next.toISOString();
  } catch {
    return nextRun;
  }
}

/** Return the next_run ISO timestamp for the restart/update schedule, or null. */
export async function getNextScheduledRestart(serverId: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ next_run: string | null; cron_expression: string | null }[]>(
    `SELECT next_run, cron_expression FROM schedules
     WHERE server_id = ? AND schedule_type IN ('restart', 'update') AND enabled = 1
     ORDER BY next_run ASC LIMIT 1`,
    [serverId]
  );
  if (!rows[0]) return null;
  return resolveNextRun(rows[0].next_run, rows[0].cron_expression);
}

/** Return true if any backup schedule row is enabled and has at least one tier active. */
export async function getHasBackupEnabled(serverId: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<{ config_json: string }[]>(
    `SELECT config_json FROM schedules
     WHERE server_id = ? AND schedule_type IN ('backup_server', 'backup_player', 'backup_full') AND enabled = 1`,
    [serverId]
  );
  return rows.some((row) => {
    try {
      const cfg = JSON.parse(row.config_json ?? "{}") as Record<string, unknown>;
      return Object.values(cfg).some(
        (v) => typeof v === "object" && v !== null && (v as { enabled?: boolean }).enabled === true
      );
    } catch { return false; }
  });
}

// ---------------------------------------------------------------------------
// Player connections
// ---------------------------------------------------------------------------

export interface PlayerConnectionRow {
  id: string;
  server_id: string;
  eos_id: string;
  ip_address: string;
  connected_at: string;
}

export async function insertPlayerConnection(
  serverId: string,
  eosId: string,
  ip: string
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT INTO player_connections (id, server_id, eos_id, ip_address, connected_at) VALUES (?, ?, ?, ?, datetime('now'))",
    [crypto.randomUUID(), serverId, eosId, ip]
  );
}

/** All unique IPs a player has connected from, most recently seen first. */
export async function getPlayerKnownIps(
  serverId: string,
  eosId: string
): Promise<{ ip: string; lastSeen: string }[]> {
  const db = await getDb();
  return db.select<{ ip: string; lastSeen: string }[]>(
    `SELECT ip_address AS ip, MAX(connected_at) AS lastSeen
     FROM player_connections
     WHERE server_id = ? AND eos_id = ?
     GROUP BY ip_address
     ORDER BY lastSeen DESC`,
    [serverId, eosId]
  );
}

/** Full connection history for a player, newest first (capped at 200 for display). */
export async function getPlayerConnectionHistory(
  serverId: string,
  eosId: string,
  limit = 200
): Promise<PlayerConnectionRow[]> {
  const db = await getDb();
  return db.select<PlayerConnectionRow[]>(
    "SELECT * FROM player_connections WHERE server_id = ? AND eos_id = ? ORDER BY connected_at DESC LIMIT ?",
    [serverId, eosId, limit]
  );
}

/** Other EOS IDs that have connected from any of the same IPs as this player. */
export async function getPossibleAlts(
  serverId: string,
  eosId: string
): Promise<{ eosId: string; sharedIps: string[] }[]> {
  const db = await getDb();
  const rows = await db.select<{ eos_id: string; ip_address: string }[]>(
    `SELECT DISTINCT p2.eos_id, p2.ip_address
     FROM player_connections p1
     JOIN player_connections p2
       ON p1.server_id = p2.server_id AND p1.ip_address = p2.ip_address
     WHERE p1.server_id = ? AND p1.eos_id = ? AND p2.eos_id != ?
     ORDER BY p2.eos_id`,
    [serverId, eosId, eosId]
  );
  const map = new Map<string, string[]>();
  for (const r of rows) {
    if (!map.has(r.eos_id)) map.set(r.eos_id, []);
    map.get(r.eos_id)!.push(r.ip_address);
  }
  return [...map.entries()].map(([id, ips]) => ({ eosId: id, sharedIps: [...new Set(ips)] }));
}

/** Update the file_path for a backup record (used after tier-rename on disk). */
export async function updateBackupFilePath(
  backupId: string,
  newFilePath: string
): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE backups SET file_path = ? WHERE id = ?", [newFilePath, backupId]);
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
  /** 0 = unread (shows in bell), 1 = pre-read (archived silently). Default 0. */
  read?: 0 | 1;
}

/** Insert a new notification into the in_app_notifications log. */
export async function logNotification(input: LogNotificationInput): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO in_app_notifications (id, server_id, event_type, title, body, severity, read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.id, input.serverId ?? null, input.eventType, input.title, input.body, input.severity, input.read ?? 0, new Date().toISOString()]
  );
}

export interface GetNotificationsFilter {
  serverId?: string | null;
  unreadOnly?: boolean;
  eventType?: string;
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
  if (filter.eventType) {
    conditions.push("event_type = ?");
    params.push(filter.eventType);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;

  // created_at only has millisecond resolution, so a burst of notifications
  // logged in the same millisecond (common during bulk operations like
  // "Update All") tie on the primary sort key — rowid (insertion order) as a
  // tiebreaker keeps the list deterministically newest-first instead of
  // falling back to whatever order SQLite happens to return ties in.
  return db.select<InAppNotificationRow[]>(
    `SELECT * FROM in_app_notifications ${where}
     ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
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

/** Delete a single notification by id. */
export async function deleteNotification(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM in_app_notifications WHERE id = ?", [id]);
}

export interface PruneNotificationsFilter {
  /** Max age in days. Omit (or 0) to delete regardless of age. */
  days?: number;
  /** If set, only delete rows matching this severity. */
  severity?: string;
  /** If set, only delete rows matching this event_type. */
  eventType?: string;
}

/** Bulk-delete notifications with optional age + severity + event type filters. */
export async function pruneNotificationsWithFilter(
  filter: PruneNotificationsFilter
): Promise<void> {
  const db = await getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.days && filter.days > 0) {
    conditions.push(`created_at < datetime('now', '-' || ? || ' days')`);
    params.push(filter.days);
  }
  if (filter.severity) {
    conditions.push("severity = ?");
    params.push(filter.severity);
  }
  if (filter.eventType) {
    conditions.push("event_type = ?");
    params.push(filter.eventType);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  await db.execute(`DELETE FROM in_app_notifications ${where}`, params);
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

/** Upsert a notification config (insert or update on id conflict).
 *  Pre-looks up by (server_id, channel) to reuse the stable row id,
 *  avoiding the UNIQUE constraint error that occurs when ON CONFLICT targets
 *  the wrong column (SQLite checks PRIMARY KEY before composite constraints). */
export async function saveNotificationConfig(
  input: SaveNotificationConfigInput
): Promise<void> {
  const db = await getDb();
  // Find the existing row's id (if any) to reuse it, preventing a PK conflict.
  const existing = await db.select<{ id: string }[]>(
    "SELECT id FROM notification_configs WHERE server_id IS ? AND channel = ?",
    [input.serverId ?? null, input.channel]
  );
  const id = existing[0]?.id ?? input.id;
  await db.execute(
    `INSERT INTO notification_configs (id, server_id, channel, enabled, config_json, events_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       enabled     = excluded.enabled,
       config_json = excluded.config_json,
       events_json = excluded.events_json`,
    [
      id,
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

// ---------------------------------------------------------------------------
// Server Stats History
// ---------------------------------------------------------------------------

export interface ChartPoint {
  ts: number;
  cpu: number | null;
  cpuMax: number | null;
  mem: number | null;
  memMax: number | null;
  players: number | null;
  playersMax: number | null;
}

/** Insert a single raw stat sample for a server. */
export async function insertStatSample(
  serverId: string,
  cpuPct: number | null,
  memMb: number | null,
  players: number | null,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT INTO server_stats_history (server_id, sampled_at, cpu_pct, mem_mb, players) VALUES (?, ?, ?, ?, ?)",
    [serverId, Date.now(), cpuPct, memMb, players],
  );
}

/**
 * Query raw history table bucketed into ~120 display points.
 * bucketMs controls the grouping interval (e.g. 60_000 for 1-min buckets).
 */
export async function queryStatHistory(
  serverId: string,
  fromMs: number,
  bucketMs: number,
): Promise<ChartPoint[]> {
  const db = await getDb();
  const now = Date.now();
  type Row = {
    bucket_ts: number;
    avg_cpu: number | null;
    max_cpu: number | null;
    avg_mem: number | null;
    max_mem: number | null;
    avg_players: number | null;
    max_players: number | null;
  };
  const rows = await db.select<Row[]>(
    `SELECT
       (sampled_at / ?) * ? AS bucket_ts,
       AVG(cpu_pct)                            AS avg_cpu,
       MAX(cpu_pct)                            AS max_cpu,
       AVG(mem_mb)                             AS avg_mem,
       MAX(mem_mb)                             AS max_mem,
       ROUND(AVG(CAST(players AS REAL)))       AS avg_players,
       MAX(players)                            AS max_players
     FROM server_stats_history
     WHERE server_id = ? AND sampled_at >= ? AND sampled_at <= ?
     GROUP BY bucket_ts
     ORDER BY bucket_ts ASC`,
    [bucketMs, bucketMs, serverId, fromMs, now],
  );
  return rows.map((r) => ({
    ts: r.bucket_ts,
    cpu: r.avg_cpu,
    cpuMax: r.max_cpu,
    mem: r.avg_mem,
    memMax: r.max_mem,
    players: r.avg_players,
    playersMax: r.max_players,
  }));
}

/** Query the daily aggregate table for a date range. */
export async function queryStatDaily(
  serverId: string,
  fromMs: number,
): Promise<ChartPoint[]> {
  const db = await getDb();
  type Row = {
    day_ts: number;
    avg_cpu: number | null;
    max_cpu: number | null;
    avg_mem: number | null;
    max_mem: number | null;
    avg_players: number | null;
    max_players: number | null;
  };
  const rows = await db.select<Row[]>(
    `SELECT day_ts, avg_cpu, max_cpu, avg_mem, max_mem, avg_players, max_players
     FROM server_stats_daily
     WHERE server_id = ? AND day_ts >= ?
     ORDER BY day_ts ASC`,
    [serverId, fromMs],
  );
  return rows.map((r) => ({
    ts: r.day_ts,
    cpu: r.avg_cpu,
    cpuMax: r.max_cpu,
    mem: r.avg_mem,
    memMax: r.max_mem,
    players: r.avg_players,
    playersMax: r.max_players,
  }));
}

/**
 * Roll up raw history rows older than 30 days into server_stats_daily,
 * then delete the raw rows. Also prunes daily rows older than 1 year.
 */
export async function rollupOldStats(): Promise<void> {
  const db = await getDb();
  const cutoff30d = Date.now() - 30 * 24 * 60 * 60_000;
  const cutoff1y  = Date.now() - 365 * 24 * 60 * 60_000;

  type AggRow = {
    server_id: string;
    day_ts: number;
    avg_cpu: number | null;
    max_cpu: number | null;
    avg_mem: number | null;
    max_mem: number | null;
    avg_players: number | null;
    max_players: number | null;
  };

  const rows = await db.select<AggRow[]>(
    `SELECT
       server_id,
       (sampled_at / 86400000) * 86400000      AS day_ts,
       AVG(cpu_pct)                             AS avg_cpu,
       MAX(cpu_pct)                             AS max_cpu,
       AVG(mem_mb)                              AS avg_mem,
       MAX(mem_mb)                              AS max_mem,
       ROUND(AVG(CAST(players AS REAL)))        AS avg_players,
       MAX(players)                             AS max_players
     FROM server_stats_history
     WHERE sampled_at < ?
     GROUP BY server_id, day_ts`,
    [cutoff30d],
  );

  for (const row of rows) {
    await db.execute(
      `INSERT OR REPLACE INTO server_stats_daily
         (server_id, day_ts, avg_cpu, max_cpu, avg_mem, max_mem, avg_players, max_players)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.server_id, row.day_ts, row.avg_cpu, row.max_cpu, row.avg_mem, row.max_mem, row.avg_players, row.max_players],
    );
  }

  await db.execute("DELETE FROM server_stats_history WHERE sampled_at < ?", [cutoff30d]);
  await db.execute("DELETE FROM server_stats_daily WHERE day_ts < ?", [cutoff1y]);
}

/** Get a single global (server_id IS NULL) notification config by channel. */
export async function getGlobalChannelConfig(
  channel: string
): Promise<NotificationConfigRow | null> {
  const db = await getDb();
  const rows = await db.select<NotificationConfigRow[]>(
    "SELECT * FROM notification_configs WHERE server_id IS NULL AND channel = ? LIMIT 1",
    [channel]
  );
  return rows[0] ?? null;
}

/** Upsert just the events_json for a global channel config. Creates the row if missing.
 *  Bell and desktop channels are enabled by default (no credential setup required).
 *  Discord and email preserve their existing enabled state (set by the credential card). */
export async function saveGlobalChannelEvents(
  channel: string,
  events: string[]
): Promise<void> {
  const existing = await getGlobalChannelConfig(channel);
  const defaultEnabled = channel === "bell" || channel === "desktop";
  await saveNotificationConfig({
    id: existing?.id ?? crypto.randomUUID(),
    serverId: null,
    channel,
    enabled: existing != null ? existing.enabled === 1 : defaultEnabled,
    configJson: existing?.config_json ?? "{}",
    eventsJson: JSON.stringify(events),
  });
}

// ---------------------------------------------------------------------------
// Firewall rules (iptables fallback state)
// ---------------------------------------------------------------------------

export async function getFirewallRules(): Promise<{ port: number; protocol: string }[]> {
  const db = await getDb();
  return db.select<{ port: number; protocol: string }[]>(
    "SELECT port, protocol FROM firewall_rules ORDER BY port, protocol"
  );
}

export async function addFirewallRule(port: number, protocol: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT OR IGNORE INTO firewall_rules (port, protocol) VALUES (?, ?)",
    [port, protocol]
  );
}

export async function removeFirewallRule(port: number, protocol: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM firewall_rules WHERE port = ? AND protocol = ?",
    [port, protocol]
  );
}

// ---------------------------------------------------------------------------
// build_version_cache
// ---------------------------------------------------------------------------

export async function getBuildVersionCache(): Promise<Map<string, BuildVersionRow>> {
  const db = await getDb();
  const rows = await db.select<BuildVersionRow[]>(
    "SELECT build_id, game_version, source FROM build_version_cache"
  );
  return new Map(rows.map((r) => [r.build_id, r]));
}

/** Format a build ID + optional version into a display string.
 *  Known version:  "V49.23 (23691984)"
 *  Unknown:        "Build 23691984"
 *  No build ID:    "—"
 */
export function formatServerVersion(
  installedBuildId: string | null | undefined,
  versionCache: Map<string, BuildVersionRow>
): string {
  if (!installedBuildId) return "—";
  const entry = versionCache.get(installedBuildId);
  if (entry?.game_version) return `V${entry.game_version} (${installedBuildId})`;
  return `Build ${installedBuildId}`;
}

// ---------------------------------------------------------------------------
// custom_maps
// ---------------------------------------------------------------------------

export interface CustomMapRow {
  id: string;
  display_name: string;
  mod_id: string;
  map_path: string;
  created_at: string;
}

export async function getCustomMaps(): Promise<CustomMapRow[]> {
  const db = await getDb();
  return db.select<CustomMapRow[]>(
    "SELECT id, display_name, mod_id, map_path, created_at FROM custom_maps ORDER BY created_at ASC"
  );
}

export async function insertCustomMap(
  id: string,
  displayName: string,
  modId: string,
  mapPath: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT INTO custom_maps (id, display_name, mod_id, map_path) VALUES (?, ?, ?, ?)",
    [id, displayName, modId, mapPath],
  );
}

export async function updateCustomMap(
  id: string, displayName: string, modId: string, mapPath: string
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE custom_maps SET display_name = ?, mod_id = ?, map_path = ? WHERE id = ?",
    [displayName, modId, mapPath, id]
  );
}

export async function deleteCustomMap(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM custom_maps WHERE id = ?", [id]);
}
