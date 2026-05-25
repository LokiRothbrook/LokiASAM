pub mod rcon_pool;
pub mod server_registry;

use std::sync::Mutex;
use std::collections::HashMap;

/// Global application state shared across all Tauri commands.
pub struct AppState {
    /// Maps server_id → OS process ID for running servers.
    pub running_servers: Mutex<HashMap<String, u32>>,
    /// Maps server_id → active RCON connection state.
    pub rcon_connections: Mutex<HashMap<String, rcon_pool::RconConnection>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            running_servers: Mutex::new(HashMap::new()),
            rcon_connections: Mutex::new(HashMap::new()),
        }
    }
}
