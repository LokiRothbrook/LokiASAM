/// backup_manager.rs — Rust-side hourly backup tick handler.
///
/// Replaces the frontend SchedulerManager's `backup://tick` handler so that
/// scheduled backups are created and recorded in SQLite even when the WebKit
/// webview is throttled (window hidden in the system tray).
///
/// Called once per hour from the background tick task in lib.rs.
/// For each running server that has a backup schedule enabled, this module:
///   1. Creates the 7z archive via the existing backup commands.
///   2. Computes which TimeShift tiers are due (H/D/W/M).
///   3. Renames the archive to embed the tier suffix.
///   4. Inserts the record into SQLite.
///   5. Prunes old archives beyond each tier's keep-count.
///   6. Emits `backup://completed/{serverId}` so the UI can refresh.

use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager};

use crate::db;
use crate::state::AppState;
use crate::state::rcon_pool::RconPool;

use super::backup::{
    create_server_backup_inner, backup_all_players_inner, create_player_backup_inner,
    rcon_save_world, BackupRecord,
};

fn fmt_size(bytes: u64) -> String {
    if bytes >= 1_073_741_824 {
        format!("{:.1} GB", bytes as f64 / 1_073_741_824.0)
    } else if bytes >= 1_048_576 {
        format!("{:.1} MB", bytes as f64 / 1_048_576.0)
    } else {
        format!("{:.1} KB", bytes as f64 / 1_024.0)
    }
}

// ---------------------------------------------------------------------------
// Map ID → ASA map path (matches ARK_MAPS in game-data.ts)
// ---------------------------------------------------------------------------

fn map_id_to_path(map_id: &str) -> &'static str {
    match map_id {
        "theisland"   => "TheIsland_WP",
        "thecenter"   => "TheCenter_WP",
        "ragnarok"    => "Ragnarok_WP",
        "valguero"    => "Valguero_WP",
        "scorched"    => "ScorchedEarth_WP",
        "aberration"  => "Aberration_WP",
        "extinction"  => "Extinction_WP",
        "astraeos"    => "Astraeos_WP",
        "lostcolony"  => "LostColony_WP",
        "genesis1"    => "Genesis_WP",
        "genesis2"    => "Gen2_WP",
        "lostisland"  => "LostIsland_WP",
        "fjordur"     => "Fjordur_WP",
        "crystalisles"=> "CrystalIsles_WP",
        "amissa"      => "Amissa_WP",
        "svartalfheim"=> "Svartalfheim_WP",
        "clubark"     => "ClubARK_WP",
        _             => "TheIsland_WP",
    }
}

// ---------------------------------------------------------------------------
// Tier configuration
// ---------------------------------------------------------------------------

/// Tier priority order: most important first.
const TIERS: [(char, &str, u64); 4] = [
    ('M', "monthly",  30 * 24 * 3600),
    ('W', "weekly",    7 * 24 * 3600),
    ('D', "daily",         24 * 3600),
    ('H', "hourly",                0),
];

const TIER_DEFAULT_KEEP: [(char, u32); 4] = [
    ('M', 3),
    ('W', 4),
    ('D', 7),
    ('H', 24),
];

#[derive(Debug, Default, Clone, Copy)]
struct TierCfg {
    enabled: bool,
    keep:    u32,
}

type TierConfig = HashMap<char, TierCfg>;

fn parse_tier_config(config_json: &str) -> TierConfig {
    let mut cfg = TierConfig::new();
    let v: serde_json::Value = serde_json::from_str(config_json).unwrap_or_default();

    // New unified format: { hourly: { enabled, keep }, daily: ..., weekly: ..., monthly: ... }
    for (tier_char, key, _) in &TIERS {
        if let Some(obj) = v.get(key) {
            let enabled = obj.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false);
            let default_keep = TIER_DEFAULT_KEEP.iter()
                .find(|(c, _)| c == tier_char)
                .map(|(_, k)| *k)
                .unwrap_or(24);
            let keep = obj.get("keep")
                .and_then(|k| k.as_u64())
                .map(|k| k as u32)
                .unwrap_or(default_keep);
            cfg.insert(*tier_char, TierCfg { enabled, keep });
        }
    }

    // Legacy single-tier format: { tier: "H", keep: 24 }
    if cfg.is_empty() {
        if let Some(tier_str) = v.get("tier").and_then(|t| t.as_str()) {
            let tier_char = tier_str.chars().next().map(|c| c.to_ascii_uppercase()).unwrap_or('H');
            let default_keep = TIER_DEFAULT_KEEP.iter()
                .find(|(c, _)| *c == tier_char)
                .map(|(_, k)| *k)
                .unwrap_or(24);
            let keep = v.get("keep").and_then(|k| k.as_u64()).map(|k| k as u32).unwrap_or(default_keep);
            cfg.insert(tier_char, TierCfg { enabled: true, keep });
        }
    }

    cfg
}

fn tier_config_any_enabled(cfg: &TierConfig) -> bool {
    cfg.values().any(|c| c.enabled)
}

// ---------------------------------------------------------------------------
// Path helpers (mirrors computeRenamedPath from SchedulerManager.tsx)
// ---------------------------------------------------------------------------

/// Build a tier suffix string like "-MWD" from a comma-separated tiers string like "M,W,D".
fn tier_suffix(tiers: &str) -> String {
    if tiers.is_empty() {
        return String::new();
    }
    const ORDER: [char; 4] = ['M', 'W', 'D', 'H'];
    let flags: Vec<char> = tiers
        .split(',')
        .filter_map(|t| t.trim().chars().next())
        .collect();
    let sorted: String = ORDER.iter().filter(|c| flags.contains(c)).collect();
    if sorted.is_empty() { String::new() } else { format!("-{sorted}") }
}

/// Rename a backup file path to embed the new tier suffix.
/// "server-2024-01-15_10-00-00.7z"        → "server-2024-01-15_10-00-00-DH.7z"
/// "server-2024-01-15_10-00-00-H.7z" + "D,H" → "server-2024-01-15_10-00-00-DH.7z"
fn compute_renamed_path(file_path: &str, new_tiers: &str) -> String {
    let sep = if file_path.contains('\\') { '\\' } else { '/' };
    let last_sep = file_path.rfind(sep).map(|i| i + 1).unwrap_or(0);
    let dir  = &file_path[..last_sep];
    let fname = &file_path[last_sep..];

    if !fname.ends_with(".7z") {
        return file_path.to_string();
    }

    let stem = &fname[..fname.len() - 3]; // strip ".7z"

    // Strip existing tier suffix: if the last "-XXXX" segment is all tier chars, remove it.
    let base_stem = if let Some(hyphen) = stem.rfind('-') {
        let after = &stem[hyphen + 1..];
        if !after.is_empty() && after.chars().all(|c| matches!(c, 'M' | 'W' | 'D' | 'H')) {
            &stem[..hyphen]
        } else {
            stem
        }
    } else {
        stem
    };

    let new_suffix = tier_suffix(new_tiers);
    format!("{dir}{base_stem}{new_suffix}.7z")
}

/// Remove a single tier letter from a comma-separated tiers string.
fn remove_tier(tiers: &str, tier: char) -> String {
    tiers
        .split(',')
        .filter(|t| !t.trim().is_empty() && t.trim() != &tier.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

// ---------------------------------------------------------------------------
// Core backup-record handler (handles one archive: tier assignment + DB + prune)
// ---------------------------------------------------------------------------

/// Determine which tiers are due for `rec`, rename the file, insert into DB, and prune.
/// `eos_id = None` for server backups, `Some(id)` for player backups.
fn handle_backup_record(
    conn: &rusqlite::Connection,
    rec: &BackupRecord,
    cfg: &TierConfig,
    backup_type: &str,
    eos_id: Option<&str>,
) {
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let all_backups = db::get_server_backups_by_type(conn, &rec.server_id, backup_type);

    // For player backups, only consider backups for this specific player.
    let relevant: Vec<&db::BackupRow> = all_backups.iter()
        .filter(|b| eos_id.map_or(true, |id| b.player_eosid.as_deref() == Some(id)))
        .collect();

    let mut due_tiers: Vec<char> = Vec::new();

    for (tier_char, _, threshold_secs) in &TIERS {
        let t_cfg = match cfg.get(tier_char) {
            Some(c) if c.enabled => *c,
            _ => continue,
        };
        let _ = t_cfg; // keep alive

        if *threshold_secs == 0 {
            // Hourly: always due when the tick fires.
            due_tiers.push(*tier_char);
            continue;
        }

        // Find the most recent backup with this tier.
        let last_secs = relevant.iter()
            .filter(|b| b.tiers.split(',').any(|t| t.trim() == tier_char.to_string()))
            .map(|b| db::iso_to_unix_secs(&b.created_at))
            .max()
            .unwrap_or(0);

        if now_secs.saturating_sub(last_secs) >= *threshold_secs {
            due_tiers.push(*tier_char);
        }
    }

    if due_tiers.is_empty() {
        // No tier is due — discard the archive.
        let _ = std::fs::remove_file(&rec.file_path);
        return;
    }

    // Build canonical tier string (M,W,D,H priority order).
    let const_order = ['M', 'W', 'D', 'H'];
    let tiers_string: String = const_order.iter()
        .filter(|c| due_tiers.contains(c))
        .map(|c| c.to_string())
        .collect::<Vec<_>>()
        .join(",");

    // Rename file to include tier suffix.
    let renamed_path = compute_renamed_path(&rec.file_path, &tiers_string);
    if renamed_path != rec.file_path {
        let _ = std::fs::rename(&rec.file_path, &renamed_path);
    }

    // Insert into DB.
    let _ = db::insert_backup(conn, &db::BackupInsert {
        id:              &rec.id,
        server_id:       &rec.server_id,
        file_path:       &renamed_path,
        file_size_bytes: rec.file_size_bytes,
        map_id:          &rec.map_id,
        triggered_by:    &rec.triggered_by,
        created_at:      &rec.created_at,
        backup_type,
        tiers:           &tiers_string,
        player_eosid:    eos_id,
        player_name:     rec.player_name.as_deref(),
    });

    // Prune each due tier.
    for tier_char in &due_tiers {
        let keep = cfg.get(tier_char)
            .map(|c| c.keep)
            .unwrap_or_else(|| TIER_DEFAULT_KEEP.iter()
                .find(|(c, _)| c == tier_char)
                .map(|(_, k)| *k)
                .unwrap_or(24));
        prune_by_tier(conn, &rec.server_id, backup_type, *tier_char, keep, eos_id);
    }
}

/// Remove excess archives for a tier, keeping at most `keep_count`.
fn prune_by_tier(
    conn: &rusqlite::Connection,
    server_id: &str,
    backup_type: &str,
    tier: char,
    keep_count: u32,
    eos_id: Option<&str>,
) {
    let all = db::get_server_backups_by_type(conn, server_id, backup_type);
    let tier_str = tier.to_string();

    let with_tier: Vec<&db::BackupRow> = all.iter()
        .filter(|b| {
            if !b.tiers.split(',').any(|t| t.trim() == tier_str) { return false; }
            if let Some(id) = eos_id {
                b.player_eosid.as_deref() == Some(id)
            } else {
                true
            }
        })
        .collect();

    if with_tier.len() <= keep_count as usize {
        return;
    }

    // `with_tier` is already sorted oldest-first (ORDER BY created_at ASC in query).
    let excess_count = with_tier.len() - keep_count as usize;
    for b in with_tier.iter().take(excess_count) {
        let new_tiers = remove_tier(&b.tiers, tier);
        if new_tiers.is_empty() {
            // Last tier — delete file and record.
            let _ = std::fs::remove_file(&b.file_path);
            let _ = db::delete_backup_record(conn, &b.id);
        } else {
            // Still has other tiers — rename and update DB.
            let new_path = compute_renamed_path(&b.file_path, &new_tiers);
            if new_path != b.file_path {
                let _ = std::fs::rename(&b.file_path, &new_path);
                let _ = db::update_backup_file_path(conn, &b.id, &new_path);
            }
            let _ = db::update_backup_tiers(conn, &b.id, &new_tiers);
        }
    }
}

// ---------------------------------------------------------------------------
// Main entry point: execute_tick
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Login backup handler — called from log_manager when a player login is detected
// ---------------------------------------------------------------------------

/// Called from the log watcher when a player login line is detected.
/// Records the player_connections row and, if login backups are configured,
/// creates an archive and prunes old ones — all without touching the webview.
pub async fn handle_player_login(app: &AppHandle, server_id: &str, eos_id: &str, ip: &str) {
    let db_path = {
        let state = app.state::<AppState>();
        match state.get_db_path() {
            Some(p) => p,
            None => return,
        }
    };

    let conn = match db::open(&db_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[backup_manager] handle_player_login: DB open failed: {e}");
            return;
        }
    };

    // Always record the connection, regardless of backup settings.
    let _ = db::insert_player_connection(&conn, server_id, eos_id, ip);

    // Check if login backups are enabled for this server.
    let keep_str = db::get_app_setting(&conn, &format!("login_backup_keep_{server_id}"));
    let keep: usize = keep_str
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if keep == 0 {
        return;
    }

    // Look up server info needed to create the archive.
    let server = match db::get_server(&conn, server_id) {
        Some(s) => s,
        None => {
            eprintln!("[backup_manager] handle_player_login: server {server_id} not found");
            return;
        }
    };

    let backup_dir = match db::get_app_setting(&conn, "backup_dir") {
        Some(d) if !d.is_empty() => d,
        _ => return,
    };

    let map_path = map_id_to_path(&server.map_id);

    // Create the archive (eos_id used as player_name for the filename).
    let rec = match create_player_backup_inner(
        app,
        server_id,
        &server.name,
        &server.install_path,
        map_path,
        &server.map_id,
        &backup_dir,
        eos_id,
        eos_id,
        "login",
        "",
    ).await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[backup_manager] Login backup failed for {eos_id}@{server_id}: {e}");
            return;
        }
    };

    // Insert into DB.
    let _ = db::insert_backup(&conn, &db::BackupInsert {
        id:              &rec.id,
        server_id,
        file_path:       &rec.file_path,
        file_size_bytes: rec.file_size_bytes,
        map_id:          &rec.map_id,
        triggered_by:    "login",
        created_at:      &rec.created_at,
        backup_type:     "player",
        tiers:           "",
        player_eosid:    Some(eos_id),
        player_name:     Some(eos_id),
    });

    // Prune: keep at most `keep` login backups for this player.
    let existing = db::get_player_login_backups(&conn, server_id, eos_id);
    if existing.len() > keep {
        let excess = existing.len() - keep;
        for b in existing.iter().take(excess) {
            let _ = std::fs::remove_file(&b.file_path);
            let _ = db::delete_backup_record(&conn, &b.id);
        }
    }
}

// ---------------------------------------------------------------------------

/// Called from lib.rs once per hour at each :00:00 boundary.
/// Handles all scheduled backup logic entirely in Rust so it works even when
/// the WebKit webview is throttled in the system tray.
pub async fn execute_tick(app: &AppHandle) {
    let db_path = {
        let state = app.state::<AppState>();
        match state.get_db_path() {
            Some(p) => p,
            None => {
                // DB not initialized yet (setup not complete) — skip tick.
                return;
            }
        }
    };

    let running_ids: Vec<String> = {
        let state = app.state::<AppState>();
        let ids: Vec<String> = state.running_servers.lock().unwrap().keys().cloned().collect();
        ids
    };

    if running_ids.is_empty() {
        return;
    }

    let conn = match db::open(&db_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[backup_manager] Failed to open DB: {e}");
            return;
        }
    };

    let backup_dir = match db::get_app_setting(&conn, "backup_dir") {
        Some(d) if !d.is_empty() => d,
        _ => {
            eprintln!("[backup_manager] backup_dir not configured — skipping tick");
            return;
        }
    };

    let servers = db::get_servers(&conn);
    let pool = app.state::<RconPool>();

    for server in &servers {
        if !running_ids.contains(&server.id) {
            continue;
        }

        let schedules = db::get_server_schedules(&conn, &server.id);
        let map_path  = map_id_to_path(&server.map_id);

        // Parse both schedule configs up front so we can decide whether a
        // world save is needed before starting either backup.
        let server_cfg = schedules.iter()
            .find(|s| s.schedule_type == "backup_server" && s.enabled == 1)
            .map(|s| parse_tier_config(&s.config_json));
        let player_cfg = schedules.iter()
            .find(|s| s.schedule_type == "backup_player" && s.enabled == 1)
            .map(|s| parse_tier_config(&s.config_json));

        let server_active = server_cfg.as_ref().map_or(false, tier_config_any_enabled);
        let player_active = player_cfg.as_ref().map_or(false, tier_config_any_enabled);

        // ── Single world save for the whole tick ───────────────────────────
        // Issue SaveWorld once if any backup type is going to run, so both
        // server and player backups read from the same flushed on-disk state.
        if server_active || player_active {
            let _ = rcon_save_world(&pool, &server.id).await;
            // ASA confirms SaveWorld via RCON before all file I/O is done;
            // wait for atomic writes (delete → rename) to settle.
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }

        // ── Server backup ──────────────────────────────────────────────────
        let server_outcome: Option<Result<String, String>> = if server_active {
            if let Some(cfg) = server_cfg {
                match create_server_backup_inner(
                    app,
                    &server.id,
                    &server.name,
                    &server.install_path,
                    map_path,
                    &server.map_id,
                    &backup_dir,
                    "schedule",
                    "",      // tier assigned after tier computation
                    &pool,
                    true,    // world save already done above
                ).await {
                    Ok(rec) => {
                        handle_backup_record(&conn, &rec, &cfg, "server", None);
                        Some(Ok(fmt_size(rec.file_size_bytes)))
                    }
                    Err(e) => {
                        eprintln!("[backup_manager] Server backup failed for {}: {e}", server.name);
                        Some(Err(e))
                    }
                }
            } else {
                None
            }
        } else {
            None
        };

        // ── Player backup ──────────────────────────────────────────────────
        let player_outcome: Option<Result<usize, String>> = if player_active {
            if let Some(cfg) = player_cfg {
                match backup_all_players_inner(
                    app,
                    &server.id,
                    &server.name,
                    &server.install_path,
                    map_path,
                    &server.map_id,
                    &backup_dir,
                    "schedule",
                ).await {
                    Ok(recs) => {
                        let count = recs.len();
                        for rec in &recs {
                            let eos_id = rec.player_eosid.as_deref();
                            handle_backup_record(&conn, rec, &cfg, "player", eos_id);
                        }
                        Some(Ok(count))
                    }
                    Err(e) => {
                        eprintln!("[backup_manager] Player backup failed for {}: {e}", server.name);
                        Some(Err(e))
                    }
                }
            } else {
                None
            }
        } else {
            None
        };

        // ── Consolidated notification ──────────────────────────────────────
        // One notification per server per tick regardless of how many backup
        // types ran. Titles are specific when only one type ran; generic when
        // both ran so the body can carry the combined detail.
        let notification: Option<(&str, &str, String, &str)> = match (&server_outcome, &player_outcome) {
            // Both ran — both succeeded
            (Some(Ok(size)), Some(Ok(count))) if *count > 0 => Some((
                "backup_completed", "Backup Complete",
                format!("Server backup: {size} · {count} players backed up"),
                "success",
            )),
            // Both ran — server ok, players ran but 0 profiles found
            (Some(Ok(size)), Some(Ok(_))) => Some((
                "backup_completed", "Server Backup Complete",
                format!("Scheduled server backup completed ({size})"),
                "success",
            )),
            // Both ran — server ok, players failed
            (Some(Ok(size)), Some(Err(pe))) => Some((
                "backup_failed", "Backup Partially Failed",
                format!("Server backup complete ({size}) · Player backup failed: {pe}"),
                "error",
            )),
            // Both ran — server failed, players ok
            (Some(Err(se)), Some(Ok(count))) if *count > 0 => Some((
                "backup_failed", "Backup Partially Failed",
                format!("Server backup failed: {se} · {count} player backups complete"),
                "error",
            )),
            // Both ran — server failed, 0 players
            (Some(Err(se)), Some(Ok(_))) => Some((
                "backup_failed", "Server Backup Failed",
                format!("Scheduled server backup failed: {se}"),
                "error",
            )),
            // Both ran — both failed
            (Some(Err(se)), Some(Err(pe))) => Some((
                "backup_failed", "Backup Failed",
                format!("Server backup failed: {se} · Player backup failed: {pe}"),
                "error",
            )),
            // Server only
            (Some(Ok(size)), None) => Some((
                "backup_completed", "Server Backup Complete",
                format!("Scheduled server backup completed ({size})"),
                "success",
            )),
            (Some(Err(se)), None) => Some((
                "backup_failed", "Server Backup Failed",
                format!("Scheduled server backup failed: {se}"),
                "error",
            )),
            // Player only
            (None, Some(Ok(count))) if *count > 0 => Some((
                "backup_completed", "Player Backup Complete",
                format!("Scheduled player backups completed ({count} players)"),
                "success",
            )),
            (None, Some(Err(pe))) => Some((
                "backup_failed", "Player Backup Failed",
                format!("Scheduled player backup failed: {pe}"),
                "error",
            )),
            // Player only with 0 profiles, or nothing ran
            _ => None,
        };

        if let Some((event_type, title, body, severity)) = notification {
            crate::commands::notifications::dispatch_notification(
                app, event_type, Some(&server.id), &server.name,
                title, &body, severity,
            ).await;
        }

        // Single UI-refresh event whenever any backup was attempted for this server.
        if server_outcome.is_some() || player_outcome.is_some() {
            let _ = app.emit(
                &format!("backup://completed/{}", server.id),
                serde_json::json!({ "serverId": server.id }),
            );
        }
    }
}
