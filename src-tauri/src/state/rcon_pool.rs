use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;

/// Packet type constants for Source RCON protocol.
pub const RCON_AUTH: i32 = 3;
pub const RCON_AUTH_RESPONSE: i32 = 2;
pub const RCON_EXECCOMMAND: i32 = 2;
pub const RCON_RESPONSE_VALUE: i32 = 0;

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
        // size = id(4) + type(4) + body + null + pad null
        let size = (4 + 4 + body_bytes.len() + 2) as i32;
        let mut buf = Vec::with_capacity((size + 4) as usize);
        buf.extend_from_slice(&size.to_le_bytes());
        buf.extend_from_slice(&id.to_le_bytes());
        buf.extend_from_slice(&pkt_type.to_le_bytes());
        buf.extend_from_slice(body_bytes);
        buf.push(0u8); // body null terminator
        buf.push(0u8); // padding null terminator
        self.stream
            .write_all(&buf)
            .await
            .map_err(|e| format!("RCON write error: {e}"))?;
        Ok(())
    }

    /// Read and decode one Source RCON response packet from the stream.
    /// Returns (packet_id, packet_type, body_string).
    pub async fn recv_packet(&mut self) -> Result<(i32, i32, String), String> {
        // Read the 4-byte size prefix
        let mut size_buf = [0u8; 4];
        self.stream
            .read_exact(&mut size_buf)
            .await
            .map_err(|e| format!("RCON read size error: {e}"))?;
        let size = i32::from_le_bytes(size_buf) as usize;

        if size < 10 {
            return Err(format!("RCON packet too small: {size} bytes"));
        }
        if size > 4096 {
            return Err(format!("RCON packet too large: {size} bytes"));
        }

        let mut payload = vec![0u8; size];
        self.stream
            .read_exact(&mut payload)
            .await
            .map_err(|e| format!("RCON read payload error: {e}"))?;

        let id = i32::from_le_bytes(payload[0..4].try_into().unwrap());
        let pkt_type = i32::from_le_bytes(payload[4..8].try_into().unwrap());
        // Body starts at byte 8, terminated by a null before the padding null
        let body_end = payload[8..]
            .iter()
            .position(|&b| b == 0)
            .unwrap_or(payload.len() - 8);
        let body = String::from_utf8_lossy(&payload[8..8 + body_end]).into_owned();

        Ok((id, pkt_type, body))
    }
}

/// Global pool of live RCON connections, keyed by server UUID.
/// Uses `tokio::sync::Mutex` so it is safe to hold across async I/O awaits.
pub struct RconPool {
    pub connections: Mutex<HashMap<String, RconConn>>,
}

impl RconPool {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
        }
    }
}
