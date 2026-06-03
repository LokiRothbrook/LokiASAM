use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{Emitter, Manager};

use super::utils::collect_subtree;

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
        .app_config_dir()
        .map(|d| d.join("bootstrap.json"))
        .map_err(|e| format!("Failed to get app config dir: {e}"))
}

/// Read the bootstrap file from the OS-standard app config directory.
/// Migrates automatically from the old app_data_dir location on first read.
/// Returns None if setup has never been completed (file does not exist).
#[tauri::command]
pub async fn read_bootstrap(app: tauri::AppHandle) -> Result<Option<Bootstrap>, String> {
    let path = bootstrap_path(&app)?;

    // One-time migration: move bootstrap.json from the old app_data_dir
    // location to the new app_config_dir location.
    if !path.exists() {
        if let Ok(old_dir) = app.path().app_data_dir() {
            let old_path = old_dir.join("bootstrap.json");
            if old_path.exists() {
                if let Some(parent) = path.parent() {
                    let _ = tokio::fs::create_dir_all(parent).await;
                }
                let _ = tokio::fs::copy(&old_path, &path).await;
                let _ = tokio::fs::remove_file(&old_path).await;
            }
        }
    }

    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read bootstrap: {e}"))?;
    let b: Bootstrap = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse bootstrap: {e}"))?;
    Ok(Some(b))
}

/// Persist the base directory to the bootstrap file (in app_config_dir), create
/// {base_dir}/lokiasam/, and copy the old database (if it exists at
/// app_data_dir/lokiasam.db) to {base_dir}/lokiasam/lokiasam.db.
#[tauri::command]
pub async fn write_bootstrap(app: tauri::AppHandle, base_dir: String) -> Result<(), String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get app config dir: {e}"))?;

    // Ensure {base_dir}/lokiasam/ exists.
    let lokiasam_dir = std::path::Path::new(&base_dir).join("lokiasam");
    tokio::fs::create_dir_all(&lokiasam_dir)
        .await
        .map_err(|e| format!("Failed to create lokiasam dir: {e}"))?;

    // Copy old DB if present and new location is still empty.
    if let Ok(data_dir) = app.path().app_data_dir() {
        let old_db = data_dir.join("lokiasam.db");
        let new_db = lokiasam_dir.join("lokiasam.db");
        if old_db.exists() && !new_db.exists() {
            let _ = tokio::fs::copy(&old_db, &new_db).await;
        }
    }

    // Write bootstrap.json to config dir.
    tokio::fs::create_dir_all(&config_dir)
        .await
        .map_err(|e| format!("Failed to create config dir: {e}"))?;
    let text = serde_json::to_string(&Bootstrap { base_dir })
        .map_err(|e| format!("Failed to serialize bootstrap: {e}"))?;
    tokio::fs::write(config_dir.join("bootstrap.json"), text)
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

/// Check whether a directory path is suitable for use as the LokiASAM base or
/// backup directory.  Does NOT create the directory — it walks up the tree to
/// the deepest existing ancestor, performs a write test there, and reports the
/// available disk space.  Directory creation only happens when the user confirms
/// the wizard (via write_bootstrap / the actual install commands).
#[tauri::command]
pub async fn check_dir(path: String) -> Result<DirCheckResult, String> {
    let p = Path::new(&path);

    // Find the deepest existing ancestor (may be p itself).
    let check_against = {
        let mut cursor = p;
        loop {
            if cursor.exists() {
                break cursor.to_path_buf();
            }
            match cursor.parent() {
                Some(parent) => cursor = parent,
                None => {
                    return Ok(DirCheckResult {
                        writable: false,
                        free_bytes: 0,
                        error: Some("Cannot find any existing parent directory.".into()),
                    });
                }
            }
        }
    };

    // Write test against the existing ancestor.
    let test_file = check_against.join(".lokiasam_write_test");
    let write_ok = std::fs::write(&test_file, b"ok").is_ok();
    let _ = std::fs::remove_file(&test_file);

    if !write_ok {
        return Ok(DirCheckResult {
            writable: false,
            free_bytes: 0,
            error: Some(format!(
                "Location is not writable (check permissions on {}).",
                check_against.display()
            )),
        });
    }

    let free_bytes = {
        use sysinfo::Disks;
        let disks = Disks::new_with_refreshed_list();
        disks
            .iter()
            .filter(|d| check_against.starts_with(d.mount_point()))
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
/// On Linux the tracked PID is the Proton launcher.  When Steam is installed,
/// Proton uses `steam-runtime-launcher-interface-0` to run Wine inside the Steam
/// Runtime container daemon; Wine processes are children of that *daemon service*
/// rather than of the Proton PID, so a pure subtree walk returns only ~60 MB
/// (the Python script itself).  We supplement the BFS with a cmdline scan using
/// `install_path`, which is unique per server instance and present in every Wine
/// process's argv.
///
/// CPU usage requires two sysinfo samples separated by a short delay;
/// the 200 ms sleep inside this command is intentional and negligible.
#[tauri::command]
pub async fn get_process_stats(pid: u32, install_path: Option<String>) -> Result<ProcessStats, String> {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    use std::collections::HashSet;

    let root = Pid::from_u32(pid);
    let mut sys = System::new();

    // First sample — establishes the CPU time baseline for ALL processes.
    // This must cover Wine processes too, so we always refresh everything.
    sys.refresh_processes(ProcessesToUpdate::All, false);

    // Build the initial PID set from the subtree walk.
    let mut all_pids: HashSet<Pid> = collect_subtree(&sys, root).into_iter().collect();

    // On Linux, supplement with processes found via install-path cmdline search.
    #[cfg(target_os = "linux")]
    if let Some(ref path) = install_path {
        use super::utils::collect_by_install_path;
        for extra_root in collect_by_install_path(&sys, path) {
            if all_pids.insert(extra_root) {
                for sp in collect_subtree(&sys, extra_root) {
                    all_pids.insert(sp);
                }
            }
        }
    }

    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    // Second sample — CPU deltas are now meaningful for every process seen above.
    sys.refresh_processes(ProcessesToUpdate::All, false);

    // On Linux, re-run the install-path search against the fresh snapshot so
    // we catch any Wine processes that appeared between the two samples.
    #[cfg(target_os = "linux")]
    if let Some(ref path) = install_path {
        use super::utils::collect_by_install_path;
        for extra_root in collect_by_install_path(&sys, path) {
            if all_pids.insert(extra_root) {
                for sp in collect_subtree(&sys, extra_root) {
                    all_pids.insert(sp);
                }
            }
        }
    }

    // On Linux, the Proton launcher (the tracked root PID) often exits before the
    // game does — the Steam Runtime container re-parents Wine processes to PID 1.
    // Only fail if there are genuinely no live processes in our collected set.
    let root_alive = sys.process(root).is_some();
    if !root_alive {
        let any_live = all_pids.iter().any(|p| sys.process(*p).is_some());
        if !any_live {
            return Err(format!("Process {pid} not found or no longer running"));
        }
    }

    let mut total_cpu = 0.0f32;
    let mut total_mem_bytes = 0u64;

    for p in &all_pids {
        // CPU still comes from sysinfo (needs the two-sample delta calculation).
        if let Some(proc) = sys.process(*p) {
            total_cpu += proc.cpu_usage();
        }

        // Memory via procfs PSS — only for process leaders (Tgid == Pid).
        // Threads share the same virtual address space; counting each TID's
        // smaps_rollup separately would multiply the true footprint by the
        // thread count (e.g. 50 threads × 7 GB = 350 GB).
        #[cfg(target_os = "linux")]
        if super::utils::is_process_leader(p.as_u32()) {
            total_mem_bytes += super::utils::read_proc_pss_bytes(p.as_u32());
        }
        #[cfg(not(target_os = "linux"))]
        if let Some(proc) = sys.process(*p) {
            total_mem_bytes += proc.memory();
        }
    }

    // On Linux, sysinfo reports cpu_usage() as % of ONE logical core, so a
    // process fully occupying two of sixteen cores shows 200 %.  Divide by the
    // number of available cores to normalise to 0–100 % of total CPU capacity.
    #[cfg(not(target_os = "windows"))]
    let cpu_percent = {
        let cores = std::thread::available_parallelism()
            .map(|n| n.get() as f32)
            .unwrap_or(1.0);
        total_cpu / cores
    };
    #[cfg(target_os = "windows")]
    let cpu_percent = total_cpu;

    Ok(ProcessStats {
        cpu_percent,
        memory_mb: total_mem_bytes as f32 / 1_048_576.0,
        pid,
    })
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

/// Request cancellation of a long-running operation registered under `op_id`.
/// Known keys: "steamcmd_install", "proton_download", "server_{id}".
/// Silently does nothing if no operation with that id is currently running.
#[tauri::command]
pub fn abort_operation(
    state: tauri::State<'_, crate::state::AppState>,
    op_id: String,
) {
    use std::sync::atomic::Ordering;
    if let Some(flag) = state.abort_flags.lock().unwrap().get(&op_id) {
        flag.store(true, Ordering::Relaxed);
    }
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

/// Update the close-to-tray preference and show/hide the tray icon accordingly.
/// Called from the frontend after setup completes or when the setting changes.
#[tauri::command]
pub fn set_close_to_tray(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
    enabled: bool,
) {
    state
        .close_to_tray
        .store(enabled, std::sync::atomic::Ordering::Relaxed);
    // Show or hide the tray icon to match the setting.
    if let Some(tray) = app.tray_by_id("lokiasam-tray") {
        let _ = tray.set_visible(enabled);
    }
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

// ---------------------------------------------------------------------------
// Base directory migration
// ---------------------------------------------------------------------------

/// Progress event emitted during base directory migration.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MigrateProgress {
    pub phase:   String,  // "checking" | "backup" | "moving" | "finalizing" | "done" | "error"
    pub message: String,
    pub percent: u8,      // 0–100
}

fn emit_migrate(app: &tauri::AppHandle, phase: &str, message: &str, percent: u8) {
    let _ = app.emit(
        "base-dir://migrate-progress",
        MigrateProgress {
            phase:   phase.into(),
            message: message.into(),
            percent,
        },
    );
}

/// Count files under `dir` recursively (best-effort; used for progress reporting).
fn count_files(dir: &std::path::Path) -> u64 {
    let mut count = 0u64;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_dir() { count += count_files(&p); }
            else { count += 1; }
        }
    }
    count
}

/// Copy `src` to `dst` recursively, emitting progress events every 500 files.
fn copy_dir_recursive(
    app: &tauri::AppHandle,
    src: &std::path::Path,
    dst: &std::path::Path,
    done: &mut u64,
    total: u64,
) -> Result<(), String> {
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create {}: {e}", dst.display()))?;
    let rd = std::fs::read_dir(src)
        .map_err(|e| format!("Failed to read {}: {e}", src.display()))?;
    for entry in rd.flatten() {
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(app, &src_path, &dst_path, done, total)?;
        } else {
            std::fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("Failed to copy {}: {e}", src_path.display()))?;
            *done += 1;
            if total > 0 && *done % 500 == 0 {
                let pct = (20 + (*done * 60 / total).min(60)) as u8;
                emit_migrate(app, "moving",
                    &format!("Copied {} / {} files…", done, total), pct);
            }
        }
    }
    Ok(())
}

/// Move the LokiASAM base directory from `old_dir` to `new_dir`.
///
/// Steps:
/// 1. Space check.
/// 2. Optional backup of `{old_dir}/lokiasam/` to `{old_dir}/lokiasam.bak_<ts>/`.
/// 3. Try an atomic rename first (same volume). If EXDEV, fall back to copy + delete.
/// 4. Update bootstrap.json to point to `new_dir`.
/// 5. Emit progress events throughout via the `base-dir://migrate-progress` channel.
///
/// Returns the new DB path `{new_dir}/lokiasam/lokiasam.db` on success.
#[tauri::command]
pub async fn move_base_dir(
    app: tauri::AppHandle,
    old_dir: String,
    new_dir: String,
    create_backup: bool,
) -> Result<String, String> {
    use std::path::PathBuf;

    let old = PathBuf::from(&old_dir);
    let new = PathBuf::from(&new_dir);

    // --- Phase 1: pre-flight checks ----------------------------------------
    emit_migrate(&app, "checking", "Checking paths and available space…", 0);

    if !old.exists() {
        return Err(format!("Source directory does not exist: {old_dir}"));
    }
    if new.exists() && new.read_dir().map(|mut d| d.next().is_some()).unwrap_or(false) {
        return Err(format!("Destination already exists and is not empty: {new_dir}"));
    }
    if old == new {
        return Err("Source and destination are the same directory.".into());
    }

    // Make sure new is not inside old (would cause infinite recursion).
    if new.starts_with(&old) {
        return Err("Destination is inside the source directory.".into());
    }

    // Space check on the destination volume.
    {
        let check_against = new.parent().unwrap_or(&new).to_path_buf();
        let _ = tokio::fs::create_dir_all(&check_against).await;
        let free_bytes = {
            use sysinfo::Disks;
            let disks = Disks::new_with_refreshed_list();
            disks.iter()
                .filter(|d| check_against.starts_with(d.mount_point()))
                .max_by_key(|d| d.mount_point().components().count())
                .map(|d| d.available_space())
                .unwrap_or(0)
        };
        // Estimate source size by sampling (du-equivalent).
        let src_size_est: u64 = {
            let mut total = 0u64;
            if let Ok(rd) = std::fs::read_dir(&old) {
                for entry in rd.flatten() {
                    if let Ok(meta) = entry.metadata() {
                        total += meta.len();
                    }
                }
            }
            total * 10 // rough multiplier for subdirs
        };
        if free_bytes > 0 && free_bytes < src_size_est {
            return Err(format!(
                "Insufficient disk space at destination. Available: {:.1} GB",
                free_bytes as f64 / 1_073_741_824.0
            ));
        }
    }

    emit_migrate(&app, "checking", "Space check passed.", 5);

    // --- Phase 2: optional backup -------------------------------------------
    if create_backup {
        emit_migrate(&app, "backup", "Creating backup of lokiasam config/DB…", 8);
        let lokiasam_src = old.join("lokiasam");
        if lokiasam_src.exists() {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let bak_dir = old.join(format!("lokiasam.bak_{ts}"));
            let mut done = 0u64;
            let total = count_files(&lokiasam_src);
            tokio::task::block_in_place(|| {
                copy_dir_recursive(&app, &lokiasam_src, &bak_dir, &mut done, total)
            })?;
        }
        emit_migrate(&app, "backup", "Backup complete.", 18);
    }

    // --- Phase 3: move -------------------------------------------------------
    emit_migrate(&app, "moving", "Moving base directory…", 20);

    if let Some(parent) = new.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create destination parent: {e}"))?;
    }

    // Try atomic rename first. Falls back to copy+delete on EXDEV.
    let rename_result = tokio::fs::rename(&old, &new).await;

    match rename_result {
        Ok(_) => {
            emit_migrate(&app, "moving", "Atomic rename succeeded.", 80);
        }
        Err(e) if e.raw_os_error() == Some(18) /* EXDEV */ || e.to_string().contains("cross-device") => {
            emit_migrate(&app, "moving", "Cross-volume move: copying files…", 20);
            let total = count_files(&old);
            let mut done = 0u64;
            let old_clone = old.clone();
            let new_clone = new.clone();
            let app_clone = app.clone();
            tokio::task::block_in_place(|| {
                copy_dir_recursive(&app_clone, &old_clone, &new_clone, &mut done, total)
            })?;
            emit_migrate(&app, "moving", "Copy complete. Removing old directory…", 85);
            tokio::fs::remove_dir_all(&old)
                .await
                .map_err(|e| format!("Failed to remove old directory after copy: {e}"))?;
        }
        Err(e) => return Err(format!("Failed to move directory: {e}")),
    }

    // --- Phase 4: update bootstrap -------------------------------------------
    emit_migrate(&app, "finalizing", "Updating configuration…", 90);
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {e}"))?;
    let bootstrap = Bootstrap { base_dir: new_dir.clone() };
    let text = serde_json::to_string(&bootstrap)
        .map_err(|e| format!("Failed to serialize bootstrap: {e}"))?;
    tokio::fs::write(config_dir.join("bootstrap.json"), text)
        .await
        .map_err(|e| format!("Failed to write bootstrap: {e}"))?;

    let new_db_path = new.join("lokiasam").join("lokiasam.db")
        .to_string_lossy()
        .into_owned();

    emit_migrate(&app, "done", "Migration complete. Restart the app to finish.", 100);
    Ok(new_db_path)
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

/// Exit the app immediately, bypassing close-to-tray logic.
/// Called by the frontend after the user confirms they want to quit
/// while a background install is running.
#[tauri::command]
pub fn force_quit(app: tauri::AppHandle) {
    app.exit(0);
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

// ---------------------------------------------------------------------------
// AppImage desktop integration (Linux only)
//
// Writes a .desktop file and icon to the user's XDG local directories so the
// app appears in application menus and launchers.  Nothing is written
// automatically — the user triggers this explicitly from the setup wizard or
// settings page.  Uninstall removes only the files we created; it does not
// touch the AppImage itself or the user's base/config directories.
// ---------------------------------------------------------------------------

const APP_INTEGRATION_ID: &str = "xyz.lokisoft.lokiasam";
const APP_ICON_PNG: &[u8] = include_bytes!("../../icons/icon.png");

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppImageIntegrationStatus {
    /// True when the process is running as a packaged AppImage.
    pub is_appimage: bool,
    /// True when our .desktop file already exists in ~/.local/share/applications/.
    pub is_installed: bool,
}

/// Check whether LokiASAM is running as an AppImage and whether it is already
/// registered in the user's application menu.
#[tauri::command]
pub fn check_appimage_integration() -> AppImageIntegrationStatus {
    let is_appimage = std::env::var("APPIMAGE").is_ok();
    let is_installed = std::env::var("HOME").map_or(false, |home| {
        std::path::Path::new(&format!(
            "{home}/.local/share/applications/{APP_INTEGRATION_ID}.desktop"
        ))
        .exists()
    });
    AppImageIntegrationStatus { is_appimage, is_installed }
}

/// Install LokiASAM into the user's application menu by writing a .desktop
/// file and icon to ~/.local/share/.  Only available when running as an AppImage.
#[tauri::command]
pub fn install_appimage_integration() -> Result<(), String> {
    let appimage_path = std::env::var("APPIMAGE")
        .map_err(|_| "Not running as an AppImage.".to_string())?;
    let home = std::env::var("HOME")
        .map_err(|_| "HOME environment variable not set.".to_string())?;

    // ── Icons ─────────────────────────────────────────────────────────────────
    for size in ["512x512", "256x256", "128x128"] {
        let dir = format!("{home}/.local/share/icons/hicolor/{size}/apps");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create icon directory: {e}"))?;
        std::fs::write(
            format!("{dir}/{APP_INTEGRATION_ID}.png"),
            APP_ICON_PNG,
        )
        .map_err(|e| format!("Failed to write icon: {e}"))?;
    }

    // ── Desktop file ──────────────────────────────────────────────────────────
    let desktop_dir = format!("{home}/.local/share/applications");
    std::fs::create_dir_all(&desktop_dir)
        .map_err(|e| format!("Failed to create applications directory: {e}"))?;

    let desktop_content = format!(
        "[Desktop Entry]\n\
         Name=LokiASAM\n\
         Comment=ARK Survival Ascended Dedicated Server Manager\n\
         Exec={appimage_path} %U\n\
         Icon={APP_INTEGRATION_ID}\n\
         Type=Application\n\
         Categories=Game;Utility;\n\
         StartupWMClass={APP_INTEGRATION_ID}\n\
         Terminal=false\n"
    );
    std::fs::write(
        format!("{desktop_dir}/{APP_INTEGRATION_ID}.desktop"),
        desktop_content,
    )
    .map_err(|e| format!("Failed to write desktop file: {e}"))?;

    // ── Rebuild caches ────────────────────────────────────────────────────────
    let icon_theme_dir = format!("{home}/.local/share/icons/hicolor");
    let _ = std::process::Command::new("update-desktop-database").arg(&desktop_dir).status();
    let _ = std::process::Command::new("gtk-update-icon-cache").args(["-f", "-t", &icon_theme_dir]).status();
    let _ = std::process::Command::new("kbuildsycoca6").arg("--incremental").status();
    let _ = std::process::Command::new("kbuildsycoca5").arg("--incremental").status();

    Ok(())
}

/// Remove the .desktop file and icons that were installed by
/// `install_appimage_integration`.  Does not touch the AppImage itself.
#[tauri::command]
pub fn uninstall_appimage_integration() -> Result<(), String> {
    let home = std::env::var("HOME")
        .map_err(|_| "HOME environment variable not set.".to_string())?;

    let desktop_path = format!(
        "{home}/.local/share/applications/{APP_INTEGRATION_ID}.desktop"
    );
    if std::path::Path::new(&desktop_path).exists() {
        std::fs::remove_file(&desktop_path)
            .map_err(|e| format!("Failed to remove desktop file: {e}"))?;
    }

    for size in ["512x512", "256x256", "128x128"] {
        let icon_path = format!(
            "{home}/.local/share/icons/hicolor/{size}/apps/{APP_INTEGRATION_ID}.png"
        );
        let _ = std::fs::remove_file(&icon_path); // ignore — may not exist for all sizes
    }

    // ── Rebuild caches ────────────────────────────────────────────────────────
    let desktop_dir = format!("{home}/.local/share/applications");
    let icon_theme_dir = format!("{home}/.local/share/icons/hicolor");
    let _ = std::process::Command::new("update-desktop-database").arg(&desktop_dir).status();
    let _ = std::process::Command::new("gtk-update-icon-cache").args(["-f", "-t", &icon_theme_dir]).status();
    let _ = std::process::Command::new("kbuildsycoca6").arg("--incremental").status();
    let _ = std::process::Command::new("kbuildsycoca5").arg("--incremental").status();

    Ok(())
}
