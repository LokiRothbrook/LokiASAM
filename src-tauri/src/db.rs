// db.rs — direct rusqlite helpers for Rust-side business logic.
// Separate from the frontend's @tauri-apps/plugin-sql connection.
// Functions open a fresh connection per call using the db_path stored in AppState.

use rusqlite::Connection;

// ---------------------------------------------------------------------------
// Connection helper
// ---------------------------------------------------------------------------

pub fn open(db_path: &str) -> Result<Connection, String> {
    let conn = Connection::open(db_path)
        .map_err(|e| format!("Failed to open DB at {db_path}: {e}"))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
    )
    .map_err(|e| format!("DB PRAGMA failed: {e}"))?;
    Ok(conn)
}

// ---------------------------------------------------------------------------
// Timestamp parsing — ISO "YYYY-MM-DDTHH:MM:SSZ" → Unix seconds
// Uses the Howard Hinnant civil-calendar algorithm (no external crate needed).
// ---------------------------------------------------------------------------

pub fn iso_to_unix_secs(ts: &str) -> u64 {
    let s = ts.trim_end_matches('Z');
    let t_pos = s.find('T').unwrap_or(s.len());
    let date = &s[..t_pos];
    let time = if t_pos < s.len() { &s[t_pos + 1..] } else { "0:0:0" };

    let mut dp = date.split('-').filter_map(|x| x.parse::<i64>().ok());
    let mut tp = time.split(':').filter_map(|x| x.parse::<u64>().ok());

    let y = dp.next().unwrap_or(1970);
    let m = dp.next().unwrap_or(1);
    let d = dp.next().unwrap_or(1);
    let h   = tp.next().unwrap_or(0);
    let min = tp.next().unwrap_or(0);
    let sec = tp.next().unwrap_or(0);

    let days = ymd_to_days_since_epoch(y, m, d);
    let total = days.saturating_mul(86400) as u64 + h * 3600 + min * 60 + sec;
    total
}

fn ymd_to_days_since_epoch(y: i64, m: i64, d: i64) -> i64 {
    // Howard Hinnant algorithm: https://howardhinnant.github.io/date_algorithms.html
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m2  = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * m2 + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

// ---------------------------------------------------------------------------
// app_settings
// ---------------------------------------------------------------------------

pub fn get_app_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        [key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

// ---------------------------------------------------------------------------
// servers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ServerRow {
    pub id: String,
    pub name: String,
    pub map_id: String,
    pub install_path: String,
}

pub fn get_server(conn: &Connection, server_id: &str) -> Option<ServerRow> {
    conn.query_row(
        "SELECT id, name, map_id, install_path FROM servers WHERE id = ?1",
        [server_id],
        |row| {
            Ok(ServerRow {
                id:           row.get(0)?,
                name:         row.get(1)?,
                map_id:       row.get(2)?,
                install_path: row.get(3)?,
            })
        },
    )
    .ok()
}

pub fn get_servers(conn: &Connection) -> Vec<ServerRow> {
    let mut stmt = match conn.prepare(
        "SELECT id, name, map_id, install_path FROM servers",
    ) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[db] get_servers prepare failed: {e}");
            return vec![];
        }
    };
    stmt.query_map([], |row| {
        Ok(ServerRow {
            id:           row.get(0)?,
            name:         row.get(1)?,
            map_id:       row.get(2)?,
            install_path: row.get(3)?,
        })
    })
    .map(|rows| rows.filter_map(|r| r.ok()).collect())
    .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// schedules
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ScheduleRow {
    pub schedule_type: String,
    pub enabled: i64,
    pub config_json: String,
}

pub fn get_server_schedules(conn: &Connection, server_id: &str) -> Vec<ScheduleRow> {
    let mut stmt = match conn.prepare(
        "SELECT schedule_type, enabled, config_json FROM schedules WHERE server_id = ?1",
    ) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[db] get_server_schedules prepare failed: {e}");
            return vec![];
        }
    };
    stmt.query_map([server_id], |row| {
        Ok(ScheduleRow {
            schedule_type: row.get(0)?,
            enabled:       row.get(1)?,
            config_json:   row.get(2)?,
        })
    })
    .map(|rows| rows.filter_map(|r| r.ok()).collect())
    .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// backups
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct BackupRow {
    pub id: String,
    pub file_path: String,
    pub created_at: String,
    pub tiers: String,
    pub player_eosid: Option<String>,
}

/// Returns all backups for a server+type, sorted oldest-first.
pub fn get_server_backups_by_type(
    conn: &Connection,
    server_id: &str,
    backup_type: &str,
) -> Vec<BackupRow> {
    let mut stmt = match conn.prepare(
        "SELECT id, file_path, created_at, tiers, player_eosid \
         FROM backups \
         WHERE server_id = ?1 AND backup_type = ?2 \
         ORDER BY created_at ASC",
    ) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[db] get_server_backups_by_type prepare failed: {e}");
            return vec![];
        }
    };
    stmt.query_map([server_id, backup_type], |row| {
        Ok(BackupRow {
            id:           row.get(0)?,
            file_path:    row.get(1)?,
            created_at:   row.get(2)?,
            tiers:        row.get(3)?,
            player_eosid: row.get(4)?,
        })
    })
    .map(|rows| rows.filter_map(|r| r.ok()).collect())
    .unwrap_or_default()
}

pub struct BackupInsert<'a> {
    pub id:              &'a str,
    pub server_id:       &'a str,
    pub file_path:       &'a str,
    pub file_size_bytes: u64,
    pub map_id:          &'a str,
    pub triggered_by:    &'a str,
    pub created_at:      &'a str,
    pub backup_type:     &'a str,
    pub tiers:           &'a str,
    pub player_eosid:    Option<&'a str>,
    pub player_name:     Option<&'a str>,
}

pub fn insert_backup(conn: &Connection, b: &BackupInsert) -> Result<(), String> {
    conn.execute(
        "INSERT INTO backups \
         (id, server_id, file_path, file_size_bytes, map_id, triggered_by, \
          created_at, backup_type, tiers, player_eosid, player_name) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        rusqlite::params![
            b.id,
            b.server_id,
            b.file_path,
            b.file_size_bytes as i64,
            b.map_id,
            b.triggered_by,
            b.created_at,
            b.backup_type,
            b.tiers,
            b.player_eosid,
            b.player_name,
        ],
    )
    .map_err(|e| format!("insert_backup failed: {e}"))?;
    Ok(())
}

pub fn update_backup_tiers(conn: &Connection, id: &str, tiers: &str) -> Result<(), String> {
    conn.execute("UPDATE backups SET tiers = ?1 WHERE id = ?2", [tiers, id])
        .map_err(|e| format!("update_backup_tiers failed: {e}"))?;
    Ok(())
}

pub fn update_backup_file_path(conn: &Connection, id: &str, path: &str) -> Result<(), String> {
    conn.execute("UPDATE backups SET file_path = ?1 WHERE id = ?2", [path, id])
        .map_err(|e| format!("update_backup_file_path failed: {e}"))?;
    Ok(())
}

pub fn delete_backup_record(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM backups WHERE id = ?1", [id])
        .map_err(|e| format!("delete_backup_record failed: {e}"))?;
    Ok(())
}

/// Returns all login backups for a player, oldest-first.
pub fn get_player_login_backups(
    conn: &Connection,
    server_id: &str,
    eos_id: &str,
) -> Vec<BackupRow> {
    let mut stmt = match conn.prepare(
        "SELECT id, file_path, created_at, tiers, player_eosid \
         FROM backups \
         WHERE server_id = ?1 AND backup_type = 'player' AND player_eosid = ?2 \
           AND triggered_by = 'login' \
         ORDER BY created_at ASC",
    ) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[db] get_player_login_backups prepare failed: {e}");
            return vec![];
        }
    };
    stmt.query_map([server_id, eos_id], |row| {
        Ok(BackupRow {
            id:           row.get(0)?,
            file_path:    row.get(1)?,
            created_at:   row.get(2)?,
            tiers:        row.get(3)?,
            player_eosid: row.get(4)?,
        })
    })
    .map(|rows| rows.filter_map(|r| r.ok()).collect())
    .unwrap_or_default()
}

pub fn insert_player_connection(
    conn: &Connection,
    server_id: &str,
    eos_id: &str,
    ip: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO player_connections (id, server_id, eos_id, ip_address, connected_at) \
         VALUES (?1, ?2, ?3, ?4, datetime('now'))",
        rusqlite::params![uuid::Uuid::new_v4().to_string(), server_id, eos_id, ip],
    )
    .map_err(|e| format!("insert_player_connection failed: {e}"))?;
    Ok(())
}

pub fn upsert_player_name(
    conn: &Connection,
    server_id: &str,
    eos_id: &str,
    name: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO player_name_map (server_id, eos_id, player_name, last_seen) \
         VALUES (?1, ?2, ?3, datetime('now')) \
         ON CONFLICT(server_id, eos_id) DO UPDATE \
         SET player_name = excluded.player_name, last_seen = excluded.last_seen",
        [server_id, eos_id, name],
    )
    .map_err(|e| format!("upsert_player_name failed: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct NotificationConfig {
    pub server_id: Option<String>,
    pub channel: String,
    pub enabled: i64,
    pub config_json: String,
    pub events_json: String,
}

/// Returns notification configs, per-server rows first (so dispatch logic can
/// apply per-server channel settings before falling back to global).
pub fn get_notification_configs(
    conn: &Connection,
    server_id: Option<&str>,
) -> Vec<NotificationConfig> {
    let mut results: Vec<NotificationConfig> = Vec::new();

    // Per-server configs
    if let Some(sid) = server_id {
        if let Ok(mut stmt) = conn.prepare(
            "SELECT server_id, channel, enabled, config_json, events_json \
             FROM notification_configs WHERE server_id = ?1",
        ) {
            if let Ok(rows) = stmt.query_map([sid], |row| {
                Ok(NotificationConfig {
                    server_id:   row.get(0)?,
                    channel:     row.get(1)?,
                    enabled:     row.get(2)?,
                    config_json: row.get(3)?,
                    events_json: row.get(4)?,
                })
            }) {
                results.extend(rows.filter_map(|r| r.ok()));
            }
        }
    }

    // Global configs (server_id IS NULL)
    if let Ok(mut stmt) = conn.prepare(
        "SELECT server_id, channel, enabled, config_json, events_json \
         FROM notification_configs WHERE server_id IS NULL",
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok(NotificationConfig {
                server_id:   row.get(0)?,
                channel:     row.get(1)?,
                enabled:     row.get(2)?,
                config_json: row.get(3)?,
                events_json: row.get(4)?,
            })
        }) {
            results.extend(rows.filter_map(|r| r.ok()));
        }
    }

    results
}

pub struct NotifInsert<'a> {
    pub id:         &'a str,
    pub server_id:  Option<&'a str>,
    pub event_type: &'a str,
    pub title:      &'a str,
    pub body:       &'a str,
    pub severity:   &'a str,
    pub read:       i64,
}

pub fn log_notification(conn: &Connection, n: &NotifInsert) -> Result<(), String> {
    conn.execute(
        "INSERT INTO in_app_notifications \
         (id, server_id, event_type, title, body, severity, read) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            n.id, n.server_id, n.event_type, n.title, n.body, n.severity, n.read,
        ],
    )
    .map_err(|e| format!("log_notification failed: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// build_version_cache
// ---------------------------------------------------------------------------

/// Returns the cached (game_version, source) for a build_id, if present.
pub fn get_build_game_version(conn: &Connection, build_id: &str) -> Option<(Option<String>, String)> {
    conn.query_row(
        "SELECT game_version, source FROM build_version_cache WHERE build_id = ?1",
        [build_id],
        |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
    )
    .ok()
}

/// Upsert a (build_id → game_version) entry. "server" source always wins;
/// never downgrades an existing "server" entry to "internet".
pub fn upsert_build_game_version(
    conn: &Connection,
    build_id: &str,
    version: Option<&str>,
    source: &str,
) -> Result<(), String> {
    // Don't overwrite a server-confirmed entry with an internet one.
    if source != "server" {
        let existing: Option<String> = conn.query_row(
            "SELECT source FROM build_version_cache WHERE build_id = ?1",
            [build_id],
            |row| row.get(0),
        ).ok();
        if existing.as_deref() == Some("server") {
            return Ok(());
        }
    }

    conn.execute(
        "INSERT INTO build_version_cache (build_id, game_version, source, fetched_at) \
         VALUES (?1, ?2, ?3, strftime('%s','now')) \
         ON CONFLICT(build_id) DO UPDATE SET \
           game_version = excluded.game_version, \
           source = excluded.source, \
           fetched_at = excluded.fetched_at",
        rusqlite::params![build_id, version, source],
    )
    .map_err(|e| format!("upsert_build_game_version failed: {e}"))?;
    Ok(())
}

/// Update the installed_build_id column for a specific server.
pub fn set_server_installed_build(conn: &Connection, server_id: &str, build_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE servers SET installed_build_id = ?1 WHERE id = ?2",
        [build_id, server_id],
    )
    .map_err(|e| format!("set_server_installed_build failed: {e}"))?;
    Ok(())
}
