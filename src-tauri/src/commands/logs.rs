use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::log_manager::LogManagerState;

// ---------------------------------------------------------------------------
// Public types (mirrored on the frontend)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedLogInfo {
    pub filename: String,
    pub size_bytes: u64,
    /// ISO timestamp derived from the filename (YYYY-MM-DD_HH-MM-SS).
    pub timestamp: String,
    pub full_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashInfo {
    pub folder_name: String,
    pub timestamp: String,
    pub has_call_stack: bool,
    pub files: Vec<String>,
    pub full_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashFile {
    pub name: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReport {
    pub folder_name: String,
    pub files: Vec<CrashFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatLogInfo {
    pub filename: String,
    pub date: String,
    pub size_bytes: u64,
    pub full_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStats {
    pub shootergame_archive_count: u32,
    pub shootergame_total_bytes: u64,
    pub chat_log_count: u32,
    pub chat_total_bytes: u64,
    pub crash_count: u32,
    pub storage_root: String,
}

// ---------------------------------------------------------------------------
// Watch commands
// ---------------------------------------------------------------------------

/// Start tailing ShooterGame.log for `server_id`.
/// Emits `log://backfill/{server_id}` with existing content then
/// `log://line/{server_id}` for each new line.
#[tauri::command]
pub async fn watch_server_log(
    app: tauri::AppHandle,
    server_id: String,
    log_path: String,
    state: State<'_, LogManagerState>,
) -> Result<(), String> {
    state.start_watcher(&server_id, log_path, app).await;
    Ok(())
}

/// Stop the log watcher for `server_id`.
#[tauri::command]
pub async fn stop_log_watch(
    server_id: String,
    state: State<'_, LogManagerState>,
) -> Result<(), String> {
    state.stop_watcher(&server_id).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Archive commands
// ---------------------------------------------------------------------------

/// List all archived ShooterGame log files for a server, newest first.
#[tauri::command]
pub async fn list_archived_logs(
    app: tauri::AppHandle,
    server_id: String,
) -> Result<Vec<ArchivedLogInfo>, String> {
    let dir = match LogManagerState::server_logs_dir(&app, &server_id)
        .map(|d| d.join("shootergame"))
    {
        Some(d) => d,
        None => return Ok(vec![]),
    };

    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut entries: Vec<ArchivedLogInfo> = Vec::new();
    let mut read_dir = tokio::fs::read_dir(&dir)
        .await
        .map_err(|e| format!("Failed to read log archive dir: {e}"))?;

    while let Some(entry) = read_dir.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".log") {
            continue;
        }
        let meta = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        let timestamp = extract_timestamp_from_filename(&name);
        entries.push(ArchivedLogInfo {
            filename: name,
            size_bytes: meta.len(),
            timestamp,
            full_path: entry.path().to_string_lossy().to_string(),
        });
    }

    // Sort newest first by filename (ISO timestamp sorts lexicographically).
    entries.sort_by(|a, b| b.filename.cmp(&a.filename));
    Ok(entries)
}

/// Read lines from an archived log file, with pagination.
/// `offset` is line index (0-based); `limit` is max lines to return.
/// Pass limit=0 to get all lines.
#[tauri::command]
pub async fn read_archived_log(
    app: tauri::AppHandle,
    server_id: String,
    filename: String,
    offset: usize,
    limit: usize,
) -> Result<Vec<String>, String> {
    let dir = LogManagerState::server_logs_dir(&app, &server_id)
        .map(|d| d.join("shootergame"))
        .ok_or("Log storage not configured")?;

    // Validate filename — no path traversal
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("Invalid filename".to_string());
    }

    let path = dir.join(&filename);
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read log: {e}"))?;

    let lines: Vec<String> = content
        .lines()
        .skip(offset)
        .take(if limit == 0 { usize::MAX } else { limit })
        .map(|l| l.to_string())
        .collect();

    Ok(lines)
}

/// Delete an archived log file.
#[tauri::command]
pub async fn delete_archived_log(
    app: tauri::AppHandle,
    server_id: String,
    filename: String,
) -> Result<(), String> {
    let dir = LogManagerState::server_logs_dir(&app, &server_id)
        .map(|d| d.join("shootergame"))
        .ok_or("Log storage not configured")?;

    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("Invalid filename".to_string());
    }

    tokio::fs::remove_file(dir.join(&filename))
        .await
        .map_err(|e| format!("Failed to delete log: {e}"))
}

// ---------------------------------------------------------------------------
// Crash commands
// ---------------------------------------------------------------------------

/// List crash reports from the server's central crash storage.
#[tauri::command]
pub async fn list_crashes(
    app: tauri::AppHandle,
    server_id: String,
) -> Result<Vec<CrashInfo>, String> {
    let dir = match LogManagerState::server_logs_dir(&app, &server_id)
        .map(|d| d.join("crashes"))
    {
        Some(d) => d,
        None => return Ok(vec![]),
    };

    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut crashes: Vec<CrashInfo> = Vec::new();
    let mut read_dir = tokio::fs::read_dir(&dir)
        .await
        .map_err(|e| format!("Failed to read crashes dir: {e}"))?;

    while let Some(entry) = read_dir.next_entry().await.map_err(|e| e.to_string())? {
        let meta = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_dir() {
            continue;
        }

        let folder_name = entry.file_name().to_string_lossy().to_string();
        let full_path = entry.path().to_string_lossy().to_string();

        let mut files: Vec<String> = Vec::new();
        let mut has_call_stack = false;

        if let Ok(mut inner) = tokio::fs::read_dir(entry.path()).await {
            while let Ok(Some(f)) = inner.next_entry().await {
                let fname = f.file_name().to_string_lossy().to_string();
                let fl = fname.to_lowercase();
                if fl.contains("callstack") || fl.contains("stack") {
                    has_call_stack = true;
                }
                files.push(fname);
            }
        }
        files.sort();

        let timestamp = folder_name_to_timestamp(&folder_name);
        crashes.push(CrashInfo { folder_name, timestamp, has_call_stack, files, full_path });
    }

    crashes.sort_by(|a, b| b.folder_name.cmp(&a.folder_name));
    Ok(crashes)
}

/// Read all readable (non-binary) files from a crash folder in central storage.
#[tauri::command]
pub async fn read_crash_report(
    app: tauri::AppHandle,
    server_id: String,
    folder_name: String,
) -> Result<CrashReport, String> {
    if folder_name.contains('/') || folder_name.contains('\\') || folder_name.contains("..") {
        return Err("Invalid folder name".to_string());
    }

    let dir = LogManagerState::server_logs_dir(&app, &server_id)
        .map(|d| d.join("crashes"))
        .ok_or("Log storage not configured")?;

    let folder_path = dir.join(&folder_name);
    if !folder_path.exists() {
        return Err("Crash folder not found".to_string());
    }

    let mut files: Vec<CrashFile> = Vec::new();
    let mut read_dir = tokio::fs::read_dir(&folder_path)
        .await
        .map_err(|e| format!("Failed to read crash folder: {e}"))?;

    while let Some(entry) = read_dir.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        if lower.ends_with(".dmp") || lower.ends_with(".png") || lower.ends_with(".jpg") || lower.ends_with(".bin") {
            continue;
        }
        let content = tokio::fs::read_to_string(entry.path())
            .await
            .unwrap_or_else(|_| "[binary or unreadable file]".to_string());
        files.push(CrashFile { name, content });
    }

    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(CrashReport { folder_name, files })
}

/// Delete a crash report folder from central storage.
#[tauri::command]
pub async fn delete_crash_report(
    app: tauri::AppHandle,
    server_id: String,
    folder_name: String,
) -> Result<(), String> {
    if folder_name.contains('/') || folder_name.contains('\\') || folder_name.contains("..") {
        return Err("Invalid folder name".to_string());
    }

    let dir = LogManagerState::server_logs_dir(&app, &server_id)
        .map(|d| d.join("crashes"))
        .ok_or("Log storage not configured")?;

    tokio::fs::remove_dir_all(dir.join(&folder_name))
        .await
        .map_err(|e| format!("Failed to delete crash report: {e}"))
}

// ---------------------------------------------------------------------------
// Other log commands (secondary engine logs collected at server start)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OtherLogInfo {
    pub filename: String,
    pub size_bytes: u64,
    pub timestamp: String,
    pub full_path: String,
}

/// List secondary log files collected to central storage (non-ShooterGame logs).
#[tauri::command]
pub async fn list_other_logs(
    app: tauri::AppHandle,
    server_id: String,
) -> Result<Vec<OtherLogInfo>, String> {
    let dir = match LogManagerState::server_logs_dir(&app, &server_id)
        .map(|d| d.join("other"))
    {
        Some(d) => d,
        None => return Ok(vec![]),
    };

    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut entries: Vec<OtherLogInfo> = Vec::new();
    let mut read_dir = tokio::fs::read_dir(&dir)
        .await
        .map_err(|e| format!("Failed to read other logs dir: {e}"))?;

    while let Some(entry) = read_dir.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".log") {
            continue;
        }
        let meta = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        let timestamp = extract_timestamp_from_filename(&name);
        entries.push(OtherLogInfo {
            filename: name,
            size_bytes: meta.len(),
            timestamp,
            full_path: entry.path().to_string_lossy().to_string(),
        });
    }

    entries.sort_by(|a, b| b.filename.cmp(&a.filename));
    Ok(entries)
}

/// Read lines from an other log file.
#[tauri::command]
pub async fn read_other_log(
    app: tauri::AppHandle,
    server_id: String,
    filename: String,
    offset: usize,
    limit: usize,
) -> Result<Vec<String>, String> {
    let dir = LogManagerState::server_logs_dir(&app, &server_id)
        .map(|d| d.join("other"))
        .ok_or("Log storage not configured")?;

    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("Invalid filename".to_string());
    }

    let path = dir.join(&filename);
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read log: {e}"))?;

    let lines: Vec<String> = content
        .lines()
        .skip(offset)
        .take(if limit == 0 { usize::MAX } else { limit })
        .map(|l| l.to_string())
        .collect();

    Ok(lines)
}

// ---------------------------------------------------------------------------
// Chat log commands
// ---------------------------------------------------------------------------

/// List all chat log files for a server, newest first.
#[tauri::command]
pub async fn list_chat_logs(
    app: tauri::AppHandle,
    server_id: String,
) -> Result<Vec<ChatLogInfo>, String> {
    let dir = match LogManagerState::server_logs_dir(&app, &server_id)
        .map(|d| d.join("chat"))
    {
        Some(d) => d,
        None => return Ok(vec![]),
    };

    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut entries: Vec<ChatLogInfo> = Vec::new();
    let mut read_dir = tokio::fs::read_dir(&dir)
        .await
        .map_err(|e| format!("Failed to read chat log dir: {e}"))?;

    while let Some(entry) = read_dir.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".log") {
            continue;
        }
        let meta = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        // filename: chat_YYYY-MM-DD.log → date: YYYY-MM-DD
        let date = name
            .strip_prefix("chat_")
            .and_then(|s| s.strip_suffix(".log"))
            .unwrap_or(&name)
            .to_string();
        entries.push(ChatLogInfo {
            filename: name,
            date,
            size_bytes: meta.len(),
            full_path: entry.path().to_string_lossy().to_string(),
        });
    }

    entries.sort_by(|a, b| b.filename.cmp(&a.filename));
    Ok(entries)
}

/// Read lines from a chat log file.
#[tauri::command]
pub async fn read_chat_log(
    app: tauri::AppHandle,
    server_id: String,
    filename: String,
    offset: usize,
    limit: usize,
) -> Result<Vec<String>, String> {
    let dir = LogManagerState::server_logs_dir(&app, &server_id)
        .map(|d| d.join("chat"))
        .ok_or("Log storage not configured")?;

    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("Invalid filename".to_string());
    }

    let path = dir.join(&filename);
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read chat log: {e}"))?;

    let lines: Vec<String> = content
        .lines()
        .skip(offset)
        .take(if limit == 0 { usize::MAX } else { limit })
        .map(|l| l.to_string())
        .collect();

    Ok(lines)
}

// ---------------------------------------------------------------------------
// Cleanup + stats
// ---------------------------------------------------------------------------

/// Delete all archived ShooterGame logs older than `older_than_days` days.
/// Returns the number of files deleted.
#[tauri::command]
pub async fn cleanup_logs(
    app: tauri::AppHandle,
    server_id: String,
    older_than_days: u32,
) -> Result<u32, String> {
    let dir = match LogManagerState::server_logs_dir(&app, &server_id)
        .map(|d| d.join("shootergame"))
    {
        Some(d) => d,
        None => return Ok(0),
    };

    if !dir.exists() {
        return Ok(0);
    }

    let cutoff_secs = {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            .saturating_sub(older_than_days as u64 * 86_400)
    };

    let mut deleted = 0u32;
    let mut read_dir = tokio::fs::read_dir(&dir)
        .await
        .map_err(|e| format!("Failed to read log dir: {e}"))?;

    while let Some(entry) = read_dir.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".log") {
            continue;
        }
        let meta = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified_secs = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        if modified_secs < cutoff_secs {
            if tokio::fs::remove_file(entry.path()).await.is_ok() {
                deleted += 1;
            }
        }
    }

    Ok(deleted)
}

/// Get log storage statistics for a server.
#[tauri::command]
pub async fn get_log_stats(
    app: tauri::AppHandle,
    server_id: String,
) -> Result<LogStats, String> {
    let root = LogManagerState::server_logs_dir(&app, &server_id);
    let storage_root = root
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let sg_dir = root.as_ref().map(|d| d.join("shootergame"));
    let chat_dir = root.as_ref().map(|d| d.join("chat"));
    let crash_dir = root.as_ref().map(|d| {
        // crashes live in the install dir, but we reference them from here
        d.clone()
    });
    let _ = crash_dir; // placeholder until we store crashes centrally

    let (sg_count, sg_bytes) = count_dir(sg_dir.as_deref()).await;
    let (chat_count, chat_bytes) = count_dir(chat_dir.as_deref()).await;

    Ok(LogStats {
        shootergame_archive_count: sg_count,
        shootergame_total_bytes: sg_bytes,
        chat_log_count: chat_count,
        chat_total_bytes: chat_bytes,
        crash_count: 0, // populated by list_crashes on demand
        storage_root,
    })
}

/// Return the path to the central logs storage root (for display in UI).
#[tauri::command]
pub fn get_log_storage_root(app: tauri::AppHandle) -> String {
    LogManagerState::logs_root(&app)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn count_dir(dir: Option<&std::path::Path>) -> (u32, u64) {
    let dir = match dir {
        Some(d) if d.exists() => d,
        _ => return (0, 0),
    };
    let mut count = 0u32;
    let mut bytes = 0u64;
    if let Ok(mut rd) = tokio::fs::read_dir(dir).await {
        while let Ok(Some(entry)) = rd.next_entry().await {
            if let Ok(meta) = entry.metadata().await {
                if meta.is_file() {
                    count += 1;
                    bytes += meta.len();
                }
            }
        }
    }
    (count, bytes)
}

/// Extract the timestamp string from a filename like `ShooterGame_2026-06-08_14-30-00.log`.
fn extract_timestamp_from_filename(name: &str) -> String {
    // ShooterGame_YYYY-MM-DD_HH-MM-SS.log
    name.trim_start_matches("ShooterGame_")
        .trim_end_matches(".log")
        .replace('_', " ")
        .replace('-', if name.contains("_") { "-" } else { "-" })
        .to_string()
}

/// Convert a UE5 crash folder name (e.g. `UE5-ShooterGame-Win64-2026.06.08-14.30.00`) to a readable string.
fn folder_name_to_timestamp(folder: &str) -> String {
    // Try to extract any date-like portion.
    // Common patterns: 2026.06.08-14.30.00 or 2026-06-08_14-30-00
    for part in folder.split('-') {
        if part.len() >= 4 && part.chars().next().map_or(false, |c| c.is_ascii_digit()) {
            return part.replace('.', "-");
        }
    }
    folder.to_string()
}
