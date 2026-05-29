pub mod log_watcher;
pub mod rcon_pool;
pub mod scheduler;

use std::collections::{HashMap, HashSet};
use std::sync::{atomic::AtomicBool, Arc, Mutex};
use std::time::Instant;

/// A server process currently tracked by this app session.
pub struct RunningServer {
    /// OS process ID.
    pub pid: u32,
    /// Monotonic timestamp of when this session started the server.
    /// Used to calculate uptime. Approximate for re-registered servers.
    pub started_at: Instant,
    /// Absolute path to the server install directory.
    /// On Linux, used to locate Wine processes that were launched inside the Steam
    /// Runtime container (and therefore not visible in the proton PID's subtree).
    pub install_path: String,
}

/// Global application state shared across all Tauri commands via `tauri::State`.
pub struct AppState {
    /// Maps server_id → running server info for every server the backend is tracking.
    pub running_servers: Mutex<HashMap<String, RunningServer>>,
    /// Server IDs currently undergoing an intentional stop.
    /// Prevents the crash-monitor from emitting a "crashed" event when we kill a server on purpose.
    pub stopping_servers: Mutex<HashSet<String>>,
    /// True once the frontend has confirmed first-time setup is complete.
    /// Controls whether the close button hides to tray or exits the process.
    pub setup_complete: AtomicBool,
    /// Guards the one-time "tray hint" toast shown when the user first hides the window.
    pub tray_hint_shown: AtomicBool,
    /// Whether closing the main window should hide to tray (true) or exit (false).
    pub close_to_tray: AtomicBool,
    /// Shared HTTP client — reuses connections and TLS sessions across all outbound requests.
    pub http_client: reqwest::Client,
    /// Per-operation abort flags. Key examples: "steamcmd_install", "proton_download",
    /// "server_{id}". Set to true to request cancellation; commands clear their key on exit.
    pub abort_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            running_servers: Mutex::new(HashMap::new()),
            stopping_servers: Mutex::new(HashSet::new()),
            setup_complete: AtomicBool::new(false),
            tray_hint_shown: AtomicBool::new(false),
            close_to_tray: AtomicBool::new(true),
            http_client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .expect("Failed to build shared HTTP client"),
            abort_flags: Mutex::new(HashMap::new()),
        }
    }

    /// Register a new abort flag for `op_id` and return a clone of it.
    /// Replaces any existing flag for the same key.
    pub fn register_abort(&self, op_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.abort_flags.lock().unwrap().insert(op_id.to_string(), Arc::clone(&flag));
        flag
    }

    /// Clear the abort flag for `op_id` (called when the operation finishes or is aborted).
    pub fn clear_abort(&self, op_id: &str) {
        self.abort_flags.lock().unwrap().remove(op_id);
    }
}
