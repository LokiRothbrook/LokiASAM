use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PortConfig {
    pub port: u16,
    pub query_port: u16,
    pub rcon_port: u16,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub server_id: String,
    pub status: String,
    pub pid: Option<u32>,
    pub uptime_seconds: Option<u64>,
}

/// Start an ASA dedicated server process by server UUID.
/// Emits `server://status/{id}` events as the process starts.
#[tauri::command]
pub async fn start_server(_server_id: String) -> Result<(), String> {
    // TODO: Phase 3 — read install_path from DB, build launch args, spawn process
    Err("Not implemented".into())
}

/// Stop a running server. If `graceful` is true, sends RCON `saveworld` + waits
/// for a clean shutdown before SIGTERM. Otherwise sends SIGTERM immediately.
#[tauri::command]
pub async fn stop_server(_server_id: String, _graceful: bool) -> Result<(), String> {
    Err("Not implemented".into())
}

/// Restart a server: stop (graceful) then start. Emits status events throughout.
#[tauri::command]
pub async fn restart_server(_server_id: String, _graceful: bool) -> Result<(), String> {
    Err("Not implemented".into())
}

/// Return the current runtime status of a server (stopped / starting / running / etc.).
#[tauri::command]
pub async fn get_server_status(_server_id: String) -> Result<ServerStatus, String> {
    Err("Not implemented".into())
}

/// Clone a server: copy its SQLite config row + INI files, then install the
/// server binary via SteamCMD using the shared cache (hardlinks).
#[tauri::command]
pub async fn clone_server(
    _source_id: String,
    _new_name: String,
    _new_ports: PortConfig,
) -> Result<String, String> {
    Err("Not implemented".into())
}

/// Delete a server record from SQLite. If `delete_files` is true, also removes
/// the install directory from disk (backup directory is never deleted here).
#[tauri::command]
pub async fn delete_server(_server_id: String, _delete_files: bool) -> Result<(), String> {
    Err("Not implemented".into())
}
