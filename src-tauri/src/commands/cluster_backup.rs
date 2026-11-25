//! Cluster backups: archives of a cluster's shared transfer data (players'
//! uploaded characters, dinos and items), separate from any one server.
//!
//! Scheduled tiers (hourly/daily/weekly/monthly, same rules as server
//! backups) are configured per cluster in `clusters.settings_json.backup` and
//! run from the hourly backup tick while at least one member server is up —
//! cluster data only changes while players are online. Archives live in
//! `{backup_dir}/clusters/{cluster_id}/`, records in `cluster_backups`.

use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::db;
use crate::state::AppState;
use super::backup::{collect_files, compress_to_7z, now_timestamp, sanitize_name};
use super::backup_manager::{
    compute_due_tiers, compute_renamed_path, parse_tier_config, remove_tier,
    tier_config_any_enabled, tier_keep, tiers_string, TierConfig,
};
use super::utils::fmt_size;

/// Manual ("Back up now" / pre-restore) archives kept per cluster.
const MANUAL_KEEP: usize = 10;

/// Where a cluster's data lives. ASA appends `clusters/<id>` to
/// -ClusterDirOverride, which the app sets to the custom dir or the base dir
/// (see derivedLaunchArgs in server-utils.ts).
fn cluster_data_dir(base_dir: &str, dir_override: Option<&str>, id: &str) -> PathBuf {
    let root = dir_override
        .filter(|d| !d.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(base_dir));
    root.join("clusters").join(id)
}

fn backup_tiers(settings_json: &str) -> TierConfig {
    let v: serde_json::Value = serde_json::from_str(settings_json).unwrap_or_default();
    parse_tier_config(&v.get("backup").map(|b| b.to_string()).unwrap_or_else(|| "{}".into()))
}

struct Archive {
    id: String,
    path: String,
    size: u64,
    created_at: String,
}

/// Archive a cluster's data folder. `Ok(None)` when there's no data yet.
async fn archive_cluster(
    app: &AppHandle,
    cluster: &db::ClusterInfo,
    base_dir: &str,
    backup_dir: &str,
    label: &str,
) -> Result<Option<Archive>, String> {
    let data_dir = cluster_data_dir(base_dir, cluster.dir_override.as_deref(), &cluster.id);
    let mut files = Vec::new();
    if data_dir.is_dir() {
        collect_files(&data_dir, &mut files).map_err(|e| format!("Failed to read cluster data: {e}"))?;
    }
    if files.is_empty() {
        return Ok(None);
    }

    let out_dir = PathBuf::from(backup_dir).join("clusters").join(&cluster.id);
    fs::create_dir_all(&out_dir).map_err(|e| format!("Failed to create backup folder: {e}"))?;
    let (ts_file, ts_iso) = now_timestamp();
    let dest = out_dir.join(format!("cluster-{}-{ts_file}.7z", sanitize_name(&cluster.name)));

    let (app_c, cid, dest_c, label_c) = (app.clone(), cluster.id.clone(), dest.clone(), label.to_string());
    tokio::task::spawn_blocking(move || compress_to_7z(&app_c, &cid, &files, &data_dir, &dest_c, &label_c))
        .await
        .map_err(|e| format!("Backup task failed: {e}"))??;

    let size = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    Ok(Some(Archive { id: Uuid::new_v4().to_string(), path: dest.to_string_lossy().into_owned(), size, created_at: ts_iso }))
}

/// Remove excess archives for one tier (oldest first), like prune_by_tier.
fn prune_tier(conn: &rusqlite::Connection, cluster_id: &str, tier: char, keep: u32) {
    let rows = db::get_cluster_backups(conn, cluster_id);
    let with_tier: Vec<&db::ClusterBackupRow> = rows.iter()
        .filter(|b| b.tiers.split(',').any(|t| t.trim() == tier.to_string()))
        .collect();
    if with_tier.len() <= keep as usize { return; }
    for b in with_tier.iter().take(with_tier.len() - keep as usize) {
        let remaining = remove_tier(&b.tiers, tier);
        if remaining.is_empty() {
            let _ = fs::remove_file(&b.file_path);
            let _ = db::delete_cluster_backup_record(conn, &b.id);
        } else {
            let new_path = compute_renamed_path(&b.file_path, &remaining);
            if new_path != b.file_path { let _ = fs::rename(&b.file_path, &new_path); }
            let _ = db::update_cluster_backup(conn, &b.id, &new_path, &remaining);
        }
    }
}

/// Keep only the newest MANUAL_KEEP untiered (manual / pre-restore) archives.
fn prune_manual(conn: &rusqlite::Connection, cluster_id: &str) {
    let rows = db::get_cluster_backups(conn, cluster_id);
    let manual: Vec<&db::ClusterBackupRow> = rows.iter().filter(|b| b.tiers.trim().is_empty()).collect();
    if manual.len() <= MANUAL_KEEP { return; }
    for b in manual.iter().take(manual.len() - MANUAL_KEEP) {
        let _ = fs::remove_file(&b.file_path);
        let _ = db::delete_cluster_backup_record(conn, &b.id);
    }
}

/// Hourly-tick pass: back up every cluster that has a tier due and at least
/// one running member server.
pub async fn backup_clusters_tick(
    app: &AppHandle,
    db_path: &str,
    base_dir: &str,
    backup_dir: &str,
    running_ids: &[String],
) {
    // Own connection: a borrowed rusqlite Connection can't be held across
    // awaits in the (Send) tick future.
    let conn = match db::open(db_path) {
        Ok(c) => c,
        Err(e) => { eprintln!("[cluster_backup] DB open failed: {e}"); return; }
    };
    for cluster in db::get_clusters(&conn) {
        let cfg = backup_tiers(&cluster.settings_json);
        if !tier_config_any_enabled(&cfg) { continue; }
        if !cluster.member_ids.iter().any(|id| running_ids.contains(id)) { continue; }

        let existing = db::get_cluster_backups(&conn, &cluster.id);
        let pairs: Vec<(&str, &str)> = existing.iter().map(|b| (b.tiers.as_str(), b.created_at.as_str())).collect();
        let due = compute_due_tiers(&pairs, &cfg);
        if due.is_empty() { continue; }

        match archive_cluster(app, &cluster, base_dir, backup_dir, "Creating cluster backup…").await {
            Ok(Some(a)) => {
                let tiers = tiers_string(&due);
                let path = compute_renamed_path(&a.path, &tiers);
                if path != a.path { let _ = fs::rename(&a.path, &path); }
                let _ = db::insert_cluster_backup(&conn, &a.id, &cluster.id, &path, a.size, "schedule", &a.created_at, &tiers);
                for t in &due { prune_tier(&conn, &cluster.id, *t, tier_keep(&cfg, *t)); }
                crate::commands::notifications::dispatch_notification(
                    app, "backup_completed", None, &cluster.name, "Cluster Backup",
                    &format!("{} — cluster backup complete ({})", cluster.name, fmt_size(a.size)), "success",
                ).await;
            }
            Ok(None) => {} // nothing uploaded to the cluster yet
            Err(e) => {
                eprintln!("[cluster_backup] {} failed: {e}", cluster.name);
                crate::commands::notifications::dispatch_notification(
                    app, "backup_failed", None, &cluster.name, "Cluster Backup Failed",
                    &format!("{} — cluster backup failed: {e}", cluster.name), "error",
                ).await;
            }
        }
    }
}

fn open_db(app: &AppHandle) -> Result<rusqlite::Connection, String> {
    let path = app.state::<AppState>().get_db_path().ok_or("Database not ready")?;
    db::open(&path)
}

fn dirs(conn: &rusqlite::Connection) -> Result<(String, String), String> {
    let backup_dir = db::get_app_setting(conn, "backup_dir")
        .filter(|d| !d.is_empty())
        .ok_or("Backup directory is not configured.")?;
    Ok((db::get_app_setting(conn, "base_dir").unwrap_or_default(), backup_dir))
}

/// "Back up now" on a cluster's page.
#[tauri::command]
pub async fn create_cluster_backup(app: AppHandle, cluster_id: String) -> Result<(), String> {
    let conn = open_db(&app)?;
    let (base_dir, backup_dir) = dirs(&conn)?;
    let cluster = db::get_clusters(&conn).into_iter().find(|c| c.id == cluster_id).ok_or("Cluster not found")?;
    let a = archive_cluster(&app, &cluster, &base_dir, &backup_dir, "Backing up cluster…")
        .await?
        .ok_or("This cluster has no data yet — nothing has been uploaded to it.")?;
    db::insert_cluster_backup(&conn, &a.id, &cluster.id, &a.path, a.size, "manual", &a.created_at, "")?;
    prune_manual(&conn, &cluster.id);
    Ok(())
}

/// Restore a cluster backup over the cluster's data folder. Every member
/// server must be stopped; the current data is archived first (undo).
#[tauri::command]
pub async fn restore_cluster_backup(app: AppHandle, backup_id: String) -> Result<(), String> {
    let conn = open_db(&app)?;
    let (base_dir, backup_dir) = dirs(&conn)?;
    let (cluster_id, archive_path) = db::get_cluster_backup(&conn, &backup_id).ok_or("Backup not found")?;
    let cluster = db::get_clusters(&conn).into_iter().find(|c| c.id == cluster_id).ok_or("Cluster not found")?;

    let running: Vec<String> = {
        let state = app.state::<AppState>();
        let registry = state.running_servers.lock().unwrap();
        cluster.member_ids.iter().filter(|id| registry.contains_key(*id)).cloned().collect()
    };
    if !running.is_empty() {
        let names: Vec<String> = db::get_servers(&conn).into_iter()
            .filter(|s| running.contains(&s.id))
            .map(|s| s.name)
            .collect();
        return Err(format!("Stop every server in this cluster first (running: {}).", names.join(", ")));
    }

    if let Some(a) = archive_cluster(&app, &cluster, &base_dir, &backup_dir, "Saving current cluster data…").await? {
        db::insert_cluster_backup(&conn, &a.id, &cluster.id, &a.path, a.size, "pre-restore", &a.created_at, "")?;
        prune_manual(&conn, &cluster.id);
    }

    let data_dir = cluster_data_dir(&base_dir, cluster.dir_override.as_deref(), &cluster.id);
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        if data_dir.exists() {
            fs::remove_dir_all(&data_dir).map_err(|e| format!("Failed to clear cluster data: {e}"))?;
        }
        fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        sevenz_rust::decompress_file(&archive_path, &data_dir).map_err(|e| format!("Failed to extract backup: {e}"))
    })
    .await
    .map_err(|e| format!("Restore task failed: {e}"))?
}

#[tauri::command]
pub async fn delete_cluster_backup(app: AppHandle, backup_id: String) -> Result<(), String> {
    let conn = open_db(&app)?;
    let (_, path) = db::get_cluster_backup(&conn, &backup_id).ok_or("Backup not found")?;
    let _ = fs::remove_file(&path);
    db::delete_cluster_backup_record(&conn, &backup_id)
}
