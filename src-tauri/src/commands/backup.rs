use std::fs::{self, File};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;
use tokio::time::{timeout, Duration};
use uuid::Uuid;
use sevenz_rust::{SevenZWriter, SevenZArchiveEntry};

use crate::events;
use crate::state::rcon_pool::{RconCmd, RconPool};

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupRecord {
    pub id: String,
    pub server_id: String,
    pub file_path: String,
    pub file_size_bytes: u64,
    pub map_id: String,
    pub triggered_by: String,
    pub created_at: String,
    /// server | player | full | ini
    pub backup_type: String,
    /// Comma-separated tier flags: H, D, W, M — assigned by the frontend after creation.
    pub tiers: String,
    pub player_eosid: Option<String>,
    pub player_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupProgress {
    pub percent: f32,
    pub current_file: String,
    pub label: String,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Build a human-readable timestamp string for file/folder names.
/// Format: YYYY-MM-DD_HH-MM-SS
fn now_timestamp() -> (String, String) {
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (year, month, day, hh, mm, ss) = secs_to_parts(now_secs);
    let ts_file = format!("{year:04}-{month:02}-{day:02}_{hh:02}-{mm:02}-{ss:02}");
    let ts_iso  = format!("{year:04}-{month:02}-{day:02}T{hh:02}:{mm:02}:{ss:02}Z");
    (ts_file, ts_iso)
}

fn secs_to_parts(now_secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    let secs_per_day = 86_400u64;
    let days     = now_secs / secs_per_day;
    let day_secs = now_secs % secs_per_day;
    let (year, month, day) = days_to_ymd(days);
    let hh = day_secs / 3600;
    let mm = (day_secs % 3600) / 60;
    let ss = day_secs % 60;
    (year, month, day, hh, mm, ss)
}

fn days_to_ymd(mut days: u64) -> (u64, u64, u64) {
    days += 719_468;
    let era = days / 146_097;
    let doe = days % 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y   = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp  = (5 * doy + 2) / 153;
    let d   = doy - (153 * mp + 2) / 5 + 1;
    let m   = if mp < 10 { mp + 3 } else { mp - 9 };
    let y   = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

fn sanitize_name(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// Recursively collect all file paths under `dir`.
fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            collect_files(&path, out)?;
        } else {
            out.push(path);
        }
    }
    Ok(())
}

fn emit_progress(app: &AppHandle, server_id: &str, percent: f32, file: &str, label: &str) {
    let _ = app.emit(
        &format!("{}/{}", events::BACKUP_PROGRESS, server_id),
        BackupProgress {
            percent,
            current_file: file.to_string(),
            label: label.to_string(),
        },
    );
}

/// Send SaveWorld through the managed RCON connection if one is live.
/// Falls back silently if RCON is not connected.
async fn rcon_save_world(pool: &RconPool, server_id: &str) -> Result<(), String> {
    let tx = {
        let guard = pool.cmd_channels.lock().await;
        guard.get(server_id).filter(|(tx, _)| !tx.is_closed()).map(|(tx, _)| tx.clone())
    };
    let Some(tx) = tx else { return Ok(()); };

    let (resp_tx, resp_rx) = oneshot::channel();
    tx.send(RconCmd::Execute {
        command:      "SaveWorld".to_string(),
        suppress_cmd: true,
        suppress_resp: true,
        response_tx:  resp_tx,
    })
    .await
    .map_err(|_| "RCON channel closed before SaveWorld".to_string())?;

    match timeout(Duration::from_secs(60), resp_rx).await {
        Ok(Ok(_))  => Ok(()),
        Ok(Err(_)) => Err("SaveWorld response channel dropped".to_string()),
        Err(_)     => Err("SaveWorld timed out after 60s".to_string()),
    }
}

/// Write `files` into a 7z archive at `dest_path`.
/// `root` is stripped from each file path to produce the archive entry name.
/// Emits progress events keyed on `server_id`.
fn compress_to_7z(
    app: &AppHandle,
    server_id: &str,
    files: &[PathBuf],
    root: &Path,
    dest_path: &Path,
    label: &str,
) -> Result<(), String> {
    let total = files.len().max(1) as f32;
    let mut writer = SevenZWriter::create(dest_path).map_err(|e| e.to_string())?;

    for (idx, file_path) in files.iter().enumerate() {
        let rel = file_path
            .strip_prefix(root)
            .map_err(|e| e.to_string())?;
        let entry_name = rel.to_string_lossy().replace('\\', "/");

        let pct = (idx as f32 / total * 99.0).min(99.0);
        emit_progress(app, server_id, pct, &entry_name, label);

        let file = File::open(file_path).map_err(|e| e.to_string())?;
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        let mut entry = SevenZArchiveEntry::new();
        entry.name = entry_name.clone();
        entry.size = metadata.len();
        entry.is_directory = false;
        writer
            .push_archive_entry::<BufReader<File>>(entry, Some(BufReader::new(file)))
            .map_err(|e| e.to_string())?;
    }

    writer.finish().map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Cleanup: delete ARK's own auto-generated backup files
// ---------------------------------------------------------------------------

/// Delete all `{mapPath}-*.ark` timestamped backup files and `*.profilebak`
/// files from the SavedArks/{mapPath} directory.  Only removes ARK's own
/// rolling copies — never touches the live `{mapPath}.ark` save or the
/// `_AntiCorruptionBackup.bak` ARK integrity file.
///
/// Returns the number of files deleted.
#[tauri::command]
pub async fn cleanup_ark_own_backups(
    install_path: String,
    map_path: String,
) -> Result<u32, String> {
    let saved_dir = PathBuf::from(&install_path)
        .join("ShooterGame")
        .join("Saved")
        .join("SavedArks")
        .join(&map_path);

    if !saved_dir.exists() {
        return Ok(0);
    }

    let mut deleted = 0u32;
    let prefix = format!("{map_path}-");

    let entries = fs::read_dir(&saved_dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() { continue; }

        let fname = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");

        let is_ark_timestamped = fname.starts_with(&prefix) && fname.ends_with(".ark");
        let is_profilebak      = fname.ends_with(".profilebak");

        if is_ark_timestamped || is_profilebak {
            if fs::remove_file(&path).is_ok() {
                deleted += 1;
            }
        }
    }

    Ok(deleted)
}

// ---------------------------------------------------------------------------
// Server backup (SavedArks + SaveGames → .7z)
// ---------------------------------------------------------------------------

/// Create a Server backup: SaveWorld via RCON → cleanup ARK own backups →
/// 7z SavedArks/{mapPath} + SaveGames into {backup_dir}/{server_id}/server/.
///
/// Emits `backup://progress/{server_id}` events during compression.
/// If the server is stopped (no RCON), SaveWorld is skipped and existing saves
/// are compressed as-is.
#[tauri::command]
pub async fn create_server_backup(
    app: AppHandle,
    server_id: String,
    server_name: String,
    install_path: String,
    map_path: String,
    map_id: String,
    backup_dir: String,
    triggered_by: String,
    pool: State<'_, RconPool>,
) -> Result<BackupRecord, String> {
    // SaveWorld (best-effort — server may be stopped)
    emit_progress(&app, &server_id, 0.0, "", "Saving world…");
    let _ = rcon_save_world(&pool, &server_id).await;

    // Cleanup ARK's own backup files before we zip
    emit_progress(&app, &server_id, 2.0, "", "Cleaning ARK backups…");
    let _ = cleanup_ark_own_backups(install_path.clone(), map_path.clone()).await;

    let saved_arks = PathBuf::from(&install_path)
        .join("ShooterGame").join("Saved").join("SavedArks").join(&map_path);
    let save_games = PathBuf::from(&install_path)
        .join("ShooterGame").join("Saved").join("SaveGames");

    let mut all_files: Vec<PathBuf> = Vec::new();
    if saved_arks.exists() {
        collect_files(&saved_arks, &mut all_files).map_err(|e| e.to_string())?;
    }
    if save_games.exists() {
        collect_files(&save_games, &mut all_files).map_err(|e| e.to_string())?;
    }
    if all_files.is_empty() {
        return Err("No save files found to back up".to_string());
    }

    let out_dir = PathBuf::from(&backup_dir).join(&server_id).join("server");
    fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let (ts_file, ts_iso) = now_timestamp();
    let safe_name = sanitize_name(&server_name);
    let archive_name = format!("{safe_name}-{ts_file}.7z");
    let archive_path = out_dir.join(&archive_name);

    // Root for relative paths inside the archive = ShooterGame/Saved
    let saved_root = PathBuf::from(&install_path).join("ShooterGame").join("Saved");

    let app_c = app.clone();
    let sid   = server_id.clone();
    let files = all_files.clone();
    let root  = saved_root.clone();
    let dest  = archive_path.clone();
    tokio::task::spawn_blocking(move || {
        compress_to_7z(&app_c, &sid, &files, &root, &dest, "Creating server backup…")
    })
    .await
    .map_err(|e| format!("Backup task panicked: {e}"))??;

    emit_progress(&app, &server_id, 100.0, &archive_name, "Done");

    let file_size = fs::metadata(&archive_path)
        .map_err(|e| e.to_string())?
        .len();

    Ok(BackupRecord {
        id: Uuid::new_v4().to_string(),
        server_id,
        file_path: archive_path.to_string_lossy().to_string(),
        file_size_bytes: file_size,
        map_id,
        triggered_by,
        created_at: ts_iso,
        backup_type: "server".to_string(),
        tiers: String::new(),
        player_eosid: None,
        player_name: None,
    })
}

// ---------------------------------------------------------------------------
// Player backup (single .arkprofile → .7z)
// ---------------------------------------------------------------------------

/// Back up a single player's .arkprofile into
/// {backup_dir}/{server_id}/player/{eos_id}/.
#[tauri::command]
pub async fn create_player_backup(
    app: AppHandle,
    server_id: String,
    server_name: String,
    install_path: String,
    map_path: String,
    map_id: String,
    backup_dir: String,
    eos_id: String,
    player_name: String,
    triggered_by: String,
) -> Result<BackupRecord, String> {
    let profile_file = PathBuf::from(&install_path)
        .join("ShooterGame").join("Saved")
        .join("SavedArks").join(&map_path)
        .join(format!("{eos_id}.arkprofile"));

    if !profile_file.exists() {
        return Err(format!("Profile not found: {}", profile_file.display()));
    }

    let out_dir = PathBuf::from(&backup_dir)
        .join(&server_id).join("player").join(&eos_id);
    fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let (ts_file, ts_iso) = now_timestamp();
    let safe_server = sanitize_name(&server_name);
    let safe_player = sanitize_name(&player_name);
    let archive_name = format!("{safe_server}-{safe_player}-{ts_file}.7z");
    let archive_path = out_dir.join(&archive_name);

    emit_progress(&app, &server_id, 0.0, "", &format!("Backing up {player_name}…"));

    let root  = profile_file.parent().unwrap().to_path_buf();
    let files = vec![profile_file.clone()];
    let app_c = app.clone();
    let sid   = server_id.clone();
    let dest  = archive_path.clone();
    tokio::task::spawn_blocking(move || {
        compress_to_7z(&app_c, &sid, &files, &root, &dest, "Creating player backup…")
    })
    .await
    .map_err(|e| format!("Backup task panicked: {e}"))??;

    emit_progress(&app, &server_id, 100.0, &archive_name, "Done");

    let file_size = fs::metadata(&archive_path)
        .map_err(|e| e.to_string())?
        .len();

    Ok(BackupRecord {
        id: Uuid::new_v4().to_string(),
        server_id,
        file_path: archive_path.to_string_lossy().to_string(),
        file_size_bytes: file_size,
        map_id,
        triggered_by,
        created_at: ts_iso,
        backup_type: "player".to_string(),
        tiers: String::new(),
        player_eosid: Some(eos_id),
        player_name: Some(player_name),
    })
}

// ---------------------------------------------------------------------------
// INI backup (loose files in a timestamped folder)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IniBackupRecord {
    pub id: String,
    pub server_id: String,
    pub folder_path: String,
    pub created_at: String,
}

/// Back up GameUserSettings.ini and Game.ini to a timestamped subfolder of
/// {backup_dir}/{server_id}/ini/.  The folder named "current" always holds
/// the latest backup; on each save the previous "current" is renamed to a
/// timestamp folder and a new "current" copy is written.
#[tauri::command]
pub async fn create_ini_backup(
    server_id: String,
    install_path: String,
    backup_dir: String,
    platform: String,
) -> Result<IniBackupRecord, String> {
    let config_dir = PathBuf::from(&install_path)
        .join("ShooterGame").join("Saved").join("Config").join(&platform);

    let ini_files = ["GameUserSettings.ini", "Game.ini"];
    let sources: Vec<PathBuf> = ini_files.iter()
        .map(|f| config_dir.join(f))
        .filter(|p| p.exists())
        .collect();

    if sources.is_empty() {
        return Err("No INI files found to back up".to_string());
    }

    let ini_base = PathBuf::from(&backup_dir).join(&server_id).join("ini");
    let current  = ini_base.join("current");

    // If "current" already exists, rename it to a timestamp folder.
    if current.exists() {
        let (ts_file, _) = now_timestamp();
        let archive_folder = ini_base.join(&ts_file);
        fs::rename(&current, &archive_folder).map_err(|e| e.to_string())?;
    }

    fs::create_dir_all(&current).map_err(|e| e.to_string())?;

    for src in &sources {
        if let Some(fname) = src.file_name() {
            fs::copy(src, current.join(fname)).map_err(|e| e.to_string())?;
        }
    }

    let (_, ts_iso) = now_timestamp();
    Ok(IniBackupRecord {
        id: Uuid::new_v4().to_string(),
        server_id,
        folder_path: current.to_string_lossy().to_string(),
        created_at: ts_iso,
    })
}

/// List timestamped INI snapshot folders for a server (newest first).
#[tauri::command]
pub async fn list_ini_backups(
    server_id: String,
    backup_dir: String,
) -> Result<Vec<String>, String> {
    let ini_base = PathBuf::from(&backup_dir).join(&server_id).join("ini");
    if !ini_base.exists() {
        return Ok(vec![]);
    }

    let mut folders: Vec<String> = fs::read_dir(&ini_base)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path().is_dir()
                && e.file_name().to_string_lossy() != "current"
        })
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();

    // Timestamps sort lexicographically as newest last; reverse for newest first.
    folders.sort();
    folders.reverse();
    Ok(folders)
}

// ---------------------------------------------------------------------------
// Full backup (entire install_path → .7z)
// ---------------------------------------------------------------------------

/// Create a Full backup of the entire server installation directory.
/// This can be very large — warn the user before calling this.
#[tauri::command]
pub async fn create_full_backup(
    app: AppHandle,
    server_id: String,
    server_name: String,
    install_path: String,
    map_id: String,
    backup_dir: String,
    triggered_by: String,
) -> Result<BackupRecord, String> {
    let install_dir = PathBuf::from(&install_path);
    if !install_dir.exists() {
        return Err(format!("Install path not found: {install_path}"));
    }

    let out_dir = PathBuf::from(&backup_dir).join(&server_id).join("full");
    fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let (ts_file, ts_iso) = now_timestamp();
    let safe_name    = sanitize_name(&server_name);
    let archive_name = format!("{safe_name}-full-{ts_file}.7z");
    let archive_path = out_dir.join(&archive_name);

    emit_progress(&app, &server_id, 0.0, "", "Collecting files for full backup…");

    let mut all_files: Vec<PathBuf> = Vec::new();
    collect_files(&install_dir, &mut all_files).map_err(|e| e.to_string())?;

    let app_c = app.clone();
    let sid   = server_id.clone();
    let dest  = archive_path.clone();
    let root  = install_dir.clone();
    tokio::task::spawn_blocking(move || {
        compress_to_7z(&app_c, &sid, &all_files, &root, &dest, "Creating full backup…")
    })
    .await
    .map_err(|e| format!("Full backup task panicked: {e}"))??;

    emit_progress(&app, &server_id, 100.0, &archive_name, "Done");

    let file_size = fs::metadata(&archive_path)
        .map_err(|e| e.to_string())?
        .len();

    Ok(BackupRecord {
        id: Uuid::new_v4().to_string(),
        server_id,
        file_path: archive_path.to_string_lossy().to_string(),
        file_size_bytes: file_size,
        map_id,
        triggered_by,
        created_at: ts_iso,
        backup_type: "full".to_string(),
        tiers: String::new(),
        player_eosid: None,
        player_name: None,
    })
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/// Restore a Server backup: extract 7z over SavedArks/{mapPath} and SaveGames.
#[tauri::command]
pub async fn restore_server_backup(
    app: AppHandle,
    server_id: String,
    backup_file_path: String,
    install_path: String,
) -> Result<(), String> {
    let saved_root = PathBuf::from(&install_path).join("ShooterGame").join("Saved");
    extract_7z_with_progress(&app, &server_id, &backup_file_path, &saved_root, "Restoring server backup…").await
}

/// Restore a Player backup: extract 7z into SavedArks/{mapPath}.
#[tauri::command]
pub async fn restore_player_backup(
    app: AppHandle,
    server_id: String,
    backup_file_path: String,
    install_path: String,
    map_path: String,
) -> Result<(), String> {
    let target = PathBuf::from(&install_path)
        .join("ShooterGame").join("Saved")
        .join("SavedArks").join(&map_path);
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    extract_7z_with_progress(&app, &server_id, &backup_file_path, &target, "Restoring player backup…").await
}

/// Restore an INI backup from a snapshot folder.
#[tauri::command]
pub async fn restore_ini_backup(
    backup_folder_path: String,
    install_path: String,
    platform: String,
) -> Result<(), String> {
    let src_dir = PathBuf::from(&backup_folder_path);
    let dst_dir = PathBuf::from(&install_path)
        .join("ShooterGame").join("Saved").join("Config").join(&platform);

    fs::create_dir_all(&dst_dir).map_err(|e| e.to_string())?;

    for entry in fs::read_dir(&src_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src   = entry.path();
        if src.is_file() {
            if let Some(fname) = src.file_name() {
                fs::copy(&src, dst_dir.join(fname)).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// Restore a Full backup: extract 7z over the entire install_path.
#[tauri::command]
pub async fn restore_full_backup(
    app: AppHandle,
    server_id: String,
    backup_file_path: String,
    install_path: String,
) -> Result<(), String> {
    let target = PathBuf::from(&install_path);
    extract_7z_with_progress(&app, &server_id, &backup_file_path, &target, "Restoring full backup…").await
}

async fn extract_7z_with_progress(
    app: &AppHandle,
    server_id: &str,
    archive_path: &str,
    dest_root: &Path,
    label: &str,
) -> Result<(), String> {
    let archive_path = archive_path.to_string();
    let dest_root    = dest_root.to_path_buf();
    let app_c        = app.clone();
    let sid          = server_id.to_string();
    let lbl          = label.to_string();

    emit_progress(app, server_id, 0.0, "", label);

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        fs::create_dir_all(&dest_root).map_err(|e| e.to_string())?;

        sevenz_rust::decompress_file(&archive_path, &dest_root)
            .map_err(|e| e.to_string())?;

        emit_progress(&app_c, &sid, 100.0, "", &lbl);
        Ok(())
    })
    .await
    .map_err(|e| format!("Restore task panicked: {e}"))?
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/// Delete a backup archive or INI folder from disk.
#[tauri::command]
pub async fn delete_backup(file_path: String) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
    } else {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Estimate the uncompressed size of the install directory (for full backup warning).
#[tauri::command]
pub async fn estimate_dir_size(dir_path: String) -> Result<u64, String> {
    let path = PathBuf::from(&dir_path);
    if !path.exists() {
        return Ok(0);
    }
    let mut total = 0u64;
    let mut stack = vec![path];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = fs::read_dir(&d) {
            for entry in rd.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    stack.push(p);
                } else if let Ok(meta) = fs::metadata(&p) {
                    total += meta.len();
                }
            }
        }
    }
    Ok(total)
}
