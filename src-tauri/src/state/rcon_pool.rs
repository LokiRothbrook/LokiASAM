use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Mutex};

/// Packet type constants for the Source RCON protocol.
pub const RCON_AUTH: i32 = 3;
pub const RCON_AUTH_RESPONSE: i32 = 2;
pub const RCON_EXECCOMMAND: i32 = 2;

/// A live, authenticated RCON TCP connection to one running server.
pub struct RconConn {
    pub stream: TcpStream,
    /// Monotonically incrementing request ID — mirrors the RCON packet ID field.
    pub next_id: i32,
}

impl RconConn {
    /// Encode and write one Source RCON packet to the stream.
    /// Packet layout: [size:i32][id:i32][type:i32][body\0][pad\0]
    pub async fn send_packet(&mut self, id: i32, pkt_type: i32, body: &str) -> Result<(), String> {
        let body_bytes = body.as_bytes();
        let size = (4 + 4 + body_bytes.len() + 2) as i32;
        let mut buf = Vec::with_capacity((size + 4) as usize);
        buf.extend_from_slice(&size.to_le_bytes());
        buf.extend_from_slice(&id.to_le_bytes());
        buf.extend_from_slice(&pkt_type.to_le_bytes());
        buf.extend_from_slice(body_bytes);
        buf.push(0u8);
        buf.push(0u8);
        self.stream
            .write_all(&buf)
            .await
            .map_err(|e| format!("RCON write error: {e}"))?;
        Ok(())
    }

    /// Read and decode one Source RCON response packet from the stream.
    /// Returns (packet_id, packet_type, body_string).
    pub async fn recv_packet(&mut self) -> Result<(i32, i32, String), String> {
        let mut size_buf = [0u8; 4];
        self.stream
            .read_exact(&mut size_buf)
            .await
            .map_err(|e| format!("RCON read error: {e}"))?;
        let size = i32::from_le_bytes(size_buf) as usize;

        if size < 10 {
            return Err(format!("RCON packet too small: {size} bytes"));
        }
        if size > 8192 {
            return Err(format!("RCON packet too large: {size} bytes"));
        }

        let mut payload = vec![0u8; size];
        self.stream
            .read_exact(&mut payload)
            .await
            .map_err(|e| format!("RCON read payload error: {e}"))?;

        let id = i32::from_le_bytes(payload[0..4].try_into().unwrap());
        let pkt_type = i32::from_le_bytes(payload[4..8].try_into().unwrap());
        let body_end = payload[8..]
            .iter()
            .position(|&b| b == 0)
            .unwrap_or(payload.len() - 8);
        let body = String::from_utf8_lossy(&payload[8..8 + body_end]).into_owned();

        Ok((id, pkt_type, body))
    }
}

/// One line in the RCON console log buffer.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RconLogLine {
    pub timestamp_ms: u64,
    pub text: String,
    /// "command" | "response" | "chat" | "system" | "error"
    pub kind: String,
}

/// A cached player entry from listplayers output.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedPlayer {
    pub name: String,
    pub player_id: String,
}

/// Command sent to a server's RCON manager task through its mpsc channel.
pub enum RconCmd {
    /// Execute an arbitrary RCON command and return the raw response.
    Execute {
        command: String,
        /// When true, the "> command" log line is suppressed.
        suppress_cmd: bool,
        /// When true, response lines are not logged to the console.
        suppress_resp: bool,
        response_tx: oneshot::Sender<Result<String, String>>,
    },
    /// Run listplayers, update the player cache, emit rcon://players/{id}.
    GetPlayers {
        response_tx: oneshot::Sender<Result<Vec<CachedPlayer>, String>>,
    },
    /// Gracefully shut down the manager task and close the connection.
    Disconnect,
}

/// Global pool of RCON manager state, keyed by server UUID.
pub struct RconPool {
    /// mpsc sender + connection ID for each server's manager task.
    /// The ID lets a stale manager task detect that a newer connection has
    /// taken over, so it exits silently instead of clobbering the pool.
    pub cmd_channels: Mutex<HashMap<String, (mpsc::Sender<RconCmd>, u64)>>,
    /// Rolling console log buffer per server, capped at 500 lines.
    pub log_buffer: Mutex<HashMap<String, VecDeque<RconLogLine>>>,
    /// Last-known player list per server.  A missing key means no data yet
    /// (never connected this session); an empty Vec means 0 players online.
    pub player_cache: Mutex<HashMap<String, Vec<CachedPlayer>>>,
    /// Monotonically increasing counter — each rcon_connect call gets a unique ID.
    next_conn_id: AtomicU64,
}

impl RconPool {
    pub fn new() -> Self {
        Self {
            cmd_channels: Mutex::new(HashMap::new()),
            log_buffer: Mutex::new(HashMap::new()),
            player_cache: Mutex::new(HashMap::new()),
            next_conn_id: AtomicU64::new(1),
        }
    }

    /// Allocate the next connection ID (used by rcon_connect).
    pub fn alloc_conn_id(&self) -> u64 {
        self.next_conn_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// Append a log line to the buffer for `server_id` (cap 500 lines).
    pub async fn push_log(&self, server_id: &str, line: RconLogLine) {
        let mut buf = self.log_buffer.lock().await;
        let deque = buf.entry(server_id.to_string()).or_default();
        if deque.len() >= 500 {
            deque.pop_front();
        }
        deque.push_back(line);
    }
}

/// Returns the platform binary subdirectory within a server install path.
/// On Linux we always run the Win64 dedicated server binary via Wine/Proton.
pub fn bin_subdir() -> &'static str {
    "ShooterGame/Binaries/Win64"
}

/// Parse the raw `listplayers` response into a typed player list.
///
/// ASA response format (one player per line):
/// `0. PlayerName, EOS_ID`
pub fn parse_player_list(raw: &str) -> Vec<CachedPlayer> {
    raw.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.to_lowercase().starts_with("no players") {
                return None;
            }
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
        .collect()
}
