use std::collections::VecDeque;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{timeout, Duration, interval, MissedTickBehavior};

use crate::state::{
    AppState,
    log_manager::LogManagerState,
    rcon_pool::{
        bin_subdir, CachedPlayer, RconCmd, RconConn, RconLogLine, RconPool,
        RCON_AUTH, RCON_AUTH_RESPONSE, RCON_EXECCOMMAND, parse_player_list,
    },
};

// Re-export CachedPlayer as ArkPlayer for backwards-compat with existing frontend calls.
pub type ArkPlayer = CachedPlayer;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn now_ms() -> u64 {
    RconPool::now_ms()
}

/// Emit one log line to the log buffer and fire the Tauri event.
async fn emit_log(app: &tauri::AppHandle, server_id: &str, line: RconLogLine) {
    let pool = app.state::<RconPool>();
    pool.push_log(server_id, line.clone()).await;
    let _ = app.emit(&format!("rcon://log/{server_id}"), &line);
}

/// Payload for `rcon://status/{id}` and `rcon://status-any` events.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RconStatusPayload {
    pub server_id: String,
    /// "connecting" | "connected" | "disconnected"
    pub status: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub error: Option<String>,
}

/// Emit connection status to both the per-server channel and the broadcast channel.
fn emit_status(app: &tauri::AppHandle, payload: RconStatusPayload) {
    let _ = app.emit(&format!("rcon://status/{}", payload.server_id), &payload);
    let _ = app.emit("rcon://status-any", &payload);
}

/// Distinguishes a dead TCP connection from a command that simply got no response.
/// Only `Io` errors should terminate the manager task; `Timeout` is often normal
/// (e.g. GetChat when the chat buffer is empty).
#[derive(Debug)]
enum ExecError {
    /// The TCP stream returned an error — connection is definitely dead.
    Io(String),
    /// No matching response packet arrived within the timeout window.
    /// The TCP stream itself may still be alive.
    Timeout,
}

impl std::fmt::Display for ExecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExecError::Io(e)  => write!(f, "{e}"),
            ExecError::Timeout => write!(f, "RCON command timed out — no response from server"),
        }
    }
}

/// Send one RCON command and collect the full response.
/// `first_timeout_ms` controls how long to wait for the very first packet;
/// subsequent packets always use a 200 ms drain window.
///
/// Returns `Err(ExecError::Io)` on TCP errors (connection dead).
/// Returns `Err(ExecError::Timeout)` when no matching packet arrived in time
/// (the TCP stream may still be alive — callers decide whether to break).
async fn exec_cmd(
    conn: &mut RconConn,
    command: &str,
    first_timeout_ms: u64,
) -> Result<String, ExecError> {
    let cmd_id = conn.next_id;
    conn.next_id += 1;
    conn.send_packet(cmd_id, RCON_EXECCOMMAND, command).await
        .map_err(ExecError::Io)?;

    let mut response = String::new();
    let mut received_any = false;

    loop {
        let wait = if received_any {
            Duration::from_millis(200)
        } else {
            Duration::from_millis(first_timeout_ms)
        };

        match timeout(wait, conn.recv_packet()).await {
            Ok(Ok((id, _, body))) if id == cmd_id => {
                received_any = true;
                response.push_str(&body);
            }
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(ExecError::Io(e)),
            Err(_) => {
                if !received_any {
                    return Err(ExecError::Timeout);
                }
                break;
            }
        }
    }
    Ok(response)
}

// ---------------------------------------------------------------------------
// Per-server RCON manager task
// ---------------------------------------------------------------------------

/// Owns the TCP connection for one server.  Runs a select! loop that:
///   • Processes commands from the mpsc channel (user commands, player refresh)
///   • Polls listplayers every 30 s
///   • Polls GetChat every 5 s (always — buffered in memory for the RCON page)
///
/// All RCON I/O is serialized — nothing competes for the connection.
/// On any fatal I/O error the task exits, emits rcon://status disconnected,
/// and removes itself from the pool so the frontend can reconnect.
async fn run_rcon_manager(
    server_id: String,
    conn_id: u64,
    mut conn: RconConn,
    mut rx: mpsc::Receiver<RconCmd>,
    app: tauri::AppHandle,
    _host: String,
    _port: u16,
) {
    let mut player_tick = interval(Duration::from_secs(30));
    player_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    player_tick.tick().await; // discard the immediate first tick

    let mut chat_tick = interval(Duration::from_secs(5));
    chat_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    chat_tick.tick().await; // discard the immediate first tick

    loop {
        tokio::select! {
            // ── Incoming command from frontend ────────────────────────────
            cmd = rx.recv() => {
                match cmd {
                    None | Some(RconCmd::Disconnect) => break,

                    Some(RconCmd::Execute { command, suppress_cmd, suppress_resp, response_tx }) => {
                        if !suppress_cmd {
                            emit_log(&app, &server_id, RconLogLine {
                                timestamp_ms: now_ms(),
                                text: format!("> {command}"),
                                kind: "command".into(),
                            }).await;
                        }

                        match exec_cmd(&mut conn, &command, 15_000).await {
                            Ok(raw) => {
                                if !suppress_resp {
                                    for line in raw.trim().lines() {
                                        let t = line.trim();
                                        if t.is_empty() { continue; }
                                        if t.to_lowercase() == "server received, but no response!!" { continue; }
                                        emit_log(&app, &server_id, RconLogLine {
                                            timestamp_ms: now_ms(),
                                            text: t.to_string(),
                                            kind: "response".into(),
                                        }).await;
                                    }
                                }
                                let _ = response_tx.send(Ok(raw));
                            }
                            Err(e) => {
                                emit_log(&app, &server_id, RconLogLine {
                                    timestamp_ms: now_ms(),
                                    text: format!("Error: {e}"),
                                    kind: "error".into(),
                                }).await;
                                let _ = response_tx.send(Err(e.to_string()));
                                if matches!(e, ExecError::Io(_)) {
                                    break; // TCP dead
                                }
                                // Timeout: log + surface to caller but keep the manager alive.
                            }
                        }
                    }

                    Some(RconCmd::GetPlayers { response_tx }) => {
                        match exec_cmd(&mut conn, "listplayers", 5_000).await {
                            Ok(raw) => {
                                let players = parse_player_list(&raw);
                                {
                                    let pool = app.state::<RconPool>();
                                    pool.player_cache.lock().await
                                        .insert(server_id.clone(), players.clone());
                                }
                                // Upsert player names in SQLite — works even when webview is throttled.
                                if let Some(db_path) = app.state::<AppState>().get_db_path() {
                                    if let Ok(db_conn) = crate::db::open(&db_path) {
                                        for p in &players {
                                            let _ = crate::db::upsert_player_name(&db_conn, &server_id, &p.player_id, &p.name);
                                        }
                                    }
                                }
                                let _ = app.emit(&format!("rcon://players/{server_id}"), &players);
                                let _ = app.emit("rcon://players-any", serde_json::json!({ "serverId": server_id, "players": players }));
                                let _ = response_tx.send(Ok(players));
                            }
                            Err(e) => {
                                let _ = response_tx.send(Err(e.to_string()));
                                if matches!(e, ExecError::Io(_)) {
                                    break; // TCP dead
                                }
                                // Timeout: caller gets an error but keep the manager alive.
                            }
                        }
                    }
                }
            }

            // ── Periodic player list poll (every 30 s) ────────────────────
            _ = player_tick.tick() => {
                match exec_cmd(&mut conn, "listplayers", 5_000).await {
                    Ok(raw) => {
                        let players = parse_player_list(&raw);
                        {
                            let pool = app.state::<RconPool>();
                            pool.player_cache.lock().await
                                .insert(server_id.clone(), players.clone());
                        }
                        // Upsert player names in SQLite — works even when webview is throttled.
                        if let Some(db_path) = app.state::<AppState>().get_db_path() {
                            if let Ok(db_conn) = crate::db::open(&db_path) {
                                for p in &players {
                                    let _ = crate::db::upsert_player_name(&db_conn, &server_id, &p.player_id, &p.name);
                                }
                            }
                        }
                        let _ = app.emit(&format!("rcon://players/{server_id}"), &players);
                        let _ = app.emit("rcon://players-any", serde_json::json!({ "serverId": server_id, "players": players }));
                    }
                    Err(ExecError::Io(_)) => break, // TCP dead
                    Err(ExecError::Timeout) => {} // server slow; skip this poll cycle
                }
            }

            // ── Periodic chat poll (every 5 s) ───────────────────────────
            _ = chat_tick.tick() => {
                match exec_cmd(&mut conn, "GetChat", 3_000).await {
                    Ok(raw) => {
                        for line in raw.lines().map(|l| l.trim()).filter(|l| !l.is_empty()) {
                            let tl = line.to_lowercase();
                            // Drop no-response noise.
                            if tl == "server received, but no response!!" { continue; }
                            // Drop SERVER: prefix lines — these are echoes of admin
                            // broadcasts (e.g. ServerChat) that the user already saw.
                            if line.starts_with("SERVER: ") { continue; }
                            LogManagerState::append_chat_line(&app, &server_id, line).await;
                            emit_log(&app, &server_id, RconLogLine {
                                timestamp_ms: now_ms(),
                                text: line.to_string(),
                                kind: "chat".into(),
                            }).await;
                        }
                    }
                    Err(ExecError::Io(_)) => break, // TCP dead
                    // Timeout means the chat buffer was empty (ASA sent no packet or
                    // responded with a non-matching ID).  This is normal — just continue.
                    Err(ExecError::Timeout) => {}
                }
            }
        }
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────
    // Only emit events and clean up the pool if we are still the current
    // connection for this server.  If a newer rcon_connect call has already
    // taken over (its conn_id replaced ours in the pool), exit silently — the
    // newer manager task will handle its own lifecycle.  Without this check,
    // the stale task's cleanup would drop the newer task's tx, instantly
    // killing it and creating the disconnect/reconnect loop.
    {
        let pool = app.state::<RconPool>();
        let is_superseded = {
            let guard = pool.cmd_channels.lock().await;
            guard
                .get(&server_id)
                .map(|(_, id)| *id != conn_id)
                .unwrap_or(false)
        };
        if is_superseded {
            return;
        }
        // Clears cmd_channels too (a no-op re-remove) plus log_buffer and
        // player_cache — a connection that dies on its own (TCP error, server
        // crash) previously only had cmd_channels cleared here, leaking the
        // other two maps for the server's lifetime.
        pool.remove_server(&server_id).await;
    }

    emit_log(&app, &server_id, RconLogLine {
        timestamp_ms: now_ms(),
        text: "RCON connection closed.".into(),
        kind: "system".into(),
    }).await;

    emit_status(&app, RconStatusPayload {
        server_id,
        status: "disconnected".into(),
        host: None,
        port: None,
        error: None,
    });
}

// ---------------------------------------------------------------------------
// One-shot transient connection (graceful shutdown etc.)
// ---------------------------------------------------------------------------

/// Open a fresh authenticated connection, run one command, return the response.
/// Used for fire-and-forget operations that must not block the pool connection.
pub async fn transient_rcon_command(port: u16, password: &str, command: &str) -> Result<String, String> {
    use tokio::net::TcpStream;

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let stream = timeout(Duration::from_secs(5), TcpStream::connect(addr))
        .await
        .map_err(|_| "RCON connect timed out".to_string())?
        .map_err(|e| format!("RCON connect failed: {e}"))?;
    let _ = stream.set_nodelay(true);
    let mut conn = RconConn { stream, next_id: 1 };

    conn.send_packet(1, RCON_AUTH, password).await?;
    for _ in 0..3 {
        match timeout(Duration::from_secs(5), conn.recv_packet()).await {
            Ok(Ok((_, t, _))) if t == RCON_AUTH_RESPONSE => break,
            Ok(Err(e)) => return Err(e),
            Err(_) => return Err("RCON auth timed out".into()),
            _ => {}
        }
    }

    conn.send_packet(2, RCON_EXECCOMMAND, command).await?;

    let mut response = String::new();
    let mut got_any = false;
    loop {
        let wait = if got_any { Duration::from_millis(300) } else { Duration::from_secs(15) };
        match timeout(wait, conn.recv_packet()).await {
            Ok(Ok((id, _, body))) if id == 2 => {
                got_any = true;
                response.push_str(&body);
            }
            Ok(Ok(_)) => {}
            Ok(Err(_)) | Err(_) => break,
        }
    }
    Ok(response)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Connect to the server's RCON port, authenticate, and spawn the manager task.
/// If a live connection already exists this is a no-op.
#[tauri::command]
pub async fn rcon_connect(
    app: tauri::AppHandle,
    server_id: String,
    host: String,
    port: u16,
    password: String,
    pool: State<'_, RconPool>,
) -> Result<(), String> {
    use tokio::net::TcpStream;

    // Already connected and task is alive — nothing to do.
    {
        let guard = pool.cmd_channels.lock().await;
        if let Some((tx, _)) = guard.get(&server_id) {
            if !tx.is_closed() {
                return Ok(());
            }
        }
    }

    emit_status(&app, RconStatusPayload {
        server_id: server_id.clone(),
        status: "connecting".into(),
        host: Some(host.clone()),
        port: Some(port),
        error: None,
    });

    // Run the full connect+auth sequence in an inner block so every failure
    // path falls through to a single "disconnected" emit below.
    let result: Result<(), String> = async {
        let stream = timeout(
            Duration::from_secs(5),
            TcpStream::connect(format!("{host}:{port}")),
        )
        .await
        .map_err(|_| "RCON connection timed out".to_string())?
        .map_err(|e| format!("RCON connect failed: {e}"))?;

        let _ = stream.set_nodelay(true);
        let mut conn = RconConn { stream, next_id: 1 };

        let auth_id = conn.next_id;
        conn.next_id += 1;
        conn.send_packet(auth_id, RCON_AUTH, &password).await?;

        let mut authenticated = false;
        for _ in 0..3 {
            let result = timeout(Duration::from_secs(5), conn.recv_packet())
                .await
                .map_err(|_| "RCON auth timed out — no response from server".to_string())?;
            let (resp_id, resp_type, _body) = result?;
            if resp_type == RCON_AUTH_RESPONSE {
                if resp_id == -1 {
                    return Err("RCON authentication failed — wrong password".into());
                }
                if resp_id == auth_id {
                    authenticated = true;
                    break;
                }
            }
        }

        if !authenticated {
            return Err("RCON authentication failed — unexpected response sequence".into());
        }

        let conn_id = pool.alloc_conn_id();
        let (tx, rx) = mpsc::channel::<RconCmd>(32);
        pool.cmd_channels.lock().await.insert(server_id.clone(), (tx.clone(), conn_id));

        // Spawn the manager task — it owns the connection from here on.
        let app_clone = app.clone();
        let sid = server_id.clone();
        let h = host.clone();
        tauri::async_runtime::spawn(async move {
            run_rcon_manager(sid, conn_id, conn, rx, app_clone, h, port).await;
        });

        emit_log(&app, &server_id, RconLogLine {
            timestamp_ms: now_ms(),
            text: format!("Connected to RCON at {host}:{port}"),
            kind: "system".into(),
        }).await;

        emit_status(&app, RconStatusPayload {
            server_id: server_id.clone(),
            status: "connected".into(),
            host: Some(host.clone()),
            port: Some(port),
            error: None,
        });

        // Seed the player cache asynchronously — the event will update the frontend.
        let tx_seed = tx.clone();
        tauri::async_runtime::spawn(async move {
            let (resp_tx, resp_rx) = oneshot::channel();
            if tx_seed.send(RconCmd::GetPlayers { response_tx: resp_tx }).await.is_ok() {
                let _ = resp_rx.await;
            }
        });

        Ok(())
    }.await;

    if let Err(ref e) = result {
        emit_status(&app, RconStatusPayload {
            server_id,
            status: "disconnected".into(),
            host: Some(host),
            port: Some(port),
            error: Some(e.clone()),
        });
    }

    result
}

/// Send an RCON command through the manager task queue.
#[tauri::command]
pub async fn rcon_send(
    server_id: String,
    command: String,
    pool: State<'_, RconPool>,
) -> Result<String, String> {
    let tx = pool.cmd_channels.lock().await
        .get(&server_id)
        .map(|(tx, _)| tx.clone())
        .ok_or_else(|| "Not connected to RCON for this server".to_string())?;

    // ServerChat* responses are an echo of the sent message — suppress them.
    let suppress_resp = command.to_lowercase().starts_with("serverchat");

    let (response_tx, response_rx) = oneshot::channel();
    tx.send(RconCmd::Execute {
        command,
        suppress_cmd: false,
        suppress_resp,
        response_tx,
    })
    .await
    .map_err(|_| "RCON manager task has stopped".to_string())?;

    response_rx.await
        .map_err(|_| "RCON response channel dropped".to_string())?
}

/// Signal the manager task to close the connection and remove it from the pool.
/// Also clears the log buffer so the next server start gets a fresh console.
#[tauri::command]
pub async fn rcon_disconnect(
    server_id: String,
    pool: State<'_, RconPool>,
) -> Result<(), String> {
    if let Some((tx, _)) = pool.cmd_channels.lock().await.remove(&server_id) {
        let _ = tx.send(RconCmd::Disconnect).await;
    }
    // cmd_channels is already gone (removed above); this clears log_buffer
    // and player_cache too, so no RCON state lingers after a manual disconnect.
    pool.remove_server(&server_id).await;
    Ok(())
}

/// Returns true only if a manager task is actively running for this server.
/// Uses channel liveness — a dead connection is detected even if the key exists.
#[tauri::command]
pub async fn rcon_is_connected(
    server_id: String,
    pool: State<'_, RconPool>,
) -> Result<bool, String> {
    Ok(pool.cmd_channels.lock().await
        .get(&server_id)
        .map(|(tx, _)| !tx.is_closed())
        .unwrap_or(false))
}

/// Request an immediate listplayers refresh through the manager queue.
#[tauri::command]
pub async fn rcon_get_players(
    _app: tauri::AppHandle,
    server_id: String,
    pool: State<'_, RconPool>,
) -> Result<Vec<ArkPlayer>, String> {
    let tx = pool.cmd_channels.lock().await
        .get(&server_id)
        .map(|(tx, _)| tx.clone())
        .ok_or_else(|| "Not connected to RCON for this server".to_string())?;

    let (response_tx, response_rx) = oneshot::channel();
    tx.send(RconCmd::GetPlayers { response_tx })
        .await
        .map_err(|_| "RCON manager task has stopped".to_string())?;

    response_rx.await
        .map_err(|_| "RCON response channel dropped".to_string())?
}

/// Return the cached player list without sending a command.
///
/// Returns `None` when no RCON connection has been established this session
/// (distinguishes "no data yet" from "0 players online").
#[tauri::command]
pub async fn rcon_get_cached_players(
    server_id: String,
    pool:      State<'_, RconPool>,
) -> Result<Option<Vec<ArkPlayer>>, String> {
    Ok(pool.player_cache.lock().await.get(&server_id).cloned())
}

/// Return the current in-memory console log for this server (up to 500 lines).
#[tauri::command]
pub async fn rcon_get_log(
    server_id: String,
    pool: State<'_, RconPool>,
) -> Result<Vec<RconLogLine>, String> {
    Ok(pool.log_buffer.lock().await
        .get(&server_id)
        .map(|d| d.iter().cloned().collect())
        .unwrap_or_default())
}

/// Clear the in-memory log buffer for this server.
#[tauri::command]
pub async fn rcon_clear_log(
    server_id: String,
    pool: State<'_, RconPool>,
) -> Result<(), String> {
    pool.log_buffer.lock().await.insert(server_id, VecDeque::new());
    Ok(())
}

/// Read the server's BanList.txt and return a list of EOS IDs.
#[tauri::command]
pub async fn rcon_read_ban_list(install_path: String) -> Result<Vec<String>, String> {
    let path = std::path::PathBuf::from(&install_path)
        .join(bin_subdir())
        .join("BanList.txt");

    if !path.exists() {
        return Ok(vec![]);
    }

    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read BanList.txt: {e}"))?;

    Ok(content.lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

/// Read the server's PlayersJoinNoCheckList.txt and return a list of EOS IDs.
#[tauri::command]
pub async fn rcon_read_whitelist(install_path: String) -> Result<Vec<String>, String> {
    let path = std::path::PathBuf::from(&install_path)
        .join(bin_subdir())
        .join("PlayersJoinNoCheckList.txt");

    if !path.exists() {
        return Ok(vec![]);
    }

    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read PlayersJoinNoCheckList.txt: {e}"))?;

    Ok(content.lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}
