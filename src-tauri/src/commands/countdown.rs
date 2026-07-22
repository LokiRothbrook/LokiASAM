use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};
use serde::{Deserialize, Serialize};

use crate::state::AppState;
use crate::state::CountdownSignal;
use super::server::{inner_start_server, StartServerParams};

// ---------------------------------------------------------------------------
// Tauri event payload
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountdownPayload {
    pub server_id: String,
    /// "restart" | "update" | null (null = countdown cleared)
    pub action: Option<String>,
    pub remaining_secs: u64,
    pub total_secs: u64,
}

const COUNTDOWN_EVENT: &str = "server://countdown";

// ---------------------------------------------------------------------------
// RCON helper (fire-and-forget, never blocks the countdown)
// ---------------------------------------------------------------------------

async fn rcon_send(rcon_port: u16, rcon_password: &str, cmd: &str) {
    let _ = super::rcon::transient_rcon_command(rcon_port, rcon_password, cmd).await;
}

// ---------------------------------------------------------------------------
// Result type returned by run_countdown
// ---------------------------------------------------------------------------

pub enum CountdownResult {
    Proceed,
    Cancel,
}

// ---------------------------------------------------------------------------
// Format a duration into "Xh Ym", "Xm Ys", or "Xs" for the RCON message.
// ---------------------------------------------------------------------------

fn format_time(secs: u64) -> String {
    if secs >= 3600 {
        let h = secs / 3600;
        let m = (secs % 3600) / 60;
        if m == 0 {
            format!("{h} hour{}", if h == 1 { "" } else { "s" })
        } else {
            format!("{h}h {m}m")
        }
    } else if secs >= 60 {
        let m = secs / 60;
        let s = secs % 60;
        if s == 0 {
            format!("{m} minute{}", if m == 1 { "" } else { "s" })
        } else {
            format!("{m}m {s}s")
        }
    } else {
        format!("{secs} second{}", if secs == 1 { "" } else { "s" })
    }
}

/// Seconds at which an in-game broadcast reminder is sent.
const BROADCAST_AT: &[u64] = &[3600, 1800, 900, 600, 300, 120, 60, 30, 10, 5];

// ---------------------------------------------------------------------------
// Core countdown logic — shared by manual commands and the scheduler.
//
// Returns Proceed when the countdown expired or ProceedNow was signalled.
// Returns Cancel when Cancel was signalled.
//
// If total_secs == 0 OR no players are online, returns Proceed immediately
// without sending any RCON messages.
// ---------------------------------------------------------------------------

pub async fn run_countdown(
    app: &AppHandle,
    server_id: &str,
    total_secs: u64,
    rcon_port: u16,
    rcon_password: &str,
    message_template: &str,
    cancel_message: &str,
    action_label: &str,
    rx: &mut mpsc::Receiver<CountdownSignal>,
) -> CountdownResult {
    // ── Check for players — skip countdown if none are online ────────────────
    if total_secs > 0 {
        let player_resp = super::rcon::transient_rcon_command(rcon_port, rcon_password, "listplayers")
            .await
            .unwrap_or_default();
        let has_players = !player_resp.trim().is_empty()
            && !player_resp.to_lowercase().contains("no players");

        if !has_players {
            // Emit a zero-remaining event so the frontend shows the action is
            // starting immediately, then clear.
            let _ = app.emit(COUNTDOWN_EVENT, CountdownPayload {
                server_id: server_id.to_string(),
                action: Some(action_label.to_string()),
                remaining_secs: 0,
                total_secs,
            });
            emit_clear(app, server_id);
            return CountdownResult::Proceed;
        }
    } else {
        emit_clear(app, server_id);
        return CountdownResult::Proceed;
    }

    // ── Send initial broadcast and emit first countdown event ────────────────
    let initial_msg = message_template.replace("{time}", &format_time(total_secs));
    rcon_send(rcon_port, rcon_password, &format!("ServerChat {initial_msg}")).await;

    let _ = app.emit(COUNTDOWN_EVENT, CountdownPayload {
        server_id: server_id.to_string(),
        action: Some(action_label.to_string()),
        remaining_secs: total_secs,
        total_secs,
    });

    // ── Countdown loop ───────────────────────────────────────────────────────
    let mut remaining = total_secs;

    loop {
        tokio::select! {
            _ = sleep(Duration::from_secs(1)) => {
                if remaining == 0 {
                    break;
                }
                remaining -= 1;

                // Emit UI update every second for live countdown display.
                let _ = app.emit(COUNTDOWN_EVENT, CountdownPayload {
                    server_id: server_id.to_string(),
                    action: Some(action_label.to_string()),
                    remaining_secs: remaining,
                    total_secs,
                });

                // Send RCON broadcast at configured thresholds.
                if BROADCAST_AT.contains(&remaining) {
                    let msg = message_template.replace("{time}", &format_time(remaining));
                    rcon_send(rcon_port, rcon_password, &format!("ServerChat {msg}")).await;
                }

                if remaining == 0 {
                    break;
                }
            }
            signal = rx.recv() => {
                match signal {
                    Some(CountdownSignal::ProceedNow) => {
                        emit_clear(app, server_id);
                        return CountdownResult::Proceed;
                    }
                    Some(CountdownSignal::Cancel) | None => {
                        // Notify players the action was cancelled.
                        if !cancel_message.is_empty() {
                            rcon_send(rcon_port, rcon_password, &format!("ServerChat {cancel_message}")).await;
                        }
                        emit_clear(app, server_id);
                        return CountdownResult::Cancel;
                    }
                }
            }
        }
    }

    emit_clear(app, server_id);
    CountdownResult::Proceed
}

fn emit_clear(app: &AppHandle, server_id: &str) {
    let _ = app.emit(COUNTDOWN_EVENT, CountdownPayload {
        server_id: server_id.to_string(),
        action: None,
        remaining_secs: 0,
        total_secs: 0,
    });
}

// ---------------------------------------------------------------------------
// Register / deregister countdown channels in AppState
// ---------------------------------------------------------------------------

fn register_countdown(state: &AppState, server_id: &str) -> mpsc::Receiver<CountdownSignal> {
    let (tx, rx) = mpsc::channel::<CountdownSignal>(1);
    state.countdowns.lock().unwrap().insert(server_id.to_string(), tx);
    rx
}

fn deregister_countdown(state: &AppState, server_id: &str) {
    state.countdowns.lock().unwrap().remove(server_id);
}

// ---------------------------------------------------------------------------
// Tauri command: start_graceful_restart
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GracefulRestartParams {
    pub server_id: String,
    pub warn_seconds: u64,
    pub rcon_port: u16,
    pub rcon_password: String,
    pub message: String,
    pub cancel_message: String,
    pub start_params: StartServerParams,
}

#[tauri::command]
pub async fn start_graceful_restart(
    app: AppHandle,
    state: State<'_, AppState>,
    params: GracefulRestartParams,
) -> Result<(), String> {
    // Guard: only if actually running.
    {
        let reg = state.running_servers.lock().unwrap();
        if !reg.contains_key(&params.server_id) {
            return Err(format!("Server {} is not running", params.server_id));
        }
    }

    // Guard: no concurrent countdown.
    {
        let cd = state.countdowns.lock().unwrap();
        if cd.contains_key(&params.server_id) {
            return Err("A countdown is already in progress for this server".into());
        }
    }

    let mut rx = register_countdown(&state, &params.server_id);
    let app2 = app.clone();

    // Spawn so the command returns immediately.
    tauri::async_runtime::spawn(async move {
        let state2 = app2.state::<AppState>();
        let result = run_countdown(
            &app2,
            &params.server_id,
            params.warn_seconds,
            params.rcon_port,
            &params.rcon_password,
            &params.message,
            &params.cancel_message,
            "restart",
            &mut rx,
        ).await;

        deregister_countdown(&state2, &params.server_id);

        if matches!(result, CountdownResult::Proceed) {
            super::server::graceful_shutdown_via_rcon(
                &app2, &params.server_id, params.rcon_port, &params.rcon_password,
            ).await;
            let _ = inner_start_server(app2, params.start_params).await;
        }
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri command: start_graceful_update
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GracefulUpdateParams {
    pub server_id: String,
    pub server_name: String,
    pub warn_seconds: u64,
    pub rcon_port: u16,
    pub rcon_password: String,
    pub message: String,
    pub cancel_message: String,
    pub install_path: String,
    pub cache_dir: String,
    pub steamcmd_path: String,
    pub restart_after: bool,
    pub start_params: Option<StartServerParams>,
}

#[tauri::command]
pub async fn start_graceful_update(
    app: AppHandle,
    state: State<'_, AppState>,
    params: GracefulUpdateParams,
) -> Result<(), String> {
    // Guard: no concurrent countdown.
    {
        let cd = state.countdowns.lock().unwrap();
        if cd.contains_key(&params.server_id) {
            return Err("A countdown is already in progress for this server".into());
        }
    }

    let was_running = state.running_servers.lock().unwrap().contains_key(&params.server_id);
    let mut rx = register_countdown(&state, &params.server_id);
    let app2 = app.clone();

    tauri::async_runtime::spawn(async move {
        let state2 = app2.state::<AppState>();
        // Only run countdown if server is actually running.
        let proceed = if was_running {
            let r = run_countdown(
                &app2,
                &params.server_id,
                params.warn_seconds,
                params.rcon_port,
                &params.rcon_password,
                &params.message,
                &params.cancel_message,
                "update",
                &mut rx,
            ).await;
            matches!(r, CountdownResult::Proceed)
        } else {
            true
        };

        deregister_countdown(&state2, &params.server_id);

        if !proceed { return; }

        // Stop the server gracefully if it was running.
        if was_running {
            super::server::graceful_shutdown_via_rcon(
                &app2, &params.server_id, params.rcon_port, &params.rcon_password,
            ).await;
        }

        // Emit "updating" status so server card shows spinner.
        use crate::commands::server::emit_status;
        use crate::commands::server::ServerStatus;
        emit_status(&app2, &ServerStatus {
            server_id: params.server_id.clone(),
            status: "updating".into(),
            pid: None,
            uptime_seconds: None,
            error: None,
        });

        // Run SteamCMD update.
        let channel = format!("steamcmd://output/{}", params.server_id);
        if let Err(e) = tokio::fs::create_dir_all(&params.cache_dir).await {
            eprintln!("Failed to create cache dir: {e}");
        }

        let update_result = crate::commands::steamcmd::steamcmd_app_update(
            &app2,
            &params.steamcmd_path,
            &params.cache_dir,
            false,
            &channel,
            None,
        ).await;

        if let Err(e) = update_result {
            eprintln!("Scheduled update SteamCMD failed: {e}");
            emit_status(&app2, &ServerStatus {
                server_id: params.server_id.clone(),
                status: "stopped".into(),
                pid: None,
                uptime_seconds: None,
                error: Some(e),
            });
            return;
        }

        // Sync updated cache to server directory.
        let cache_path  = std::path::PathBuf::from(&params.cache_dir);
        let server_path = std::path::PathBuf::from(&params.install_path);
        if let Err(e) = tokio::task::spawn_blocking(move || {
            crate::commands::steamcmd::sync_cache_to_server(&cache_path, &server_path)
        }).await.map_err(|e| e.to_string()).and_then(|r| r.map_err(|e| e.to_string())) {
            eprintln!("Cache sync failed: {e}");
        }

        // Emit update-available cleared.
        let _ = app2.emit(crate::events::ASA_UPDATE_CHECK, serde_json::json!({
            "updateApplied": true,
            "serverId": params.server_id,
        }));
        if let Some(db_path) = state2.get_db_path() {
            if let Ok(conn) = crate::db::open(&db_path) {
                crate::db::clear_update_available(&conn, &params.server_id);
            }
        }

        // Restart if requested and we have start params.
        if params.restart_after {
            if let Some(sp) = params.start_params {
                let _ = inner_start_server(app2, sp).await;
                return;
            }
        }

        emit_status(&app2, &ServerStatus {
            server_id: params.server_id.clone(),
            status: "stopped".into(),
            pid: None,
            uptime_seconds: None,
            error: None,
        });
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri command: cancel_countdown
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn cancel_countdown(
    state: State<'_, AppState>,
    server_id: String,
) -> Result<(), String> {
    let tx = state.countdowns.lock().unwrap().get(&server_id).cloned();
    match tx {
        Some(tx) => tx.send(CountdownSignal::Cancel).await.map_err(|e| e.to_string()),
        None => Err(format!("No countdown in progress for server {server_id}")),
    }
}

// ---------------------------------------------------------------------------
// Tauri command: proceed_now
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn proceed_now(
    state: State<'_, AppState>,
    server_id: String,
) -> Result<(), String> {
    let tx = state.countdowns.lock().unwrap().get(&server_id).cloned();
    match tx {
        Some(tx) => tx.send(CountdownSignal::ProceedNow).await.map_err(|e| e.to_string()),
        None => Err(format!("No countdown in progress for server {server_id}")),
    }
}
