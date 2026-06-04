use std::collections::VecDeque;
use std::sync::Arc;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

use crate::state::rcon_pool::{
    bin_subdir, CachedPlayer, RconConn, RconLogLine, RconPool,
    RCON_AUTH, RCON_AUTH_RESPONSE, RCON_EXECCOMMAND,
};

// Re-export CachedPlayer as ArkPlayer for backwards-compat with existing frontend calls.
pub type ArkPlayer = CachedPlayer;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn now_ms() -> u64 {
    RconPool::now_ms()
}

/// Emit one log line to both the main window and any RCON pop-out windows.
async fn emit_log(app: &tauri::AppHandle, server_id: &str, line: RconLogLine) {
    let pool = app.state::<RconPool>();
    pool.push_log(server_id, line.clone()).await;
    let _ = app.emit(&format!("rcon://log/{server_id}"), &line);
}

/// Open a transient authenticated connection, run one command, return the response.
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

/// Connect to the server's RCON port and authenticate.
/// Stores the live TcpStream in the global RconPool for subsequent commands.
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

    pool.connections
        .lock()
        .await
        .insert(server_id.clone(), Arc::new(Mutex::new(conn)));

    let line = RconLogLine {
        timestamp_ms: now_ms(),
        text: format!("Connected to RCON at {host}:{port}"),
        kind: "system".into(),
    };
    emit_log(&app, &server_id, line).await;

    Ok(())
}

/// Send an RCON command, log it and the response, emit events.
#[tauri::command]
pub async fn rcon_send(
    app: tauri::AppHandle,
    server_id: String,
    command: String,
    pool: State<'_, RconPool>,
) -> Result<String, String> {
    let conn_arc = {
        let guard = pool.connections.lock().await;
        guard
            .get(&server_id)
            .ok_or_else(|| "Not connected to RCON for this server".to_string())?
            .clone()
    };

    // Suppress internal housekeeping commands from the visible console.
    let suppressed = matches!(command.to_lowercase().as_str(), "listplayers" | "getchat");

    if !suppressed {
        emit_log(&app, &server_id, RconLogLine {
            timestamp_ms: now_ms(),
            text: format!("> {command}"),
            kind: "command".into(),
        }).await;
    }

    let mut conn = conn_arc.lock().await;

    let cmd_id = conn.next_id;
    conn.next_id += 1;
    conn.send_packet(cmd_id, RCON_EXECCOMMAND, &command).await?;

    let mut response = String::new();
    let mut received_any = false;

    loop {
        let wait = if received_any {
            Duration::from_millis(200)
        } else {
            Duration::from_secs(15)
        };

        match timeout(wait, conn.recv_packet()).await {
            Ok(Ok((resp_id, _resp_type, body))) => {
                received_any = true;
                if resp_id == cmd_id {
                    response.push_str(&body);
                }
            }
            Ok(Err(e)) => {
                emit_log(&app, &server_id, RconLogLine {
                    timestamp_ms: now_ms(),
                    text: format!("Error: {e}"),
                    kind: "error".into(),
                }).await;
                return Err(e);
            }
            Err(_) => {
                if !received_any {
                    let msg = "RCON command timed out — no response from server".to_string();
                    emit_log(&app, &server_id, RconLogLine {
                        timestamp_ms: now_ms(),
                        text: format!("Error: {msg}"),
                        kind: "error".into(),
                    }).await;
                    return Err(msg);
                }
                break;
            }
        }
    }

    // Log the response (suppressed commands and empty/noise responses get no entry)
    if !suppressed {
        let resp_trimmed = response.trim().to_string();
        for line in resp_trimmed.lines() {
            let t = line.trim();
            if t.is_empty() { continue; }
            // ASA sends these literal strings for silent commands — drop them.
            let tl = t.to_lowercase();
            if tl == "(no response)"
                || tl.contains("server received, but no response")
                || tl.contains("server received but no response")
            { continue; }
            emit_log(&app, &server_id, RconLogLine {
                timestamp_ms: now_ms(),
                text: t.to_string(),
                kind: "response".into(),
            }).await;
        }
    }

    Ok(response)
}

/// Disconnect RCON for this server and remove the connection from the pool.
#[tauri::command]
pub async fn rcon_disconnect(
    server_id: String,
    pool: State<'_, RconPool>,
) -> Result<(), String> {
    pool.connections.lock().await.remove(&server_id);
    Ok(())
}

/// Returns true if a live RCON connection exists for this server.
#[tauri::command]
pub async fn rcon_is_connected(
    server_id: String,
    pool: State<'_, RconPool>,
) -> Result<bool, String> {
    Ok(pool.connections.lock().await.contains_key(&server_id))
}

/// Send RCON `listplayers` and parse the result into a typed player list.
///
/// ASA response format (one player per line):
/// `0. PlayerName, EOS_ID`
#[tauri::command]
pub async fn rcon_get_players(
    app: tauri::AppHandle,
    server_id: String,
    pool: State<'_, RconPool>,
) -> Result<Vec<ArkPlayer>, String> {
    let raw = rcon_send(app.clone(), server_id.clone(), "listplayers".into(), pool.clone()).await?;

    let players: Vec<ArkPlayer> = raw
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.to_lowercase().starts_with("no players") {
                return None;
            }
            // Format: "0. PlayerName, EOS_ID"
            let after_dot = line.find(". ").map(|i| &line[i + 2..])?;
            if let Some(comma) = after_dot.rfind(", ") {
                let name = after_dot[..comma].trim().to_string();
                let player_id = after_dot[comma + 2..].trim().to_string();
                if !player_id.is_empty() {
                    return Some(CachedPlayer { name, player_id });
                }
            }
            None
        })
        .collect();

    // Update pool cache and notify every subscriber (stats tiles, server cards).
    pool.player_cache
        .lock()
        .await
        .insert(server_id.clone(), players.clone());

    let _ = app.emit(&format!("rcon://players/{server_id}"), &players);

    Ok(players)
}

/// Return cached players without sending a new RCON command.
#[tauri::command]
pub async fn rcon_get_cached_players(
    server_id: String,
    pool: State<'_, RconPool>,
) -> Result<Vec<ArkPlayer>, String> {
    Ok(pool.player_cache
        .lock()
        .await
        .get(&server_id)
        .cloned()
        .unwrap_or_default())
}

/// Send `GetChat` and return new messages. Results are also logged to the buffer.
#[tauri::command]
pub async fn rcon_get_chat(
    app: tauri::AppHandle,
    server_id: String,
    pool: State<'_, RconPool>,
) -> Result<Vec<String>, String> {
    let conn_arc = {
        let guard = pool.connections.lock().await;
        match guard.get(&server_id) {
            Some(c) => c.clone(),
            None => return Ok(vec![]),
        }
    };

    let mut conn = conn_arc.lock().await;
    let cmd_id = conn.next_id;
    conn.next_id += 1;
    conn.send_packet(cmd_id, RCON_EXECCOMMAND, "GetChat").await?;

    let mut response = String::new();
    let mut got_any = false;
    loop {
        let wait = if got_any { Duration::from_millis(200) } else { Duration::from_secs(5) };
        match timeout(wait, conn.recv_packet()).await {
            Ok(Ok((id, _, body))) if id == cmd_id => { got_any = true; response.push_str(&body); }
            Ok(Ok(_)) => {}
            Ok(Err(_)) | Err(_) => break,
        }
    }
    drop(conn);

    let messages: Vec<String> = response
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    for msg in &messages {
        emit_log(&app, &server_id, RconLogLine {
            timestamp_ms: now_ms(),
            text: msg.clone(),
            kind: "chat".into(),
        }).await;
    }

    Ok(messages)
}

/// Return the current in-memory console log for this server (up to 500 lines).
#[tauri::command]
pub async fn rcon_get_log(
    server_id: String,
    pool: State<'_, RconPool>,
) -> Result<Vec<RconLogLine>, String> {
    Ok(pool.log_buffer
        .lock()
        .await
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
    pool.log_buffer
        .lock()
        .await
        .insert(server_id, VecDeque::new());
    Ok(())
}

/// Enable GetChat polling for this server (called when RCON tab/window opens).
#[tauri::command]
pub async fn rcon_enable_chat_poll(
    server_id: String,
    pool: State<'_, RconPool>,
) -> Result<(), String> {
    pool.chat_poll_active.lock().await.insert(server_id);
    Ok(())
}

/// Disable GetChat polling for this server (called when RCON tab/window closes).
#[tauri::command]
pub async fn rcon_disable_chat_poll(
    server_id: String,
    pool: State<'_, RconPool>,
) -> Result<(), String> {
    pool.chat_poll_active.lock().await.remove(&server_id);
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

    Ok(content
        .lines()
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

    Ok(content
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}
