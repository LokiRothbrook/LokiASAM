use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Mutex;

/// One schedule entry with all data needed to fire the action — no DB access required.
/// The frontend builds this from SQLite and sends it via `sync_schedules`.
///
/// Server passwords, MaxPlayers, and gameplay settings are NOT included here —
/// they are in GameUserSettings.ini and read by the server process directly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleEntry {
    pub schedule_id: String,
    pub server_id: String,
    pub server_name: String,
    pub install_path: String,
    /// ASA map identifier, e.g. "TheIsland_WP".
    pub map_path: String,
    /// Map ID as stored in the servers table (used for backup record metadata).
    pub map_id: String,
    pub port: u16,
    pub query_port: u16,
    pub rcon_port: u16,
    /// RCON/admin password — used for in-game broadcast warnings before restart/update.
    pub rcon_password: String,
    pub extra_args: Vec<String>,
    pub mod_ids: Vec<String>,
    /// Linux only: path to Proton-GE directory.
    pub proton_path: Option<String>,
    /// Linux only: WINEPREFIX path.
    pub prefix_path: Option<String>,
    pub steamcmd_path: String,
    pub base_dir: String,
    pub backup_dir: String,
    /// One of: backup | update | restart | broadcast
    pub schedule_type: String,
    pub enabled: bool,
    /// JSON blob of type-specific options.
    pub config_json: String,
    /// Unix timestamp in milliseconds computed by the frontend via cron-parser.
    /// Set to u64::MAX after firing to prevent double-fire until the frontend resyncs.
    pub next_run_ms: u64,
}

/// Global in-memory store for all active schedule entries.
/// Atomically replaced by `sync_schedules` whenever the frontend saves changes.
pub struct SchedulerState {
    pub entries: Mutex<Vec<ScheduleEntry>>,
    /// Schedule IDs whose fire task is still running. `sync_schedules` keeps
    /// these parked at `u64::MAX` no matter what `next_run_ms` the frontend
    /// pushes, so a resync mid-fire (e.g. one triggered by an unrelated
    /// schedule finishing) can never re-arm an entry that's still executing —
    /// a per-server auto-update in a 15-minute warning countdown used to get
    /// re-fired every ~15 s this way.
    pub in_flight: Mutex<HashSet<String>>,
}

impl SchedulerState {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(Vec::new()),
            in_flight: Mutex::new(HashSet::new()),
        }
    }
}
