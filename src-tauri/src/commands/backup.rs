use std::fs::{self, File};
use std::io::{Read, Write, BufWriter};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
use zip::write::{ZipWriter, SimpleFileOptions};
use zip::CompressionMethod;

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

/// Convert days since Unix epoch (1970-01-01) to (year, month, day).
fn days_to_ymd(mut days: u64) -> (u64, u64, u64) {
    // Proleptic Gregorian algorithm
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

/// Recursively collect all file paths under `dir` into `out`.
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
/// Emits `backup://progress/{server_id}` events while zipping.
/// Returns a BackupRecord — the caller (frontend) persists it to SQLite.
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
    // Format as YYYYMMDD-HHMMSS from unix seconds (UTC)
    let secs_per_day = 86_400u64;
    let days = now_secs / secs_per_day;
    let day_secs = now_secs % secs_per_day;
    // Days since Unix epoch → Gregorian date (simple algorithm)
    let (year, month, day) = days_to_ymd(days);
    let hh = day_secs / 3600;
    let mm = (day_secs % 3600) / 60;
    let ss = day_secs % 60;
    let timestamp = format!("{:04}{:02}{:02}-{:02}{:02}{:02}", year, month, day, hh, mm, ss);

    let safe_name: String = server_name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let zip_filename = format!("{}-{}.zip", safe_name, timestamp);
    let zip_path = PathBuf::from(&backup_dir).join(&zip_filename);

    let mut all_files: Vec<PathBuf> = Vec::new();
    collect_files(&saved_dir, &mut all_files).map_err(|e| e.to_string())?;
    let total_files = all_files.len().max(1) as f32;

    let zip_file = File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(BufWriter::new(zip_file));
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated);

    for (idx, file_path) in all_files.iter().enumerate() {
        let rel = file_path
            .strip_prefix(&saved_dir)
            .map_err(|e| e.to_string())?;
        let entry_name = rel.to_string_lossy().replace('\\', "/");

        let pct = (idx as f32 / total_files * 99.0).min(99.0);
        let _ = app.emit(
            &format!("backup://progress/{}", server_id),
            BackupProgress { percent: pct, current_file: entry_name.clone() },
        );

        zip.start_file(&entry_name, options).map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        File::open(file_path)
            .and_then(|mut f| f.read_to_end(&mut buf))
            .map_err(|e| e.to_string())?;
        zip.write_all(&buf).map_err(|e| e.to_string())?;
    }

    zip.finish().map_err(|e| e.to_string())?;

    let _ = app.emit(
        &format!("backup://progress/{}", server_id),
        BackupProgress { percent: 100.0, current_file: zip_filename.clone() },
    );

    let file_size = fs::metadata(&zip_path)
        .map_err(|e| e.to_string())?
        .len();

    // RFC 3339 timestamp from unix seconds
    let created_at = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hh, mm, ss
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
/// The frontend stops the server before calling this and restarts it after.
/// Emits `backup://progress/{server_id}` events while extracting.
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

    if saved_dir.exists() {
        fs::remove_dir_all(&saved_dir).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&saved_dir).map_err(|e| e.to_string())?;

    let file = File::open(&zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let total = archive.len().max(1) as f32;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let entry_name = entry.name().to_string();

        // Guard against path-traversal in zip entries.
        if entry_name.contains("..") || Path::new(&entry_name).is_absolute() {
            return Err(format!("Unsafe path in backup archive: {}", entry_name));
        }

        let out_path = saved_dir.join(&entry_name);

        if entry_name.ends_with('/') {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            File::create(&out_path)
                .and_then(|mut f| f.write_all(&buf))
                .map_err(|e| e.to_string())?;
        }

        let pct = ((i + 1) as f32 / total * 100.0).min(100.0);
        let _ = app.emit(
            &format!("backup://progress/{}", server_id),
            BackupProgress { percent: pct, current_file: entry_name },
        );
    }

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

/// No-op stub kept for API compatibility.
/// Backup pruning is handled entirely by the frontend.
#[tauri::command]
pub async fn prune_backups(_server_id: String) -> Result<u32, String> {
    Ok(0)
}
