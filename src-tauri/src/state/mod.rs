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
    /// Server IDs whose current stop is being orchestrated by a restart/update
    /// flow rather than a plain Stop. The process-exit watcher spawned back
    /// when the server was originally started predates that flow and
    /// independently notices the same exit — a time-based marker isn't enough
    /// to avoid the race (the watcher's own cleanup, e.g. archiving logs, can
    /// take longer than the restart flow's, so a marker cleared when the
    /// restart flow finishes can already be gone by the time the watcher
    /// checks it). Instead, the restart flow registers a `Notify` here before
    /// killing the process; the watcher, once its *own* cleanup is done,
    /// fires the notification instead of emitting "stopped" itself, and the
    /// restart flow awaits it before emitting whatever comes next — a real
    /// happens-before relationship instead of two tasks racing a shared flag.
    pub restart_handoff: Mutex<HashMap<String, Arc<tokio::sync::Notify>>>,
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
            restart_handoff: Mutex::new(HashMap::new()),
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

    /// Clear the abort flag for `op_id` (called when the operation finishes or
    /// is aborted). Only removes the entry if it's still the same `Arc` this
    /// caller registered — if a second operation of the same kind (e.g. two
    /// concurrent Proton-GE downloads, which share the static key
    /// "proton_download") has since overwritten it, this leaves that second
    /// operation's flag in place instead of deleting it out from under it.
    /// Without this, the first operation to finish would silently disable the
    /// second one's Cancel button and drop it from `get_running_ops`, even
    /// though it's still running.
    pub fn clear_abort(&self, op_id: &str, flag: &Arc<AtomicBool>) {
        let mut flags = self.abort_flags.lock().unwrap();
        if flags.get(op_id).is_some_and(|current| Arc::ptr_eq(current, flag)) {
            flags.remove(op_id);
        }
    }

    /// Register that `server_id`'s upcoming stop is being orchestrated by a
    /// restart/update flow. Call this *before* killing the process. Returns
    /// the `Notify` the caller should `.notified().await` (with a timeout —
    /// see `wait_for_stop_handoff`) after triggering the kill, to block until
    /// the process-exit watcher's own cleanup has actually finished.
    pub fn register_stop_handoff(&self, server_id: &str) -> Arc<tokio::sync::Notify> {
        let notify = Arc::new(tokio::sync::Notify::new());
        self.restart_handoff.lock().unwrap().insert(server_id.to_string(), Arc::clone(&notify));
        notify
    }

    /// Wait (up to 30s) for the process-exit watcher to confirm it has
    /// finished handling this server's stop. Always returns — the timeout
    /// is a safety net so a restart/update flow can't hang forever if the
    /// watcher is unusually slow (e.g. archiving logs for several servers
    /// concurrently during a bulk restart can easily exceed 30s under disk
    /// contention). Deliberately does NOT remove the registration itself:
    /// the watcher may still be working and must find it whenever it does
    /// finish, however much later, so it hands off silently instead of
    /// reporting a stale "stopped" after we've already moved on. Only the
    /// watcher (via `handoff_stop_to_restart_flow`) ever removes the entry.
    pub async fn wait_for_stop_handoff(&self, _server_id: &str, notify: Arc<tokio::sync::Notify>) {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(30), notify.notified()).await;
    }

    /// Called by the process-exit watcher once its own cleanup (registry,
    /// RCON pool, log rotation) is done. If a restart/update flow registered
    /// this server (via `register_stop_handoff`), consumes that registration
    /// and wakes it — instead of the watcher emitting its own "stopped"
    /// status — returning true so the watcher knows to skip that emission.
    /// This is the only place the registration is ever removed, so it stays
    /// valid for however long this watcher takes to get here, even well past
    /// the waiter's own 30s timeout.
    pub fn handoff_stop_to_restart_flow(&self, server_id: &str) -> bool {
        if let Some(notify) = self.restart_handoff.lock().unwrap().remove(server_id) {
            notify.notify_one();
            true
        } else {
            false
        }
    }
}
