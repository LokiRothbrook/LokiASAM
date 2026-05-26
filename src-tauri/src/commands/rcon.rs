use std::sync::Arc;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

use crate::state::rcon_pool::{RconConn, RconPool, RCON_AUTH, RCON_AUTH_RESPONSE, RCON_EXECCOMMAND};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ArkPlayer {
    pub name: String,
    pub steam_id: String,
}

/// Connect to the server's RCON port and authenticate.
/// Stores the live TcpStream in the global RconPool for subsequent commands.
#[tauri::command]
pub async fn rcon_connect(
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

    let mut conn = RconConn {
        stream,
        next_id: 1,
    };

    // Send AUTH packet — do this before inserting into the pool
    let auth_id = conn.next_id;
    conn.next_id += 1;
    conn.send_packet(auth_id, RCON_AUTH, &password).await?;

    // Read response packets. Some servers send an empty RESPONSE_VALUE first,
    // then the AUTH_RESPONSE; others skip the empty packet.
    let mut authenticated = false;
    for _ in 0..3 {
        let result = timeout(Duration::from_secs(5), conn.recv_packet()).await
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
        .insert(server_id, Arc::new(Mutex::new(conn)));
    Ok(())
}

/// Send an RCON command and return the server's response string.
///
/// The pool lock is held only long enough to clone the per-connection Arc.
/// All I/O is done while holding only the individual connection lock, so a
/// slow or hanging command never blocks other servers or disconnect calls.
#[tauri::command]
pub async fn rcon_send(
    server_id: String,
    command: String,
    pool: State<'_, RconPool>,
) -> Result<String, String> {
    // Grab a clone of the Arc without holding the pool lock during I/O
    let conn_arc = {
        let guard = pool.connections.lock().await;
        guard
            .get(&server_id)
            .ok_or_else(|| "Not connected to RCON for this server".to_string())?
            .clone()
    };

    let mut conn = conn_arc.lock().await;

    let cmd_id = conn.next_id;
    conn.next_id += 1;
    conn.send_packet(cmd_id, RCON_EXECCOMMAND, &command).await?;

    // Timeout-based multi-packet reading:
    //   - Wait up to 15s for the first response packet (commands like saveworld can be slow)
    //   - After receiving any packet, switch to a 200ms continuation window
    //   - If no packet arrives within the window, the response is complete
    //   - This avoids the "ping trick" which ASA ignores
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
            Ok(Err(e)) => return Err(e),
            Err(_) => {
                if !received_any {
                    return Err("RCON command timed out — no response from server".into());
                }
                break;
            }
        }
    }

    Ok(response)
}

/// Disconnect RCON for this server and remove the connection from the pool.
/// Removing the Arc here will drop the TcpStream once the connection lock is free.
#[tauri::command]
pub async fn rcon_disconnect(
    server_id: String,
    pool: State<'_, RconPool>,
) -> Result<(), String> {
    pool.connections.lock().await.remove(&server_id);
    Ok(())
}

/// Send RCON `listplayers` and parse the result into a typed player list.
///
/// ASA response format (one player per line):
/// `0. PlayerName, SteamID 76561198XXXXXXXXX`
#[tauri::command]
pub async fn rcon_get_players(
    server_id: String,
    pool: State<'_, RconPool>,
) -> Result<Vec<ArkPlayer>, String> {
    let raw = rcon_send(server_id, "listplayers".into(), pool).await?;

    let players = raw
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with("No Players") {
                return None;
            }
            let after_dot = line.find(". ").map(|i| &line[i + 2..])?;
            if let Some(comma) = after_dot.rfind(", SteamID ") {
                let name = after_dot[..comma].trim().to_string();
                let steam_id = after_dot[comma + 10..].trim().to_string();
                Some(ArkPlayer { name, steam_id })
            } else {
                None
            }
        })
        .collect();

    Ok(players)
}
