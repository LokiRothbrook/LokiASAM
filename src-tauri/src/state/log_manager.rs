use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncSeekExt, BufReader};
use tokio::sync::Mutex;

use crate::events;

/// Manages all server log file watchers.
/// Replaces the old LogWatcherState — adds backfill of existing content on start.
pub struct LogManagerState {
    pub watchers: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl LogManagerState {
    pub fn new() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
        }
    }

    /// Start tailing `log_path` for `server_id`.
    ///
    /// 1. Reads all existing content from the beginning, emitting a single
    ///    `log://backfill/{server_id}` event with Vec<LogLine>.
    /// 2. Tails new lines from EOF, emitting `log://line/{server_id}` per line.
    ///
    /// Calling again for the same `server_id` cancels the previous watcher.
    pub async fn start_watcher(
        &self,
        server_id: &str,
        log_path: String,
        app: tauri::AppHandle,
    ) -> Arc<AtomicBool> {
        let stop_flag = Arc::new(AtomicBool::new(false));
        if let Some(old) = self
            .watchers
            .lock()
            .await
            .insert(server_id.to_string(), stop_flag.clone())
        {
            old.store(true, Ordering::Relaxed);
        }

        let server_id = server_id.to_string();
        let flag = stop_flag.clone();
        tauri::async_runtime::spawn(async move {
            tail_log_with_backfill(app, server_id, log_path, flag).await;
        });

        stop_flag
    }

    pub async fn stop_watcher(&self, server_id: &str) {
        if let Some(flag) = self.watchers.lock().await.remove(server_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    /// Resolve the central logs root: `{base_dir}/logs/`.
    /// Returns None if bootstrap.json is missing (setup not complete).
    pub fn logs_root(app: &tauri::AppHandle) -> Option<PathBuf> {
        let config_dir = app.path().app_config_dir().ok()?;
        let bootstrap_path = config_dir.join("bootstrap.json");
        let text = std::fs::read_to_string(&bootstrap_path).ok()?;
        let value: serde_json::Value = serde_json::from_str(&text).ok()?;
        let base_dir = value.get("baseDir")?.as_str()?;
        Some(PathBuf::from(base_dir).join("logs"))
    }

    /// Resolve per-server log directory: `{logs_root}/{server_id}/`.
    pub fn server_logs_dir(app: &tauri::AppHandle, server_id: &str) -> Option<PathBuf> {
        Some(Self::logs_root(app)?.join(server_id))
    }

    /// Archive ALL log and crash data from the server install directory to central
    /// storage before each server launch. Handles:
    ///   - ShooterGame.log → {server_id}/shootergame/ShooterGame_{ts}.log
    ///   - Other *.log files in Saved/Logs/ → {server_id}/other/{name}_{ts}.log
    ///   - Crash folders in Saved/Crashes/ → {server_id}/crashes/{folder}/
    ///
    /// Returns true if the main log was cleanly handled (or absent).
    pub async fn archive_all_server_logs(
        app: &tauri::AppHandle,
        server_id: &str,
        install_path: &str,
    ) -> bool {
        let timestamp = current_timestamp_str();
        let server_dir = Self::server_logs_dir(app, server_id);

        // ── ShooterGame.log ──────────────────────────────────────────────────
        let current_log = format!(
            "{}/ShooterGame/Saved/Logs/ShooterGame.log",
            install_path
        );
        let main_ok = if tokio::fs::metadata(&current_log).await.is_ok() {
            let ok = if let Some(dest_dir) = server_dir.as_ref().map(|d| d.join("shootergame")) {
                let _ = tokio::fs::create_dir_all(&dest_dir).await;
                let dest = dest_dir.join(format!("ShooterGame_{timestamp}.log"));
                move_file(&current_log, &dest).await
            } else {
                false
            };
            if !ok {
                // Fall back to delete so the new session starts at byte 0.
                tokio::fs::remove_file(&current_log).await.is_ok()
            } else {
                true
            }
        } else {
            true // no prior log — fresh install
        };

        // ── Other *.log files in Saved/Logs/ ────────────────────────────────
        let logs_src_dir = format!("{}/ShooterGame/Saved/Logs", install_path);
        if let Ok(mut rd) = tokio::fs::read_dir(&logs_src_dir).await {
            if let Some(other_dir) = server_dir.as_ref().map(|d| d.join("other")) {
                let _ = tokio::fs::create_dir_all(&other_dir).await;
                while let Ok(Some(entry)) = rd.next_entry().await {
                    let name = entry.file_name().to_string_lossy().to_string();
                    // Skip ShooterGame.log (handled above) and our own archives.
                    if name == "ShooterGame.log" || name.starts_with("ShooterGame_") {
                        continue;
                    }
                    if !name.ends_with(".log") {
                        continue;
                    }
                    let stem = name.trim_end_matches(".log");
                    let dest = other_dir.join(format!("{stem}_{timestamp}.log"));
                    let src = entry.path().to_string_lossy().to_string();
                    let _ = move_file(&src, &dest).await;
                }
            }
        }

        // ── Crash folders in Saved/Crashes/ ─────────────────────────────────
        let crashes_src = format!("{}/ShooterGame/Saved/Crashes", install_path);
        if let Ok(mut rd) = tokio::fs::read_dir(&crashes_src).await {
            if let Some(crashes_dir) = server_dir.as_ref().map(|d| d.join("crashes")) {
                let _ = tokio::fs::create_dir_all(&crashes_dir).await;
                while let Ok(Some(entry)) = rd.next_entry().await {
                    let meta = match entry.metadata().await {
                        Ok(m) => m,
                        Err(_) => continue,
                    };
                    if !meta.is_dir() {
                        continue;
                    }
                    let folder_name = entry.file_name().to_string_lossy().to_string();
                    let dest = crashes_dir.join(&folder_name);
                    // If destination already exists (same crash already moved), skip.
                    if dest.exists() {
                        continue;
                    }
                    let src = entry.path().to_string_lossy().to_string();
                    // Try rename first, then recursive copy+delete.
                    if tokio::fs::rename(&src, &dest).await.is_err() {
                        copy_dir_and_remove(&src, &dest).await;
                    }
                }
            }
        }

        main_ok
    }

    /// Append a chat line to today's chat log file.
    /// Called by the RCON manager when a GetChat line is received.
    pub async fn append_chat_line(app: &tauri::AppHandle, server_id: &str, line: &str) {
        let Some(dir) = Self::server_logs_dir(app, server_id)
            .map(|d| d.join("chat")) else { return };

        if tokio::fs::create_dir_all(&dir).await.is_err() {
            return;
        }

        let date = current_date_str();
        let path = dir.join(format!("chat_{date}.log"));
        let ts = current_time_str();
        let entry = format!("[{ts}] {line}\n");
        use tokio::io::AsyncWriteExt;
        if let Ok(mut f) = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
        {
            let _ = f.write_all(entry.as_bytes()).await;
        }
    }
}

// ---------------------------------------------------------------------------
// File/directory helpers
// ---------------------------------------------------------------------------

/// Move a file: try rename first (fast, same filesystem); fall back to copy+delete.
async fn move_file(src: &str, dest: &std::path::Path) -> bool {
    if tokio::fs::rename(src, dest).await.is_ok() {
        return true;
    }
    if tokio::fs::copy(src, dest).await.is_ok() {
        let _ = tokio::fs::remove_file(src).await;
        true
    } else {
        false
    }
}

/// Recursively copy a directory then remove the source.
async fn copy_dir_and_remove(src: &str, dest: &std::path::Path) {
    let src_path = std::path::Path::new(src);
    if let Err(_) = tokio::fs::create_dir_all(dest).await {
        return;
    }
    let mut rd = match tokio::fs::read_dir(src_path).await {
        Ok(r) => r,
        Err(_) => return,
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        let dest_file = dest.join(entry.file_name());
        let _ = tokio::fs::copy(entry.path(), &dest_file).await;
    }
    let _ = tokio::fs::remove_dir_all(src_path).await;
}

// ---------------------------------------------------------------------------
// Tail task
// ---------------------------------------------------------------------------

#[derive(Clone, serde::Serialize)]
pub struct LogLine {
    pub line: String,
    pub level: String,
}

fn classify_level(line: &str) -> &'static str {
    let lower = line.to_ascii_lowercase();
    if lower.contains("error") || lower.contains("fatal") || lower.contains("critical") {
        "error"
    } else if lower.contains("warning") || lower.contains("warn") {
        "warning"
    } else {
        "info"
    }
}

async fn tail_log_with_backfill(
    app: tauri::AppHandle,
    server_id: String,
    log_path: String,
    stop_flag: Arc<AtomicBool>,
) {
    use tokio::fs::File;

    // Wait up to 60 s for the log file to appear (server may still be starting).
    let mut file = {
        let mut attempts = 0u32;
        loop {
            if stop_flag.load(Ordering::Relaxed) {
                return;
            }
            match File::open(&log_path).await {
                Ok(f) => break f,
                Err(_) => {
                    attempts += 1;
                    if attempts >= 60 {
                        return;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            }
        }
    };

    // ── Backfill: read only the tail of the file, not the whole thing ────────
    // Long-running servers can accumulate a ShooterGame.log hundreds of MB to
    // GB in size. Reading the entire file into memory and shipping it as one
    // giant IPC payload every time the Logs tab (re)connects was a real source
    // of CPU/memory spikes — cap both the bytes read and the lines kept.
    const BACKFILL_CAP_BYTES: u64 = 2 * 1024 * 1024; // 2 MB of recent content
    const BACKFILL_CAP_LINES: usize = 5000;

    let backfill_event = format!("{}/{server_id}", events::LOG_BACKFILL);
    let file_len = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    let start_offset = file_len.saturating_sub(BACKFILL_CAP_BYTES);
    if start_offset > 0 {
        let _ = file.seek(SeekFrom::Start(start_offset)).await;
    }

    let mut backfill: std::collections::VecDeque<LogLine> = std::collections::VecDeque::new();
    let mut buf = String::new();
    let mut reader = BufReader::new(&mut file);
    let mut first_line = start_offset > 0; // seeked mid-file — first read is likely a partial line
    loop {
        buf.clear();
        match reader.read_line(&mut buf).await {
            Ok(0) => break,
            Ok(_) => {
                if first_line {
                    // Discard: we seeked into the middle of the file, so this
                    // line is truncated at the start — not worth showing.
                    first_line = false;
                    continue;
                }
                let trimmed = buf.trim_end_matches(['\n', '\r']).to_string();
                if !trimmed.is_empty() {
                    let level = classify_level(&trimmed).to_string();
                    backfill.push_back(LogLine { line: trimmed, level });
                    if backfill.len() > BACKFILL_CAP_LINES {
                        backfill.pop_front();
                    }
                }
            }
            Err(_) => break,
        }
    }
    if !backfill.is_empty() {
        let backfill: Vec<LogLine> = backfill.into();
        let _ = app.emit(&backfill_event, &backfill);
    }

    // Seek to current EOF so we only tail truly new content.
    let _ = file.seek(SeekFrom::End(0)).await;

    // ── Tail: stream new lines as they arrive ────────────────────────────────
    let line_event  = format!("{}/{server_id}", events::LOG_LINE);
    let login_event = format!("{}/{server_id}", events::PLAYER_LOGIN);
    let mut reader = BufReader::new(file);
    let mut line_buf = String::new();

    loop {
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }
        match reader.read_line(&mut line_buf).await {
            Ok(0) => {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            Ok(_) => {
                let trimmed = line_buf.trim_end_matches(['\n', '\r']).to_string();
                if !trimmed.is_empty() {
                    let level = classify_level(&trimmed).to_string();
                    let _ = app.emit(&line_event, LogLine { line: trimmed.clone(), level });
                    if let Some((eos_id, ip)) = parse_player_login(&trimmed) {
                        let _ = app.emit(&login_event, serde_json::json!({ "eosId": eos_id, "ip": ip }));
                        let _ = app.emit(
                            crate::events::PLAYER_LOGIN_ANY,
                            serde_json::json!({ "serverId": server_id, "eosId": eos_id, "ip": ip }),
                        );
                        // Record connection + login backup in Rust (works even in tray).
                        let app2 = app.clone();
                        let sid2 = server_id.clone();
                        tauri::async_runtime::spawn(async move {
                            crate::commands::backup_manager::handle_player_login(
                                &app2, &sid2, &eos_id, &ip,
                            ).await;
                        });
                    }
                }
                line_buf.clear();
            }
            Err(_) => break,
        }
    }
}

/// Parse "IP for incoming account {EOS_ID} - IP {IP}" from a log line.
/// Returns (eos_id, ip) if matched.
fn parse_player_login(line: &str) -> Option<(String, String)> {
    let prefix = "IP for incoming account ";
    let sep    = " - IP ";
    let start  = line.find(prefix)?;
    let after  = &line[start + prefix.len()..];
    let mid    = after.find(sep)?;
    let eos_id = after[..mid].trim().to_string();
    let ip     = after[mid + sep.len()..].trim().to_string();
    if eos_id.chars().all(|c| c.is_ascii_hexdigit()) && !eos_id.is_empty() && !ip.is_empty() {
        Some((eos_id, ip))
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Time helpers (no external crate, manual calculation)
// ---------------------------------------------------------------------------

fn current_timestamp_str() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (y, mo, d, h, min, s) = epoch_to_ymdhms(secs);
    format!("{y:04}-{mo:02}-{d:02}_{h:02}-{min:02}-{s:02}")
}

pub fn current_date_str() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (y, mo, d, _, _, _) = epoch_to_ymdhms(secs);
    format!("{y:04}-{mo:02}-{d:02}")
}

fn current_time_str() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (_, _, _, h, min, s) = epoch_to_ymdhms(secs);
    format!("{h:02}:{min:02}:{s:02}")
}

pub fn epoch_to_ymdhms(now_secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    let secs_per_day = 86_400u64;
    let days = now_secs / secs_per_day;
    let day_secs = now_secs % secs_per_day;

    let mut d = days;
    let mut y = 1970u64;
    loop {
        let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
        let days_in_year = if leap { 366 } else { 365 };
        if d < days_in_year {
            break;
        }
        d -= days_in_year;
        y += 1;
    }
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let days_in_month = [
        31u64,
        if leap { 29 } else { 28 },
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut mo = 0usize;
    while mo < 12 && d >= days_in_month[mo] {
        d -= days_in_month[mo];
        mo += 1;
    }

    (
        y,
        (mo + 1) as u64,
        d + 1,
        day_secs / 3600,
        (day_secs % 3600) / 60,
        day_secs % 60,
    )
}
