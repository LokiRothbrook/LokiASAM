use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::Manager;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub base_dir: String,
}

fn bootstrap_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("bootstrap.json"))
        .map_err(|e| format!("Failed to get app data dir: {e}"))
}

/// Read the bootstrap file from the OS-standard app data directory.
/// Returns None if setup has never been completed (file does not exist).
#[tauri::command]
pub async fn read_bootstrap(app: tauri::AppHandle) -> Result<Option<Bootstrap>, String> {
    let path = bootstrap_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read bootstrap: {e}"))?;
    let b: Bootstrap = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse bootstrap: {e}"))?;
    Ok(Some(b))
}

/// Persist the base directory to the bootstrap file, create the
/// {base_dir}/lokiasam/ folder, and copy the old database (if it exists
/// at app_data_dir/lokiasam.db) to {base_dir}/lokiasam/lokiasam.db.
#[tauri::command]
pub async fn write_bootstrap(app: tauri::AppHandle, base_dir: String) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;

    // Ensure {base_dir}/lokiasam/ exists.
    let lokiasam_dir = std::path::Path::new(&base_dir).join("lokiasam");
    tokio::fs::create_dir_all(&lokiasam_dir)
        .await
        .map_err(|e| format!("Failed to create lokiasam dir: {e}"))?;

    // Copy old DB if present and new location is still empty.
    let old_db = data_dir.join("lokiasam.db");
    let new_db = lokiasam_dir.join("lokiasam.db");
    if old_db.exists() && !new_db.exists() {
        tokio::fs::copy(&old_db, &new_db)
            .await
            .map_err(|e| format!("Failed to copy database: {e}"))?;
    }

    // Write bootstrap.json.
    tokio::fs::create_dir_all(&data_dir)
        .await
        .map_err(|e| format!("Failed to create data dir: {e}"))?;
    let text = serde_json::to_string(&Bootstrap { base_dir })
        .map_err(|e| format!("Failed to serialize bootstrap: {e}"))?;
    tokio::fs::write(data_dir.join("bootstrap.json"), text)
        .await
        .map_err(|e| format!("Failed to write bootstrap: {e}"))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
    pub writable: bool,
    pub free_bytes: u64,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Validate a directory path for use as the LokiASAM base or backup directory.
/// Creates the directory (and parents) if it does not exist, performs a write
/// test, and reports available disk space on that volume.
#[tauri::command]
pub async fn check_dir(path: String) -> Result<DirCheckResult, String> {
    let p = Path::new(&path);

    if let Err(e) = std::fs::create_dir_all(p) {
        return Ok(DirCheckResult {
            writable: false,
            free_bytes: 0,
            error: Some(format!("Cannot create directory: {e}")),
        });
    }

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

    let free_bytes = {
        use sysinfo::Disks;
        let disks = Disks::new_with_refreshed_list();
        disks
            .iter()
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

/// Return true if a file (or directory) exists at the given path.
/// Used by the frontend to check for an existing SteamCMD install without
/// requiring frontend fs permissions for the `exists` operation.
#[tauri::command]
pub async fn check_file_exists(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).exists())
}

/// Return CPU % and RSS memory (MB) for a server process and ALL its descendants.
///
/// On Linux the tracked PID is the Proton launcher; the actual ASA server runs
/// as a grandchild under Wine.  Summing the whole subtree gives the true totals.
///
/// CPU usage requires two sysinfo samples separated by a short delay;
/// the 200 ms sleep inside this command is intentional and negligible.
#[tauri::command]
pub async fn get_process_stats(pid: u32) -> Result<ProcessStats, String> {
    use sysinfo::{Pid, ProcessesToUpdate, System};

    let root = Pid::from_u32(pid);
    let mut sys = System::new();

    // First sample — establishes the CPU time baseline for all processes.
    sys.refresh_processes(ProcessesToUpdate::All, false);
    let all_pids = collect_subtree(&sys, root);

    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    // Second sample — CPU deltas are now meaningful.
    sys.refresh_processes(ProcessesToUpdate::All, false);

    // Verify the root process is still alive.
    if sys.process(root).is_none() {
        return Err(format!("Process {pid} not found or no longer running"));
    }

    let mut total_cpu = 0.0f32;
    let mut total_mem_bytes = 0u64;

    for p in &all_pids {
        if let Some(proc) = sys.process(*p) {
            total_cpu += proc.cpu_usage();
            total_mem_bytes += proc.memory();
        }
    }

    Ok(ProcessStats {
        cpu_percent: total_cpu,
        memory_mb: total_mem_bytes as f32 / 1_048_576.0,
        pid,
    })
}

/// BFS walk of the sysinfo process table starting at `root`.
/// Returns every PID in the subtree (including `root` itself).
fn collect_subtree(sys: &sysinfo::System, root: sysinfo::Pid) -> Vec<sysinfo::Pid> {
    use std::collections::HashSet;
    let mut all = vec![root];
    let mut queue = vec![root];
    let mut visited: HashSet<sysinfo::Pid> = std::iter::once(root).collect();

    while let Some(parent) = queue.pop() {
        for (pid, proc) in sys.processes() {
            if proc.parent() == Some(parent) && visited.insert(*pid) {
                all.push(*pid);
                queue.push(*pid);
            }
        }
    }
    all
}

/// Send a Source Query UDP A2S_INFO packet to a game server and parse the response.
///
/// Used to get live player count, map name, and version without requiring RCON.
/// Handles the modern challenge-response variant automatically.
/// Timeout: 3 seconds.
#[tauri::command]
pub async fn query_server(ip: String, port: u16) -> Result<ServerQueryResult, String> {
    use tokio::net::UdpSocket;
    use tokio::time::{timeout, Duration};

    let socket = UdpSocket::bind("0.0.0.0:0")
        .await
        .map_err(|e| format!("Failed to bind UDP socket: {e}"))?;

    socket
        .connect(format!("{ip}:{port}"))
        .await
        .map_err(|e| format!("Failed to connect UDP socket: {e}"))?;

    // A2S_INFO initial request packet.
    let request: &[u8] = b"\xFF\xFF\xFF\xFF\x54Source Engine Query\x00";

    socket
        .send(request)
        .await
        .map_err(|e| format!("Failed to send A2S_INFO: {e}"))?;

    let mut buf = [0u8; 1400];

    let n = timeout(Duration::from_secs(3), socket.recv(&mut buf))
        .await
        .map_err(|_| "A2S_INFO query timed out")?
        .map_err(|e| format!("UDP recv error: {e}"))?;

    let data = &buf[..n];

    // Some servers respond with a challenge packet (type 0x41) before sending
    // the real info response. Resend with the 4-byte challenge appended.
    if data.len() >= 9 && data[4] == 0x41 {
        let challenge = &data[5..9];
        let mut challenged_request = request.to_vec();
        challenged_request.extend_from_slice(challenge);

        socket
            .send(&challenged_request)
            .await
            .map_err(|e| format!("Failed to send challenged A2S_INFO: {e}"))?;

        let n2 = timeout(Duration::from_secs(3), socket.recv(&mut buf))
            .await
            .map_err(|_| "A2S_INFO challenge response timed out")?
            .map_err(|e| format!("UDP recv error after challenge: {e}"))?;

        parse_a2s_info(&buf[..n2])
    } else {
        parse_a2s_info(data)
    }
}

/// Recursively delete a directory and all its contents.
/// Returns Ok(()) if the path does not exist (idempotent).
/// Used to clean up partial server installs after a failed wizard.
#[tauri::command]
pub async fn delete_directory(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Ok(());
    }
    tokio::fs::remove_dir_all(p)
        .await
        .map_err(|e| format!("Failed to delete directory: {e}"))
}

/// Tell the backend whether first-time setup has been completed.
/// Controls close-to-tray: if setup is not done, the X button exits the process normally.
#[tauri::command]
pub fn set_setup_complete(
    state: tauri::State<'_, crate::state::AppState>,
    complete: bool,
) {
    state
        .setup_complete
        .store(complete, std::sync::atomic::Ordering::Relaxed);
}

/// Return the current OS platform identifier: "windows", "linux", or "macos".
#[tauri::command]
pub fn get_platform() -> String {
    if cfg!(target_os = "windows") {
        "windows".into()
    } else if cfg!(target_os = "linux") {
        "linux".into()
    } else {
        "macos".into()
    }
}

/// Open `path` in the platform file manager (Nautilus / Thunar / Explorer…).
/// Non-blocking: spawns the process and returns immediately.
#[tauri::command]
pub async fn open_folder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {path}"));
    }

    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("xdg-open failed: {e}"))?;

    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("explorer failed: {e}"))?;

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("open failed: {e}"))?;

    Ok(())
}

/// Check whether a given TCP port is available (not currently bound) on localhost.
#[tauri::command]
pub async fn check_port_available(port: u16) -> Result<bool, String> {
    use tokio::net::TcpListener;
    match TcpListener::bind(format!("0.0.0.0:{port}")).await {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

// ---------------------------------------------------------------------------
// A2S_INFO response parser
// ---------------------------------------------------------------------------

/// Parse a raw A2S_INFO response buffer into `ServerQueryResult`.
fn parse_a2s_info(data: &[u8]) -> Result<ServerQueryResult, String> {
    // Expected: FF FF FF FF 49 <protocol> <name\0> <map\0> ...
    if data.len() < 6 {
        return Err("A2S_INFO response too short".into());
    }
    if &data[0..4] != b"\xFF\xFF\xFF\xFF" {
        return Err("Missing A2S_INFO header".into());
    }
    if data[4] != 0x49 {
        return Err(format!("Unexpected A2S_INFO type byte: 0x{:02X}", data[4]));
    }

    // Byte 5 = protocol version; skip it.
    let mut cursor = 6usize;

    let name = read_cstring(data, &mut cursor)?;
    let map = read_cstring(data, &mut cursor)?;
    let _folder = read_cstring(data, &mut cursor)?;
    let _game = read_cstring(data, &mut cursor)?;

    // App ID: 2 bytes little-endian.
    if cursor + 2 > data.len() {
        return Err("Truncated A2S_INFO (app_id)".into());
    }
    cursor += 2;

    // num_players, max_players.
    if cursor + 2 > data.len() {
        return Err("Truncated A2S_INFO (players)".into());
    }
    let players = data[cursor] as u32;
    cursor += 1;
    let max_players = data[cursor] as u32;
    cursor += 1;

    // Bots (1) + server_type (1) + environment (1) + visibility (1) + VAC (1) = 5 bytes.
    cursor += 5;

    // Version string.
    let version = if cursor < data.len() {
        read_cstring(data, &mut cursor).unwrap_or_default()
    } else {
        String::new()
    };

    Ok(ServerQueryResult {
        name,
        map,
        players,
        max_players,
        version,
    })
}

/// Read a null-terminated UTF-8 string from `data` starting at `*cursor`,
/// advancing `*cursor` past the null byte.
fn read_cstring(data: &[u8], cursor: &mut usize) -> Result<String, String> {
    let start = *cursor;
    while *cursor < data.len() && data[*cursor] != 0 {
        *cursor += 1;
    }
    if *cursor >= data.len() {
        return Err("Unterminated string in A2S_INFO response".into());
    }
    let s = String::from_utf8_lossy(&data[start..*cursor]).into_owned();
    *cursor += 1; // consume the null byte
    Ok(s)
}
