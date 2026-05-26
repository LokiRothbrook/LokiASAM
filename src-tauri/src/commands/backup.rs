use std::fs::{self, File};
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
use zip::write::{SimpleFileOptions, ZipWriter};
use zip::CompressionMethod;

use crate::events;

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
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupProgress {
    pub percent: f32,
    pub current_file: String,
}

/// Convert days since Unix epoch to (year, month, day).
fn days_to_ymd(mut days: u64) -> (u64, u64, u64) {
    days += 719_468;
    let era = days / 146_097;
    let doe = days % 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
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

/// Create a ZIP backup of the server's ShooterGame/Saved directory.
///
/// Files are streamed into the zip with `std::io::copy` — no full-file buffers.
/// The heavy zip work runs in `spawn_blocking` so the async runtime is not blocked.
/// Emits `backup://progress/{server_id}` events while zipping.
#[tauri::command]
pub async fn create_backup(
    app: AppHandle,
    server_id: String,
    server_name: String,
    install_path: String,
    backup_dir: String,
    map_id: String,
    triggered_by: String,
) -> Result<BackupRecord, String> {
    let saved_dir = PathBuf::from(&install_path)
        .join("ShooterGame")
        .join("Saved");
    if !saved_dir.exists() {
        return Err(format!(
            "Save directory not found: {}",
            saved_dir.display()
        ));
    }

    fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;

    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let secs_per_day = 86_400u64;
    let days = now_secs / secs_per_day;
    let day_secs = now_secs % secs_per_day;
    let (year, month, day) = days_to_ymd(days);
    let hh = day_secs / 3600;
    let mm = (day_secs % 3600) / 60;
    let ss = day_secs % 60;
    let timestamp = format!("{year:04}{month:02}{day:02}-{hh:02}{mm:02}{ss:02}");

    let safe_name: String = server_name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let zip_filename = format!("{safe_name}-{timestamp}.zip");
    let zip_path = PathBuf::from(&backup_dir).join(&zip_filename);

    // Collect file list before spawning so we know the total count.
    let mut all_files: Vec<PathBuf> = Vec::new();
    collect_files(&saved_dir, &mut all_files).map_err(|e| e.to_string())?;
    let total_files = all_files.len().max(1) as f32;

    // Run the blocking zip work on a dedicated thread.
    // AppHandle is Clone + Send so we can move it in for progress events.
    let app_clone = app.clone();
    let sid_clone = server_id.clone();
    let zip_path_clone = zip_path.clone();
    let saved_dir_clone = saved_dir.clone();

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let zip_file = File::create(&zip_path_clone).map_err(|e| e.to_string())?;
        let mut zip = ZipWriter::new(BufWriter::new(zip_file));
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated);

        for (idx, file_path) in all_files.iter().enumerate() {
            let rel = file_path
                .strip_prefix(&saved_dir_clone)
                .map_err(|e| e.to_string())?;
            let entry_name = rel.to_string_lossy().replace('\\', "/");

            let pct = (idx as f32 / total_files * 99.0).min(99.0);
            let _ = app_clone.emit(
                &format!("{}/{}", events::BACKUP_PROGRESS, sid_clone),
                BackupProgress { percent: pct, current_file: entry_name.clone() },
            );

            zip.start_file(&entry_name, options).map_err(|e| e.to_string())?;
            let mut src = File::open(file_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut src, &mut zip).map_err(|e| e.to_string())?;
        }

        zip.finish().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Backup task panicked: {e}"))??;

    let _ = app.emit(
        &format!("{}/{}", events::BACKUP_PROGRESS, server_id),
        BackupProgress { percent: 100.0, current_file: zip_filename.clone() },
    );

    let file_size = fs::metadata(&zip_path)
        .map_err(|e| e.to_string())?
        .len();

    let created_at = format!(
        "{year:04}-{month:02}-{day:02}T{hh:02}:{mm:02}:{ss:02}Z"
    );

    Ok(BackupRecord {
        id: Uuid::new_v4().to_string(),
        server_id,
        file_path: zip_path.to_string_lossy().to_string(),
        file_size_bytes: file_size,
        map_id,
        triggered_by,
        created_at,
    })
}

/// Restore a backup by extracting the zip over ShooterGame/Saved.
///
/// Files are streamed from the zip entry with `std::io::copy` — no full-file buffers.
/// The frontend stops the server before calling this and restarts it after.
#[tauri::command]
pub async fn restore_backup(
    app: AppHandle,
    server_id: String,
    backup_file_path: String,
    install_path: String,
) -> Result<(), String> {
    let zip_path = PathBuf::from(&backup_file_path);
    if !zip_path.exists() {
        return Err(format!("Backup file not found: {}", zip_path.display()));
    }

    let saved_dir = PathBuf::from(&install_path)
        .join("ShooterGame")
        .join("Saved");

    let app_clone = app.clone();
    let sid_clone = server_id.clone();

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        if saved_dir.exists() {
            fs::remove_dir_all(&saved_dir).map_err(|e| e.to_string())?;
        }
        fs::create_dir_all(&saved_dir).map_err(|e| e.to_string())?;

        let file = std::fs::File::open(&zip_path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        let total = archive.len().max(1) as f32;

        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
            let entry_name = entry.name().to_string();

            // Guard against path traversal.
            if entry_name.contains("..") || Path::new(&entry_name).is_absolute() {
                return Err(format!("Unsafe path in backup archive: {entry_name}"));
            }

            let out_path = saved_dir.join(&entry_name);

            if entry_name.ends_with('/') {
                fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            } else {
                if let Some(parent) = out_path.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
                std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
            }

            let pct = ((i + 1) as f32 / total * 100.0).min(100.0);
            let _ = app_clone.emit(
                &format!("{}/{}", events::BACKUP_PROGRESS, sid_clone),
                BackupProgress { percent: pct, current_file: entry_name },
            );
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Restore task panicked: {e}"))??;

    Ok(())
}

/// Delete a backup zip from disk. The caller removes the SQLite record.
#[tauri::command]
pub async fn delete_backup(file_path: String) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// No-op stub — backup pruning is handled by the frontend via individual delete calls.
#[tauri::command]
pub async fn prune_backups(_server_id: String) -> Result<u32, String> {
    Ok(0)
}
