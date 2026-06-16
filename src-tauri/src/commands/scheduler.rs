use crate::state::{scheduler::SchedulerState, AppState};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::time::{sleep, Duration};
use uuid::Uuid;

use super::server::{inner_start_server, inner_stop_server, StartServerParams};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleConfig {
    pub server_id: String,
    pub schedule_type: String,
    pub cron_expression: String,
    pub config_json: String,
}

/// Emitted as the payload of `scheduler://fired` so the frontend can update
/// SQLite (last_run / next_run) and requeue the entry via sync_schedules.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerFiredPayload {
    pub schedule_id: String,
    pub server_id: String,
    pub server_name: String,
    pub schedule_type: String,
    pub success: bool,
    pub error: Option<String>,
    /// All backup records created by this firing (player backups produce one per player).
    pub backup_records: Vec<crate::commands::backup::BackupRecord>,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Generate and return a UUID for a new schedule.
/// All schedule persistence is handled by the frontend via SQLite (db.ts).
#[tauri::command]
pub async fn create_schedule(_config: ScheduleConfig) -> Result<String, String> {
    Ok(Uuid::new_v4().to_string())
}

/// No-op — the frontend removes the schedule record from SQLite, then calls sync_schedules.
#[tauri::command]
pub async fn delete_schedule(_schedule_id: String) -> Result<(), String> {
    Ok(())
}

/// No-op — the frontend updates the enabled flag in SQLite, then calls sync_schedules.
#[tauri::command]
pub async fn toggle_schedule(_schedule_id: String, _enabled: bool) -> Result<(), String> {
    Ok(())
}

/// Atomically replace all active schedule entries.
///
/// Called by the frontend whenever schedules are created, updated, toggled, or deleted,
/// and once on startup after the DB is ready. Rust fires entries purely based on
/// `next_run_ms` — cron parsing lives entirely in the frontend (cron-parser).
///
/// Preserves `u64::MAX` for any entry that is currently in-flight (still running a
/// backup). The frontend may push a stale `next_run_ms` for such entries before it
/// has had a chance to update the DB; overwriting `u64::MAX` would cause an immediate
/// re-fire on the next tick.
#[tauri::command]
pub async fn sync_schedules(
    entries: Vec<crate::state::scheduler::ScheduleEntry>,
    state: tauri::State<'_, SchedulerState>,
) -> Result<(), String> {
    let mut store = state.entries.lock().unwrap();
    let mut updated = entries;
    for entry in updated.iter_mut() {
        if let Some(existing) = store.iter().find(|e| e.schedule_id == entry.schedule_id) {
            if existing.next_run_ms == u64::MAX {
                // Entry is currently in-flight — don't overwrite the guard.
                entry.next_run_ms = u64::MAX;
            }
        }
    }
    *store = updated;
    Ok(())
}

// ---------------------------------------------------------------------------
// Internal fire helpers — called by the background scheduler task in lib.rs
// ---------------------------------------------------------------------------

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Open a one-shot RCON connection, send one command, then drop the connection.
/// Silently swallows all errors — broadcast failures must never block a schedule.
async fn transient_rcon_send(port: u16, password: &str, command: &str) {
    use crate::state::rcon_pool::{RconConn, RCON_AUTH, RCON_AUTH_RESPONSE, RCON_EXECCOMMAND};
    use tokio::net::TcpStream;
    use tokio::time::timeout;

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let stream = match timeout(Duration::from_secs(5), TcpStream::connect(addr)).await {
        Ok(Ok(s)) => s,
        _ => return,
    };
    let _ = stream.set_nodelay(true);
    let mut conn = RconConn { stream, next_id: 1 };

    if conn.send_packet(1, RCON_AUTH, password).await.is_err() {
        return;
    }
    // Wait for auth response (up to 3 packets).
    for _ in 0..3 {
        match timeout(Duration::from_secs(5), conn.recv_packet()).await {
            Ok(Ok((_, t, _))) if t == RCON_AUTH_RESPONSE => break,
            Ok(Err(_)) | Err(_) => return,
            _ => {}
        }
    }

    let _ = timeout(
        Duration::from_secs(5),
        conn.send_packet(2, RCON_EXECCOMMAND, command),
    )
    .await;
    // Don't wait for a response — fire-and-forget.
}

async fn fire_broadcast(app: &AppHandle, entry: &crate::state::scheduler::ScheduleEntry) -> Result<(), String> {
    let cfg: serde_json::Value =
        serde_json::from_str(&entry.config_json).unwrap_or_default();
    let message = cfg["message"]
        .as_str()
        .unwrap_or("Server broadcast.")
        .to_string();
    transient_rcon_send(entry.rcon_port, &entry.rcon_password, &format!("ServerChat {message}")).await;
    let _ = app; // no app events needed for chat
    Ok(())
}

async fn fire_restart(app: &AppHandle, entry: &crate::state::scheduler::ScheduleEntry) -> Result<(), String> {
    if !is_server_running(app, &entry.server_id) {
        return Ok(());
    }

    let cfg: serde_json::Value = serde_json::from_str(&entry.config_json).unwrap_or_default();
    let warn_minutes  = if cfg["broadcastWarning"].as_bool().unwrap_or(false) { cfg["warningMinutes"].as_u64().unwrap_or(0) } else { 0 };
    let message       = cfg["message"].as_str().unwrap_or("Server restarting in {time}.").to_string();
    let cancel_msg    = cfg["cancelMessage"].as_str().unwrap_or("").to_string();

    let (tx, mut rx) = tokio::sync::mpsc::channel::<crate::state::CountdownSignal>(1);
    {
        let state = app.state::<AppState>();
        state.countdowns.lock().unwrap().insert(entry.server_id.clone(), tx);
    }

    let result = super::countdown::run_countdown(
        app,
        &entry.server_id,
        warn_minutes * 60,
        entry.rcon_port,
        &entry.rcon_password,
        &message,
        &cancel_msg,
        "restart",
        &mut rx,
    ).await;

    {
        let state = app.state::<AppState>();
        state.countdowns.lock().unwrap().remove(&entry.server_id);
    }

    if matches!(result, super::countdown::CountdownResult::Cancel) {
        return Ok(());
    }

    transient_rcon_send(entry.rcon_port, &entry.rcon_password, "saveworld").await;
    sleep(Duration::from_secs(3)).await;
    transient_rcon_send(entry.rcon_port, &entry.rcon_password, "doexit").await;

    for _ in 0..60 {
        sleep(Duration::from_millis(500)).await;
        if !is_server_running(app, &entry.server_id) { break; }
    }
    let _ = inner_stop_server(app, &entry.server_id, false);

    let params = entry_to_start_params(entry);
    inner_start_server(app.clone(), params).await.map(|_| ())
}

/// Run a global cache update check: update the shared SteamCMD cache, compare
/// old vs new build IDs, and emit `asa://update-check` so the frontend can
/// mark outdated servers and prompt the user.
async fn fire_global_update_check(
    app: &AppHandle,
    entry: &crate::state::scheduler::ScheduleEntry,
) -> Result<(), String> {
    let sep = if entry.base_dir.contains('\\') { '\\' } else { '/' };
    let cache_dir = format!("{}{sep}lokiasam{sep}cache{sep}asa-server", entry.base_dir);

    let old_build = crate::commands::steamcmd::get_cache_build_id(&cache_dir)
        .unwrap_or_else(|| "0".to_string());

    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| format!("Failed to create cache dir: {e}"))?;

    crate::commands::steamcmd::steamcmd_app_update(
        app,
        &entry.steamcmd_path,
        &cache_dir,
        false,
        "steamcmd://output/global-update-check",
        None,
    )
    .await?;

    let new_build = crate::commands::steamcmd::get_cache_build_id(&cache_dir)
        .unwrap_or_else(|| old_build.clone());

    let _ = app.emit(
        crate::events::ASA_UPDATE_CHECK,
        serde_json::json!({
            "updateAvailable": new_build != old_build,
            "cachedBuildId":   old_build,
            "latestBuildId":   new_build,
        }),
    );

    Ok(())
}

async fn fire_update(app: &AppHandle, entry: &crate::state::scheduler::ScheduleEntry) -> Result<(), String> {
    let cfg: serde_json::Value = serde_json::from_str(&entry.config_json).unwrap_or_default();

    let sep = if entry.base_dir.contains('\\') { '\\' } else { '/' };
    let cache_dir = format!("{}{sep}lokiasam{sep}cache{sep}asa-server", entry.base_dir);

    let is_running    = is_server_running(app, &entry.server_id);
    let warn_minutes  = if cfg["broadcastWarning"].as_bool().unwrap_or(false) { cfg["warningMinutes"].as_u64().unwrap_or(0) } else { 0 };
    let skip_if_players = cfg["skipIfPlayersOnline"].as_bool().unwrap_or(false);
    let restart_after   = cfg["restartAfterUpdate"].as_bool().unwrap_or(true);
    let message         = cfg["message"].as_str().unwrap_or("Server going down for update in {time}.").to_string();
    let cancel_msg      = cfg["cancelMessage"].as_str().unwrap_or("").to_string();

    // Skip entirely if players are online and the schedule says to.
    if is_running && skip_if_players {
        let resp = super::rcon::transient_rcon_command(entry.rcon_port, &entry.rcon_password, "listplayers")
            .await
            .unwrap_or_default();
        let has_players = !resp.trim().is_empty() && !resp.to_lowercase().contains("no players");
        if has_players {
            return Ok(());
        }
    }

    if is_running {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<crate::state::CountdownSignal>(1);
        {
            let state = app.state::<AppState>();
            state.countdowns.lock().unwrap().insert(entry.server_id.clone(), tx);
        }

        let result = super::countdown::run_countdown(
            app,
            &entry.server_id,
            warn_minutes * 60,
            entry.rcon_port,
            &entry.rcon_password,
            &message,
            &cancel_msg,
            "update",
            &mut rx,
        ).await;

        {
            let state = app.state::<AppState>();
            state.countdowns.lock().unwrap().remove(&entry.server_id);
        }

        if matches!(result, super::countdown::CountdownResult::Cancel) {
            return Ok(());
        }

        transient_rcon_send(entry.rcon_port, &entry.rcon_password, "saveworld").await;
        sleep(Duration::from_secs(3)).await;
        transient_rcon_send(entry.rcon_port, &entry.rcon_password, "doexit").await;

        for _ in 0..60 {
            sleep(Duration::from_millis(500)).await;
            if !is_server_running(app, &entry.server_id) { break; }
        }
        let _ = inner_stop_server(app, &entry.server_id, false);
    }

    // Emit "updating" so the server card shows the spinner.
    use crate::commands::server::{emit_status, ServerStatus};
    emit_status(app, &ServerStatus {
        server_id: entry.server_id.clone(),
        status: "updating".into(),
        pid: None,
        uptime_seconds: None,
        error: None,
    });

    // Update shared cache via SteamCMD.
    let channel = format!("steamcmd://output/{}", entry.server_id);
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| format!("Failed to create cache dir: {e}"))?;

    crate::commands::steamcmd::steamcmd_app_update(
        app, &entry.steamcmd_path, &cache_dir, false, &channel, None,
    ).await?;

    // Sync updated files to the server directory (preserving Saved/).
    let cache_path  = std::path::PathBuf::from(&cache_dir);
    let server_path = std::path::PathBuf::from(&entry.install_path);
    tokio::task::spawn_blocking(move || {
        crate::commands::steamcmd::sync_cache_to_server(&cache_path, &server_path)
    })
    .await
    .map_err(|e| format!("Sync task panicked: {e}"))?
    .map_err(|e| format!("Failed to sync server files: {e}"))?;

    let _ = app.emit(crate::events::ASA_UPDATE_CHECK, serde_json::json!({
        "updateApplied": true,
        "serverId": entry.server_id,
    }));

    // Restart if requested and server was running.
    if restart_after && is_running {
        let params = entry_to_start_params(entry);
        inner_start_server(app.clone(), params).await.map(|_| ())?;
    }

    Ok(())
}

fn entry_to_start_params(entry: &crate::state::scheduler::ScheduleEntry) -> StartServerParams {
    StartServerParams {
        server_id: entry.server_id.clone(),
        server_name: entry.server_name.clone(),
        install_path: entry.install_path.clone(),
        map_path: entry.map_path.clone(),
        port: entry.port,
        query_port: entry.query_port,
        rcon_port: entry.rcon_port,
        rcon_password: entry.rcon_password.clone(),
        extra_args: entry.extra_args.clone(),
        mod_ids: entry.mod_ids.clone(),
        proton_path: entry.proton_path.clone(),
        prefix_path: entry.prefix_path.clone(),
    }
}

/// Returns true if a server is currently running (checked via AppState).
fn is_server_running(app: &AppHandle, server_id: &str) -> bool {
    app.state::<AppState>()
        .running_servers
        .lock()
        .unwrap()
        .contains_key(server_id)
}

/// Called by the background scheduler loop in lib.rs.
/// Checks for due entries, fires them in separate spawned tasks, and marks them
/// as fired (next_run_ms = u64::MAX) to prevent double-fire until the frontend resyncs.
pub fn tick_scheduler(app: &AppHandle) {
    let now = now_ms();

    let scheduler = app.state::<SchedulerState>();
    let due: Vec<crate::state::scheduler::ScheduleEntry> = {
        let mut entries = scheduler.entries.lock().unwrap();
        let mut due = Vec::new();
        for entry in entries.iter_mut() {
            if entry.enabled && entry.next_run_ms != u64::MAX && entry.next_run_ms <= now {
                entry.next_run_ms = u64::MAX; // prevent double-fire
                due.push(entry.clone());
            }
        }
        due
    };

    for entry in due {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let schedule_type = entry.schedule_type.clone();
            let schedule_id = entry.schedule_id.clone();
            let server_id = entry.server_id.clone();
            let server_name = entry.server_name.clone();

            let (success, error, backup_records) = match schedule_type.as_str() {
                "broadcast" => match fire_broadcast(&app, &entry).await {
                    Ok(_) => (true, None, vec![]),
                    Err(e) => (false, Some(e), vec![]),
                },
                "restart" => match fire_restart(&app, &entry).await {
                    Ok(_) => (true, None, vec![]),
                    Err(e) => (false, Some(e), vec![]),
                },
                "update" => match fire_update(&app, &entry).await {
                    Ok(_) => (true, None, vec![]),
                    Err(e) => (false, Some(e), vec![]),
                },
                "global_update_check" => match fire_global_update_check(&app, &entry).await {
                    Ok(_) => (true, None, vec![]),
                    Err(e) => (false, Some(e), vec![]),
                },
                _ => (false, Some(format!("Unknown schedule type: {schedule_type}")), vec![]),
            };

            let _ = app.emit(
                "scheduler://fired",
                SchedulerFiredPayload {
                    schedule_id,
                    server_id,
                    server_name,
                    schedule_type,
                    success,
                    error,
                    backup_records,
                },
            );
        });
    }
}
