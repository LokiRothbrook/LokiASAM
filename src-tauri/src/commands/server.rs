use crate::{events, state::AppState};
use serde::{Deserialize, Serialize};
use std::time::Instant;
use tauri::{Emitter, Manager};

use super::utils::{collect_subtree, copy_dir_recursive};

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/// Runtime status of a server. Returned by `get_server_status` and emitted as
/// the payload for `server://status/{id}` and `server://any-change` events.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub server_id: String,
    /// One of: stopped | starting | running | stopping | updating | error | crashed
    pub status: String,
    pub pid: Option<u32>,
    pub uptime_seconds: Option<u64>,
}

/// Full parameter set for starting an ASA dedicated server.
/// The frontend reads all values from SQLite and passes them here — Rust does
/// no DB access of its own.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StartServerParams {
    pub server_id: String,
    /// Absolute path to the server install directory.
    pub install_path: String,
    /// ASA map identifier, e.g. "TheIsland_WP".
    pub map_path: String,
    pub port: u16,
    pub query_port: u16,
    pub rcon_port: u16,
    pub max_players: u32,
    /// Optional join password shown to connecting players.
    pub server_password: Option<String>,
    pub admin_password: String,
    /// Additional command-line flags, e.g. ["-NoBattlEye", "-servergamelog"].
    pub extra_args: Vec<String>,
    /// CurseForge mod IDs to load. Passed as `-mods=id1,id2,...` — the server
    /// downloads and applies them on startup automatically.
    pub mod_ids: Vec<String>,
    /// Linux only: path to the Proton-GE installation directory (must contain `proton` script).
    /// Typically {base_dir}/proton/GE-ProtonX-Y/
    pub proton_path: Option<String>,
    /// Linux only: WINEPREFIX path where Proton creates its fake C: drive.
    /// Stored at {base_dir}/proton/prefix/ so everything Proton-related is co-located.
    pub prefix_path: Option<String>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Emit both the per-server and global status-change events.
fn emit_status(app: &tauri::AppHandle, status: &ServerStatus) {
    let _ = app.emit(
        &events::server_event(events::SERVER_STATUS, &status.server_id),
        status.clone(),
    );
    let _ = app.emit(events::SERVER_ANY_CHANGE, status.clone());
}

/// Kill a process AND all of its descendants.
///
/// On Linux with Proton the tracked PID is the Proton launcher script; the
/// real ASA server runs as a grandchild under Wine.  Signalling only the root
/// orphans those children, so we walk the full subtree and signal every node
/// (leaves first so parents don't respawn children before they're killed).
fn kill_process_tree(root_pid: u32, graceful: bool) {
    use sysinfo::{Pid, ProcessesToUpdate, System};

    let root = Pid::from_u32(root_pid);
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, false);

    let pids = collect_subtree(&sys, root);

    // Kill leaves → root so parents cannot respawn children.
    for pid in pids.iter().rev() {
        if let Some(proc) = sys.process(*pid) {
            if graceful {
                #[cfg(unix)]
                {
                    let sent = proc.kill_with(sysinfo::Signal::Term);
                    if sent != Some(true) {
                        proc.kill();
                    }
                }
                #[cfg(not(unix))]
                {
                    proc.kill();
                }
            } else {
                proc.kill();
            }
        }
    }
}

/// Check whether a PID is still alive using sysinfo.
fn pid_alive(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let spid = Pid::from_u32(pid);
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::Some(&[spid]), false);
    sys.process(spid).is_some()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Internal: start a server without requiring Tauri State injection.
/// Called by both the `start_server` command and the Rust scheduler.
pub async fn inner_start_server(
    app_handle: tauri::AppHandle,
    params: StartServerParams,
) -> Result<u32, String> {
    let state = app_handle.state::<AppState>();
    inner_start_server_with_state(&app_handle, &state, params).await
}

/// Internal: stop a server without requiring Tauri State injection.
/// Called by both the `stop_server` command and the Rust scheduler.
pub fn inner_stop_server(app: &tauri::AppHandle, server_id: &str, graceful: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    let pid = {
        let registry = state.running_servers.lock().unwrap();
        registry.get(server_id).map(|rs| rs.pid)
    };
    let pid = pid.ok_or_else(|| format!("Server {server_id} is not running"))?;
    state.stopping_servers.lock().unwrap().insert(server_id.to_string());
    kill_process_tree(pid, graceful);
    Ok(())
}

/// Core start logic shared between `start_server` (Tauri command) and `inner_start_server`.
async fn inner_start_server_with_state(
    app_handle: &tauri::AppHandle,
    state: &AppState,
    params: StartServerParams,
) -> Result<u32, String> {
    // Build the ?-delimited query string that follows the map name.
    let mut query_string = format!(
        "{}?listen?Port={}?QueryPort={}?RCONEnabled=True?RCONPort={}?MaxPlayers={}?ServerAdminPassword={}",
        params.map_path,
        params.port,
        params.query_port,
        params.rcon_port,
        params.max_players,
        params.admin_password,
    );
    if let Some(pw) = &params.server_password {
        if !pw.is_empty() {
            query_string.push_str(&format!("?ServerPassword={}", pw));
        }
    }

    // Build the platform-specific Command.
    // Windows: run the Win64 exe directly.
    // Linux:   run via Proton-GE (`{proton}/proton run {Win64 exe}`).
    //          The Win64 binary is the only shipping binary for ASA — there is no native Linux exe.
    #[cfg(target_os = "windows")]
    let mut cmd = tokio::process::Command::new(format!(
        "{}\\ShooterGame\\Binaries\\Win64\\ArkAscendedServer.exe",
        params.install_path
    ));

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let proton_path = params
            .proton_path
            .as_deref()
            .filter(|p| !p.is_empty())
            .ok_or_else(|| {
                "proton_not_configured: Linux requires Proton-GE. Configure it in the setup wizard or Settings.".to_string()
            })?;

        let prefix_path = params.prefix_path.clone().unwrap_or_default();
        if !prefix_path.is_empty() {
            let _ = tokio::fs::create_dir_all(&prefix_path).await;
        }

        let exe_path = format!(
            "{}/ShooterGame/Binaries/Win64/ArkAscendedServer.exe",
            params.install_path
        );
        let proton_script = format!("{}/proton", proton_path);

        let mut c = tokio::process::Command::new(&proton_script);
        c.arg("run");
        c.arg(&exe_path);
        if !prefix_path.is_empty() {
            c.env("STEAM_COMPAT_DATA_PATH", &prefix_path);
        }
        c.env("STEAM_COMPAT_CLIENT_INSTALL_PATH", &params.install_path);
        c
    };

    cmd.arg(&query_string);
    cmd.args(["-server", "-log"]);
    if !params.mod_ids.is_empty() {
        cmd.arg(format!("-mods={}", params.mod_ids.join(",")));
    }
    for arg in &params.extra_args {
        cmd.arg(arg);
    }
    cmd.current_dir(&params.install_path);
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start server process: {e}"))?;

    let pid = child.id().ok_or("Spawned process has no PID")?;

    // Register in the running map.
    {
        let mut registry = state.running_servers.lock().unwrap();
        registry.insert(
            params.server_id.clone(),
            crate::state::RunningServer {
                pid,
                started_at: Instant::now(),
            },
        );
    }

    // Emit "starting" — the readiness poller below will emit "running" once
    // the RCON port responds, which means ASA has fully loaded and is joinable.
    emit_status(
        &app_handle,
        &ServerStatus {
            server_id: params.server_id.clone(),
            status: "starting".into(),
            pid: Some(pid),
            uptime_seconds: None,
        },
    );

    // Spawn a watcher task that owns the child handle and waits for it to exit.
    let sid = params.server_id.clone();
    let handle_clone = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let _ = child.wait().await;

        let app_state = handle_clone.state::<AppState>();

        let was_intentional = app_state
            .stopping_servers
            .lock()
            .unwrap()
            .remove(&sid);

        app_state.running_servers.lock().unwrap().remove(&sid);

        let status_str = if was_intentional { "stopped" } else { "crashed" };
        emit_status(
            &handle_clone,
            &ServerStatus {
                server_id: sid,
                status: status_str.into(),
                pid: None,
                uptime_seconds: None,
            },
        );
    });

    // Spawn a readiness poller.  ASA on Linux via Proton can take several
    // minutes to load the map before it accepts connections.  We poll the
    // RCON TCP port every 5 s; the first successful TCP connect means the
    // server is up and players can join.  Timeout after 15 min.
    let sid2 = params.server_id.clone();
    let handle2 = app_handle.clone();
    let rcon_port = params.rcon_port;
    tauri::async_runtime::spawn(async move {
        use tokio::net::TcpStream;
        use tokio::time::{sleep, timeout, Duration};

        for _ in 0..180u32 {
            sleep(Duration::from_secs(5)).await;

            // Abort if the process already died (stop/crash before it was ready).
            if !pid_alive(pid) {
                return;
            }

            // A successful TCP handshake on the RCON port means ASA is up.
            let addr = std::net::SocketAddr::from(([127, 0, 0, 1], rcon_port));
            if timeout(Duration::from_secs(2), TcpStream::connect(addr))
                .await
                .is_ok()
            {
                emit_status(
                    &handle2,
                    &ServerStatus {
                        server_id: sid2,
                        status: "running".into(),
                        pid: Some(pid),
                        uptime_seconds: Some(0),
                    },
                );
                return;
            }
        }

        // 15-minute timeout — emit running anyway so the UI doesn't stay stuck.
        if pid_alive(pid) {
            emit_status(
                &handle2,
                &ServerStatus {
                    server_id: sid2,
                    status: "running".into(),
                    pid: Some(pid),
                    uptime_seconds: Some(0),
                },
            );
        }
    });

    Ok(pid)
}

/// Start an ASA dedicated server.
#[tauri::command]
pub async fn start_server(
    app_handle: tauri::AppHandle,
    _state: tauri::State<'_, AppState>,
    params: StartServerParams,
) -> Result<u32, String> {
    inner_start_server(app_handle, params).await
}

/// Stop a running server.
///
/// Marks the server as intentionally stopping (so the watcher task emits
/// "stopped" rather than "crashed"), then sends the OS signal.
/// If `graceful` is true, SIGTERM is sent first; otherwise the process is killed immediately.
#[tauri::command]
pub async fn stop_server(
    app_handle: tauri::AppHandle,
    server_id: String,
    graceful: bool,
) -> Result<(), String> {
    inner_stop_server(&app_handle, &server_id, graceful)
}

/// Restart a server: kill the current process (gracefully if requested),
/// wait up to 15 s for it to exit, then re-spawn with the same params.
///
/// Returns the new process ID.
#[tauri::command]
pub async fn restart_server(
    app_handle: tauri::AppHandle,
    _state: tauri::State<'_, AppState>,
    params: StartServerParams,
    graceful: bool,
) -> Result<u32, String> {
    inner_restart_server(app_handle, params, graceful).await
}

/// Internal: restart logic shared between the `restart_server` command and the scheduler.
pub async fn inner_restart_server(
    app_handle: tauri::AppHandle,
    params: StartServerParams,
    graceful: bool,
) -> Result<u32, String> {
    let pid = {
        let state = app_handle.state::<AppState>();
        let registry = state.running_servers.lock().unwrap();
        registry.get(&params.server_id).map(|rs| rs.pid)
    };

    if let Some(pid) = pid {
        {
            let state = app_handle.state::<AppState>();
            state.stopping_servers.lock().unwrap().insert(params.server_id.clone());
        }

        kill_process_tree(pid, graceful);

        // Wait up to 15 s for the process to exit.
        for _ in 0..30 {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            if !pid_alive(pid) {
                break;
            }
        }

        // Ensure it's gone regardless.
        if pid_alive(pid) {
            kill_process_tree(pid, false);
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        }

        // Clean up state (the watcher task may have already done this, that's fine).
        let state = app_handle.state::<AppState>();
        state.stopping_servers.lock().unwrap().remove(&params.server_id);
        state.running_servers.lock().unwrap().remove(&params.server_id);
    }

    inner_start_server(app_handle, params).await
}

/// Return the current runtime status of a server.
///
/// Consults the in-memory running_servers map and verifies the PID is still
/// alive via sysinfo before reporting "running".
#[tauri::command]
pub async fn get_server_status(
    state: tauri::State<'_, AppState>,
    server_id: String,
) -> Result<ServerStatus, String> {
    let entry = {
        let registry = state.running_servers.lock().unwrap();
        registry
            .get(&server_id)
            .map(|rs| (rs.pid, rs.started_at))
    };

    match entry {
        None => Ok(ServerStatus {
            server_id,
            status: "stopped".into(),
            pid: None,
            uptime_seconds: None,
        }),
        Some((pid, started_at)) => {
            if pid_alive(pid) {
                Ok(ServerStatus {
                    server_id,
                    status: "running".into(),
                    pid: Some(pid),
                    uptime_seconds: Some(started_at.elapsed().as_secs()),
                })
            } else {
                Ok(ServerStatus {
                    server_id,
                    status: "stopped".into(),
                    pid: None,
                    uptime_seconds: None,
                })
            }
        }
    }
}

/// Register a server PID from a previous app session in the running_servers map
/// so the crash-monitor 30 s polling loop can watch it.
///
/// Returns `true` if the process is alive, `false` if it has already exited
/// (i.e., it crashed while the app was closed — the frontend should mark it
/// "crashed" in SQLite).
#[tauri::command]
pub async fn register_running_server(
    state: tauri::State<'_, AppState>,
    server_id: String,
    pid: u32,
) -> Result<bool, String> {
    if pid_alive(pid) {
        let mut registry = state.running_servers.lock().unwrap();
        registry.insert(
            server_id,
            crate::state::RunningServer {
                pid,
                // started_at is approximate for re-registered servers; uptime
                // will read from SQLite updated_at on the frontend instead.
                started_at: Instant::now(),
            },
        );
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Delete a server from disk (optionally) and clean up in-memory state.
///
/// Database record deletion is handled by the frontend via `db.deleteServerRecord()`.
/// This command only removes the install directory when `delete_files` is true.
#[tauri::command]
pub async fn delete_server(
    state: tauri::State<'_, AppState>,
    server_id: String,
    install_path: String,
    delete_files: bool,
) -> Result<(), String> {
    // If the server is running, force-stop it first.
    let pid = {
        let registry = state.running_servers.lock().unwrap();
        registry.get(&server_id).map(|rs| rs.pid)
    };
    if let Some(pid) = pid {
        state
            .stopping_servers
            .lock()
            .unwrap()
            .insert(server_id.clone());
        kill_process_tree(pid, false);
        // Brief wait — we don't block long here.
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        state.running_servers.lock().unwrap().remove(&server_id);
        state.stopping_servers.lock().unwrap().remove(&server_id);
    }

    if delete_files && !install_path.is_empty() {
        std::fs::remove_dir_all(&install_path)
            .map_err(|e| format!("Failed to delete server files at {install_path}: {e}"))?;
    }

    Ok(())
}

/// Recursively copy the server installation directory to a new location.
///
/// This is the file-system half of Clone Server — all SQLite record creation
/// (new server row, config, mods, schedules) is handled by the frontend.
/// Skips `ShooterGame/Saved` so player data from the source is not carried over.
#[tauri::command]
pub async fn clone_server(
    source_install_path: String,
    dest_install_path: String,
) -> Result<(), String> {
    let src = std::path::PathBuf::from(&source_install_path);
    let dst = std::path::PathBuf::from(&dest_install_path);

    if !src.exists() {
        return Err(format!(
            "Source path does not exist: {source_install_path}"
        ));
    }
    if dst.exists() {
        return Err(format!(
            "Destination already exists: {dest_install_path}"
        ));
    }

    tokio::task::spawn_blocking(move || {
        copy_dir_recursive(&src, &dst, &["Saved"])
            .map_err(|e| format!("Failed to clone server files: {e}"))
    })
    .await
    .map_err(|e| format!("Clone task panicked: {e}"))??;

    Ok(())
}
