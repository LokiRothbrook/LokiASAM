use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::rcon_pool::{RconConn, RconPool, RCON_AUTH, RCON_AUTH_RESPONSE, RCON_EXECCOMMAND};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ArkPlayer {
    pub name: String,
    pub steam_id: String,
}

/// Connect to the server's RCON port and authenticate.
/// Stores the live TcpStream in the global RconPool for subsequent commands.
///
/// `host` is typically "127.0.0.1" for a local server.
#[tauri::command]
pub async fn rcon_connect(
    server_id: String,
    host: String,
    port: u16,
    password: String,
    pool: State<'_, RconPool>,
) -> Result<(), String> {
    use tokio::net::TcpStream;
    use tokio::time::{timeout, Duration};

    // TCP connect with a 5-second timeout
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

    // Send AUTH packet
    let auth_id = conn.next_id;
    conn.next_id += 1;
    conn.send_packet(auth_id, RCON_AUTH, &password).await?;

    // Read response packets. Some servers send an empty RESPONSE_VALUE first,
    // then the AUTH_RESPONSE; others skip the empty packet. Accept either order.
    let mut authenticated = false;
    for _ in 0..3 {
        let (resp_id, resp_type, _body) = conn.recv_packet().await?;
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

    pool.connections.lock().await.insert(server_id, conn);
    Ok(())
}

/// Send an RCON command and return the server's response string.
#[tauri::command]
pub async fn rcon_send(
    server_id: String,
    command: String,
    pool: State<'_, RconPool>,
) -> Result<String, String> {
    let mut guard = pool.connections.lock().await;
    let conn = guard
        .get_mut(&server_id)
        .ok_or_else(|| "Not connected to RCON for this server".to_string())?;

    let cmd_id = conn.next_id;
    conn.next_id += 1;
    conn.send_packet(cmd_id, RCON_EXECCOMMAND, &command).await?;

    // For large responses Source RCON splits across multiple packets.
    // We send a second empty "ping" packet immediately after the real command;
    // when we receive the response to the ping we know the real response is complete.
    let ping_id = conn.next_id;
    conn.next_id += 1;
    conn.send_packet(ping_id, RCON_EXECCOMMAND, "").await?;

    let mut response = String::new();
    loop {
        let (resp_id, _resp_type, body) = conn.recv_packet().await?;
        if resp_id == ping_id {
            // Ping response received — real command data is complete
            break;
        }
        if resp_id == cmd_id {
            response.push_str(&body);
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
            // Expected: "0. PlayerName, SteamID 76561198XXXXXXXXX"
            let line = line.trim();
            if line.is_empty() || line.starts_with("No Players") {
                return None;
            }
            // Strip leading "N. "
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
