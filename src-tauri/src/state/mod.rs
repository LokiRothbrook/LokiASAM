pub mod rcon_pool;
pub mod server_registry;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Instant;

/// A server process currently tracked by this app session.
pub struct RunningServer {
    /// OS process ID.
    pub pid: u32,
    /// Monotonic timestamp of when this session started the server.
    /// Used to calculate uptime. Approximate for re-registered servers.
    pub started_at: Instant,
}

/// Global application state shared across all Tauri commands via `tauri::State`.
pub struct AppState {
    /// Maps server_id → running server info for every server the backend is tracking.
    pub running_servers: Mutex<HashMap<String, RunningServer>>,
    /// Server IDs currently undergoing an intentional stop.
    /// Prevents the crash-monitor from emitting a "crashed" event when we kill a server on purpose.
    pub stopping_servers: Mutex<HashSet<String>>,
    /// Maps server_id → active RCON connection state (Phase 4).
    pub rcon_connections: Mutex<HashMap<String, rcon_pool::RconConnection>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            running_servers: Mutex::new(HashMap::new()),
            stopping_servers: Mutex::new(HashSet::new()),
            rcon_connections: Mutex::new(HashMap::new()),
        }
    }
}
