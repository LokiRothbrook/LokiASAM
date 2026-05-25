use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStats {
    pub cpu_percent: f32,
    pub memory_mb: f32,
    pub pid: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerQueryResult {
    pub name: String,
    pub map: String,
    pub players: u32,
    pub max_players: u32,
    pub version: String,
}

/// Return CPU and RAM usage for a given OS process ID using `sysinfo`.
/// Called every 10 seconds by the frontend for each running server card.
#[tauri::command]
pub async fn get_process_stats(_pid: u32) -> Result<ProcessStats, String> {
    Err("Not implemented".into())
}

/// Send a Source Query UDP A2S_INFO packet to get live player count and server info
/// without requiring RCON. Called every 30 seconds per running server.
#[tauri::command]
pub async fn query_server(_ip: String, _port: u16) -> Result<ServerQueryResult, String> {
    Err("Not implemented".into())
}

/// Check whether a given TCP/UDP port is currently in use on localhost.
/// Used during server creation wizard to detect port conflicts.
#[tauri::command]
pub async fn check_port_available(_port: u16) -> Result<bool, String> {
    Err("Not implemented".into())
}
