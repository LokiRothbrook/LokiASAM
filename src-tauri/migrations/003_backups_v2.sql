-- Migration 003: Backup system v2
-- Expands the backups table with type/tier/player columns,
-- adds player_name_map for EOS ID → display name resolution,
-- and renames the old generic "backup" schedule type to "backup_server".

-- Rename existing backup schedule rows to the new type name.
UPDATE schedules SET schedule_type = 'backup_server' WHERE schedule_type = 'backup';

-- Add backup_type column (server|player|full|ini).
ALTER TABLE backups ADD COLUMN backup_type TEXT NOT NULL DEFAULT 'server';

-- Add tiers column (comma-separated H/D/W/M flags, or empty for manual/full).
ALTER TABLE backups ADD COLUMN tiers TEXT NOT NULL DEFAULT '';

-- Add player columns (only populated for player backups).
ALTER TABLE backups ADD COLUMN player_eosid TEXT;
ALTER TABLE backups ADD COLUMN player_name  TEXT;

-- EOS ID → display name cache, updated from listplayers RCON polls.
CREATE TABLE IF NOT EXISTS player_name_map (
  server_id   TEXT NOT NULL,
  eos_id      TEXT NOT NULL,
  player_name TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  PRIMARY KEY (server_id, eos_id)
);
