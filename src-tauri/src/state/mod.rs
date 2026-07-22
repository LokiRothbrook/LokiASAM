pub mod log_manager;
pub mod rcon_pool;
pub mod scheduler;
pub mod stats_recorder;

use std::collections::{HashMap, HashSet};
use std::sync::{atomic::AtomicBool, Arc, Mutex};
use std::time::Instant;

/// Signal sent to an in-progress countdown task.
pub enum CountdownSignal {
    Cancel,
    ProceedNow,
}

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
    /// Set to true once the log watcher sees the readiness line and emits "running".
    /// The crash monitor uses this to distinguish a startup failure (false → "start-failed")
    /// from a genuine runtime crash (true → "crashed").
    pub confirmed_running: bool,
    /// Full start parameters — stored so the memory-limit restart can re-launch
    /// without needing to re-derive params from the DB.
    pub start_params: crate::commands::server::StartServerParams,
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
    /// Active countdown tasks keyed by server_id. Sending a signal cancels or
    /// short-circuits the running countdown.
    pub countdowns: Mutex<HashMap<String, tokio::sync::mpsc::Sender<CountdownSignal>>>,
    /// Absolute filesystem path to the SQLite database file.
    /// Set by `init_stats_recorder` (the first Rust-side DB init call from the frontend).
    /// Used by Rust-side business logic (backup manager, notification dispatch) to open
    /// their own rusqlite connections without blocking the Tauri plugin-sql connection.
    pub db_path: Mutex<Option<String>>,
    /// Server IDs currently undergoing a backup, restart, or update — held for
    /// the whole operation so the hourly backup tick and a scheduled
    /// restart/update can never run concurrently against the same server
    /// (a restart/update killing or overwriting files mid-backup can produce
    /// a silently-incomplete archive). Acquire via `try_lock_server`.
    pub busy_servers: Mutex<HashSet<String>>,
}

/// RAII guard returned by `AppState::try_lock_server` — releases the lock
/// when dropped, on every exit path (return, `?`, panic unwind) of whichever
/// scope holds it.
pub struct ServerLockGuard<'a> {
    state: &'a AppState,
    server_id: String,
}

impl Drop for ServerLockGuard<'_> {
    fn drop(&mut self) {
        self.state.busy_servers.lock().unwrap().remove(&self.server_id);
    }
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
            countdowns: Mutex::new(HashMap::new()),
            db_path: Mutex::new(None),
            busy_servers: Mutex::new(HashSet::new()),
        }
    }

    /// Attempt to mark a server as busy (backup/restart/update in progress).
    /// Returns `None` if another operation already holds the lock; otherwise
    /// a guard that releases it when dropped.
    pub fn try_lock_server(&self, server_id: &str) -> Option<ServerLockGuard<'_>> {
        let inserted = self.busy_servers.lock().unwrap().insert(server_id.to_string());
        if inserted {
            Some(ServerLockGuard { state: self, server_id: server_id.to_string() })
        } else {
            None
        }
    }

    /// Store the database file path (called from init_stats_recorder).
    pub fn set_db_path(&self, path: &str) {
        *self.db_path.lock().unwrap() = Some(path.to_string());
    }

    /// Retrieve the database file path, if set.
    pub fn get_db_path(&self) -> Option<String> {
        self.db_path.lock().unwrap().clone()
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
