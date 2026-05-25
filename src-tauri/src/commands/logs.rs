use std::io::SeekFrom;
use std::sync::{atomic::Ordering, Arc};
use tauri::{Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncSeekExt, BufReader};

use crate::state::log_watcher::LogWatcherState;

/// Begin tailing `log_path` for `server_id`.
/// A background tokio task polls the file every 200 ms, seeking to the current
/// end on start so only new lines are emitted. Each new line fires the event
/// `log://line/{server_id}` with a `LogLine` payload.
///
/// Calling this again for the same `server_id` replaces the previous watcher.
#[tauri::command]
pub async fn watch_server_log(
    app: tauri::AppHandle,
    server_id: String,
    log_path: String,
    state: State<'_, LogWatcherState>,
) -> Result<(), String> {
    let stop_flag = state.start(&server_id).await;
    let event_name = format!("log://line/{server_id}");

    tauri::async_runtime::spawn(async move {
        tail_log(app, event_name, log_path, stop_flag).await;
    });

    Ok(())
}

/// Stop the log watcher for `server_id` (no-op if not watching).
#[tauri::command]
pub async fn stop_log_watch(
    server_id: String,
    state: State<'_, LogWatcherState>,
) -> Result<(), String> {
    state.stop(&server_id).await;
    Ok(())
}

#[derive(Clone, serde::Serialize)]
pub struct LogLine {
    pub line: String,
    pub level: String,
}

/// Classify an ASA log line into a rough severity level.
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

async fn tail_log(
    app: tauri::AppHandle,
    event_name: String,
    log_path: String,
    stop_flag: Arc<std::sync::atomic::AtomicBool>,
) {
    use tokio::fs::File;

    // Wait for the log file to exist (server may not have started yet).
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

    // Seek to end so we only tail new content from this point.
    let _ = file.seek(SeekFrom::End(0)).await;

    let mut reader = BufReader::new(file);
    let mut line_buf = String::new();

    loop {
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }

        match reader.read_line(&mut line_buf).await {
            Ok(0) => {
                // No new data — sleep before next poll.
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            Ok(_) => {
                let trimmed = line_buf.trim_end_matches(['\n', '\r']).to_string();
                if !trimmed.is_empty() {
                    let level = classify_level(&trimmed).to_string();
                    let _ = app.emit(&event_name, LogLine { line: trimmed, level });
                }
                line_buf.clear();
            }
            Err(_) => break,
        }
    }
}
