-- Migration 001: Initial schema for LokiASAM
-- Creates all core tables for server management.

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ---------------------------------------------------------------------------
-- servers: one row per managed ASA server instance
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS servers (
  id                TEXT PRIMARY KEY,            -- UUID v4
  name              TEXT NOT NULL UNIQUE,
  map_id            TEXT NOT NULL,               -- references ARK_MAPS[].id in game-data.ts
  install_path      TEXT NOT NULL,               -- absolute path to server install dir
  port              INTEGER NOT NULL DEFAULT 7777,
  query_port        INTEGER NOT NULL DEFAULT 27015,
  rcon_port         INTEGER NOT NULL DEFAULT 27020,
  rcon_password     TEXT NOT NULL DEFAULT '',
  max_players       INTEGER NOT NULL DEFAULT 70,
  server_password   TEXT,
  admin_password    TEXT NOT NULL DEFAULT '',
  cluster_id        TEXT,                        -- NULL if standalone, FK to clusters.id
  preset_id         TEXT,                        -- preset used at creation (from SERVER_PRESETS)
  -- Runtime state (updated by Rust backend, not persisted across restarts)
  status            TEXT NOT NULL DEFAULT 'stopped',
  pid               INTEGER,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- server_config: serialized GameUserSettings.ini and Game.ini values
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS server_config (
  server_id              TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  game_user_settings_json TEXT NOT NULL DEFAULT '{}',
  game_ini_json          TEXT NOT NULL DEFAULT '{}',
  launch_args_json       TEXT NOT NULL DEFAULT '{}',
  updated_at             DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- server_mods: mods attached to a server
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS server_mods (
  id               TEXT PRIMARY KEY,
  server_id        TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  mod_id           TEXT NOT NULL,                -- CurseForge / Steam Workshop mod ID
  mod_name         TEXT NOT NULL,
  mod_thumbnail_url TEXT,
  install_order    INTEGER NOT NULL DEFAULT 0,   -- lower = loaded first
  enabled          INTEGER NOT NULL DEFAULT 1,   -- 0 = disabled, 1 = enabled
  added_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(server_id, mod_id)
);

-- ---------------------------------------------------------------------------
-- clusters: ASA cross-ARK cluster groups
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clusters (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  cluster_dir_override TEXT,                     -- NULL = use default path
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Add FK from servers.cluster_id → clusters.id (SQLite doesn't allow ALTER TABLE ADD CONSTRAINT,
-- so enforcement is handled at the application layer)

-- ---------------------------------------------------------------------------
-- schedules: automation rules (backup, update, restart, broadcast)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schedules (
  id              TEXT PRIMARY KEY,
  server_id       TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  schedule_type   TEXT NOT NULL,                 -- backup|update|restart|broadcast
  cron_expression TEXT NOT NULL,                 -- standard 5-field cron
  enabled         INTEGER NOT NULL DEFAULT 1,
  config_json     TEXT NOT NULL DEFAULT '{}',    -- type-specific JSON config
  last_run        DATETIME,
  next_run        DATETIME,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- backups: backup zip file records
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backups (
  id              TEXT PRIMARY KEY,
  server_id       TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  file_path       TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL DEFAULT 0,
  map_id          TEXT NOT NULL,
  triggered_by    TEXT NOT NULL,                 -- manual|schedule|pre_update|pre_restart
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- notification_configs: per-server or global notification channel settings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_configs (
  id          TEXT PRIMARY KEY,
  server_id   TEXT,                              -- NULL = global default
  channel     TEXT NOT NULL,                    -- discord|email|desktop|in_app
  enabled     INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL DEFAULT '{}',        -- webhook URL, SMTP config, etc.
  events_json TEXT NOT NULL DEFAULT '[]',        -- JSON array of NotificationEventType values
  UNIQUE(server_id, channel)
);

-- ---------------------------------------------------------------------------
-- in_app_notifications: notification history / event log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS in_app_notifications (
  id          TEXT PRIMARY KEY,
  server_id   TEXT,                              -- NULL = system-level notification
  event_type  TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'info',      -- info|success|warning|error
  read        INTEGER NOT NULL DEFAULT 0,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- app_settings: key-value store for global application settings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- file_cache: tracks shared SteamCMD / mod cache entries for deduplication
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS file_cache (
  cache_key    TEXT PRIMARY KEY,                 -- e.g. "asa-server" or "mod-12345"
  file_path    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  sha256_hash  TEXT,
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_server_mods_server_id ON server_mods(server_id);
CREATE INDEX IF NOT EXISTS idx_schedules_server_id ON schedules(server_id);
CREATE INDEX IF NOT EXISTS idx_backups_server_id ON backups(server_id);
CREATE INDEX IF NOT EXISTS idx_notifications_server_id ON in_app_notifications(server_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON in_app_notifications(created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON in_app_notifications(read);

-- ---------------------------------------------------------------------------
-- Seed default app settings
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('setup_complete', 'false'),
  ('base_install_dir', ''),
  ('backup_dir', ''),
  ('steamcmd_path', ''),
  ('steamcmd_mode', 'auto'),   -- 'auto' | 'manual'
  ('app_version', '0.1.0'),
  ('theme_accent', 'cyan');   -- 'cyan' | 'purple' | 'green'
