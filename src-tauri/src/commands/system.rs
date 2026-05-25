use serde::{Deserialize, Serialize};
use std::path::Path;

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

/// Result of a directory readiness check.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DirCheckResult {
    /// True if the directory exists (or was created) and a write test passed.
    pub writable: bool,
    /// Free bytes available on the volume containing this path. 0 if unknown.
    pub free_bytes: u64,
    /// Human-readable error if writable is false.
    pub error: Option<String>,
}

/// Validate a directory path for use as the LokiASAM base or backup directory.
/// Creates the directory (and parents) if it does not exist, performs a write
/// test, and reports available disk space on that volume.
///
/// Called from the Setup Wizard so the user gets immediate feedback before
/// advancing past the directory selection steps.
#[tauri::command]
pub async fn check_dir(path: String) -> Result<DirCheckResult, String> {
    let p = Path::new(&path);

    // Attempt to create the directory tree
    if let Err(e) = std::fs::create_dir_all(p) {
        return Ok(DirCheckResult {
            writable: false,
            free_bytes: 0,
            error: Some(format!("Cannot create directory: {e}")),
        });
    }

    // Write test
    let test_file = p.join(".lokiasam_write_test");
    let write_ok = std::fs::write(&test_file, b"ok").is_ok();
    let _ = std::fs::remove_file(&test_file);

    if !write_ok {
        return Ok(DirCheckResult {
            writable: false,
            free_bytes: 0,
            error: Some("Directory exists but is not writable (check permissions).".into()),
        });
    }

    // Disk space via sysinfo
    let free_bytes = {
        use sysinfo::Disks;
        let disks = Disks::new_with_refreshed_list();
        disks
            .iter()
            // Find the disk whose mount point is the longest prefix of our path
            // (most specific match wins on systems with multiple mounts).
            .filter(|d| p.starts_with(d.mount_point()))
            .max_by_key(|d| d.mount_point().components().count())
            .map(|d| d.available_space())
            .unwrap_or(0)
    };

    Ok(DirCheckResult {
        writable: true,
        free_bytes,
        error: None,
    })
}

/// Return CPU % and RAM MB for a given OS process ID.
/// Called every 10 seconds per running server card.
#[tauri::command]
pub async fn get_process_stats(_pid: u32) -> Result<ProcessStats, String> {
    // Phase 3 — implement via sysinfo crate
    Err("Not implemented".into())
}

/// Send a Source Query UDP A2S_INFO packet to get live player count and server info.
/// Called every 30 seconds per running server without needing RCON.
#[tauri::command]
pub async fn query_server(_ip: String, _port: u16) -> Result<ServerQueryResult, String> {
    // Phase 3 — implement Source Query protocol
    Err("Not implemented".into())
}

/// Check whether a given TCP port is available (not currently bound) on localhost.
/// Used during the server creation wizard to detect port conflicts before assigning.
#[tauri::command]
pub async fn check_port_available(port: u16) -> Result<bool, String> {
    use tokio::net::TcpListener;
    match TcpListener::bind(format!("0.0.0.0:{}", port)).await {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}
