use crate::{events, state::{AppState, log_manager::LogManagerState, rcon_pool::RconPool}};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
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
    /// One of: stopped | starting | running | stopping | updating | error | crashed | start-failed
    pub status: String,
    pub pid: Option<u32>,
    pub uptime_seconds: Option<u64>,
    /// Populated for `start-failed` — last ~800 chars of stderr from the failed process.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Strip ANSI escape sequences (e.g. `\x1b[1;32m`) from a string so raw
/// terminal output is readable in notifications and Discord embeds.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// Remove Steam/Wine/Proton diagnostic noise from stderr before surfacing it
/// as a start-failed error. These lines are emitted unconditionally by the
/// runtime and contain no actionable information for the user.
fn filter_steam_noise(s: &str) -> String {
    let noisy_prefixes = [
        "ProtonFixes",
        "wineserver:",
        "WARNING: radv",
        "WARNING: ANV",
        "wine: ",
        "wine64: ",
        "fsync:",
        "esync:",
    ];
    let noisy_contains = ["minidumps folder is set to", "NTSync up and running"];
    let lines: Vec<&str> = s
        .lines()
        .filter(|line| {
            let l = line.trim();
            if l.is_empty() {
                return false;
            }
            if noisy_prefixes.iter().any(|p| l.starts_with(p)) {
                return false;
            }
            if noisy_contains.iter().any(|p| l.contains(p)) {
                return false;
            }
            true
        })
        .collect();
    lines.join("\n")
}

/// Full parameter set for starting an ASA dedicated server.
/// The frontend reads all values from SQLite and passes them here — Rust does
/// no DB access of its own.
///
/// Server name, passwords, rates, RCON, and MaxPlayers all live in
/// GameUserSettings.ini — they are NOT passed on the command line.
/// Only map path, ports, mods, and CLI-only flags are handled here.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StartServerParams {
    pub server_id: String,
    /// Human-readable server name — used only for log archiving context.
    pub server_name: String,
    /// Absolute path to the server install directory.
    pub install_path: String,
    /// ASA map identifier, e.g. "TheIsland_WP".
    pub map_path: String,
    /// Game UDP port that clients connect to (CLI only, must be ?Port=).
    pub port: u16,
    /// Steam query UDP port (CLI only, must be ?QueryPort=).
    pub query_port: u16,
    /// RCON TCP port — NOT passed on CLI; used internally for readiness polling.
    /// The actual value is read by the server from GameUserSettings.ini [ServerSettings].
    pub rcon_port: u16,
    /// RCON password — NOT passed on CLI; used internally for graceful shutdown
    /// (saveworld/doexit) and readiness polling.
    pub rcon_password: String,
    /// Additional CLI-only flags, e.g. ["-NoBattlEye", "-ForceRespawnDinos"].
    pub extra_args: Vec<String>,
    /// CurseForge mod IDs to load. Passed as `-mods=id1,id2,...`.
    pub mod_ids: Vec<String>,
    /// Linux only: path to the Proton-GE installation directory.
    pub proton_path: Option<String>,
    /// Linux only: WINEPREFIX path where Proton creates its fake C: drive.
    pub prefix_path: Option<String>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Emit both the per-server and global status-change events.
pub(crate) fn emit_status(app: &tauri::AppHandle, status: &ServerStatus) {
    let _ = app.emit(
        &events::server_event(events::SERVER_STATUS, &status.server_id),
        status.clone(),
    );
    let _ = app.emit(events::SERVER_ANY_CHANGE, status.clone());
}

/// Kill a process and all related game processes.
///
/// On Linux the tracked PID is the Python Proton launcher, which may exit early
/// when the Steam Runtime container re-parents Wine to PID 1.  We always
/// supplement the sysinfo subtree walk with a procfs cmdline scan keyed on the
/// install path so Wine processes unreachable via the parent chain are also
/// terminated.  Signals are sent leaves-first so parents cannot respawn children.
fn kill_process_tree(root_pid: u32, graceful: bool, install_path: &str) {
    use sysinfo::{Pid, ProcessesToUpdate, System};

    let root = Pid::from_u32(root_pid);
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, false);

    let mut pids = collect_subtree(&sys, root);

    // On Linux, procfs cmdline scan catches Wine processes that sysinfo misses
    // (re-parented to PID 1 by the Steam Runtime container).
    #[cfg(target_os = "linux")]
    {
        use std::collections::HashSet;
        let known: HashSet<Pid> = pids.iter().copied().collect();
        for extra_pid in super::utils::find_pids_by_install_path(install_path) {
            let spid = Pid::from_u32(extra_pid);
            if !known.contains(&spid) {
                for sp in collect_subtree(&sys, spid) {
                    if !pids.contains(&sp) {
                        pids.push(sp);
                    }
                }
            }
        }
    }

    for pid in pids.iter().rev() {
        #[cfg(target_os = "linux")]
        super::utils::signal_pid(pid.as_u32(), graceful);
        #[cfg(not(target_os = "linux"))]
        if let Some(proc) = sys.process(*pid) {
            proc.kill();
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

/// Returns true if a server is currently tracked as running in AppState.
pub fn is_server_running(app: &tauri::AppHandle, server_id: &str) -> bool {
    app.state::<AppState>()
        .running_servers
        .lock()
        .unwrap()
        .contains_key(server_id)
}

/// The graceful-shutdown-via-RCON sequence shared by every restart/update
/// path (scheduled and manually-triggered via the countdown commands):
/// SaveWorld → wait 3s for the save to flush → doexit → poll for the process
/// to actually exit (up to 30s) → force-kill if it's still alive. Previously
/// reimplemented six times across server.rs/scheduler.rs/countdown.rs, with
/// two copies having drifted to a 2s wait instead of 3s.
pub async fn graceful_shutdown_via_rcon(
    app: &tauri::AppHandle,
    server_id: &str,
    rcon_port: u16,
    rcon_password: &str,
) {
    use tokio::time::{sleep, Duration};

    // Mark intentional before sending doexit, not after polling confirms the
    // process is gone — the exit watcher can resolve within milliseconds of
    // doexit, and it decides "stopped" vs "crashed" by checking this set. Every
    // other stop path marks it before touching the process; this one used to
    // mark it only at the very end (via inner_stop_server), so a fast exit
    // would already be reported as a crash by the time we got there.
    app.state::<AppState>().stopping_servers.lock().unwrap().insert(server_id.to_string());

    let _ = super::rcon::transient_rcon_command(rcon_port, rcon_password, "saveworld").await;
    sleep(Duration::from_secs(3)).await;
    let _ = super::rcon::transient_rcon_command(rcon_port, rcon_password, "doexit").await;

    for _ in 0..60 {
        sleep(Duration::from_millis(500)).await;
        if !is_server_running(app, server_id) { break; }
    }
    let _ = inner_stop_server(app, server_id, false);
}

/// PID-based variant of `graceful_shutdown_via_rcon`, for the two call sites
/// (`graceful_stop_server`, `inner_restart_server`) that only clear the
/// `running_servers` registry entry themselves *after* this returns — for
/// them, polling the registry mid-wait would never observe the process as
/// gone, so this polls the OS process table directly instead. SaveWorld →
/// wait 3s → doexit → poll `pid_alive` (up to 30s) → force-kill via
/// `kill_process_tree` if still alive.
async fn graceful_shutdown_via_rcon_pid(
    pid: u32,
    install_path: &str,
    rcon_port: u16,
    rcon_password: &str,
) {
    use super::rcon::transient_rcon_command;
    use tokio::time::{sleep, Duration};

    let _ = transient_rcon_command(rcon_port, rcon_password, "saveworld").await;
    sleep(Duration::from_secs(3)).await;
    let _ = transient_rcon_command(rcon_port, rcon_password, "doexit").await;

    for _ in 0..60 {
        sleep(Duration::from_millis(500)).await;
        if !pid_alive(pid) { break; }
    }
    if pid_alive(pid) {
        kill_process_tree(pid, false, install_path);
        sleep(Duration::from_millis(500)).await;
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Try an A2S_INFO Source Query on localhost. Returns true if any UDP response
/// arrives within 3 seconds. Used by the readiness fallback to get a second
/// opinion when the log watcher times out without seeing READY_MSG.
async fn try_source_query_local(port: u16) -> bool {
    use tokio::net::UdpSocket;
    use tokio::time::{timeout, Duration};
    let Ok(sock) = UdpSocket::bind("0.0.0.0:0").await else { return false };
    if sock.connect(format!("127.0.0.1:{port}")).await.is_err() { return false; }
    let req: &[u8] = b"\xFF\xFF\xFF\xFF\x54Source Engine Query\x00";
    if sock.send(req).await.is_err() { return false; }
    let mut buf = [0u8; 64];
    timeout(Duration::from_secs(3), sock.recv(&mut buf))
        .await
        .is_ok_and(|r| r.is_ok())
}

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
    let server_info = {
        let registry = state.running_servers.lock().unwrap();
        registry.get(server_id).map(|rs| (rs.pid, rs.install_path.clone()))
    };
    let (pid, install_path) = server_info.ok_or_else(|| format!("Server {server_id} is not running"))?;
    state.stopping_servers.lock().unwrap().insert(server_id.to_string());
    kill_process_tree(pid, graceful, &install_path);
    Ok(())
}

/// Core start logic shared between `start_server` (Tauri command) and `inner_start_server`.
async fn inner_start_server_with_state(
    app_handle: &tauri::AppHandle,
    state: &AppState,
    params: StartServerParams,
) -> Result<u32, String> {
    // Build the ?-delimited query string that follows the map name.
    // Passwords, RCON, MaxPlayers, and all gameplay settings are read by the
    // server from GameUserSettings.ini — they must NOT be duplicated on the CLI
    // or they will override INI values on every restart.
    let query_string = format!(
        "{}?listen?Port={}?QueryPort={}",
        params.map_path,
        params.port,
        params.query_port,
    );

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
    cmd.stderr(std::process::Stdio::piped());

    // The AppImage runtime modifies several environment variables so the Tauri
    // binary can find its bundled libraries and Python runtime. Child processes
    // (Proton script, Wine) inherit all of these and break in different ways:
    //   - LD_LIBRARY_PATH: Wine loads AppImage's bundled .so instead of system libs
    //   - PYTHONHOME:       Proton (a Python script) sets sys.prefix to the squashfs
    //                       mount, then crashes with "No module named 'encodings'"
    //                       because the system Python binary can't find modules there
    //   - PYTHONPATH:       adds AppImage Python paths to sys.path, same root cause
    // The AppImage linker saves original values as APPIMAGE_ORIGINAL_* — restore
    // them for the child so our process is unaffected.
    #[cfg(not(target_os = "windows"))]
    if std::env::var_os("APPIMAGE").is_some() {
        match std::env::var("APPIMAGE_ORIGINAL_LD_LIBRARY_PATH") {
            Ok(orig) => { cmd.env("LD_LIBRARY_PATH", orig); }
            Err(_) => { cmd.env_remove("LD_LIBRARY_PATH"); }
        }
        if let Ok(orig_path) = std::env::var("APPIMAGE_ORIGINAL_PATH") {
            cmd.env("PATH", orig_path);
        }
        // PYTHONHOME must be cleared — if left set, the system Python binary
        // uses the AppImage squashfs as its prefix and immediately fails to find
        // its own stdlib (confirmed via 'No module named encodings' crash).
        cmd.env_remove("PYTHONHOME");
        cmd.env_remove("PYTHONPATH");
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = if e.kind() == std::io::ErrorKind::NotFound {
                // The server executable is missing — reinstall is the only fix.
                // Prefix lets the frontend detect this case and hide the Retry button.
                "exe_missing: ArkAscendedServer.exe was not found. Please reinstall the server.".to_string()
            } else {
                format!("Failed to start server process: {e}")
            };
            return Err(msg);
        }
    };

    let pid = child.id().ok_or("Spawned process has no PID")?;

    // Take the stderr handle before moving `child` into the watcher task.
    let child_stderr = child.stderr.take();

    // Shared flag: set to true by the readiness poller once RCON responds.
    // The watcher task reads this on exit to distinguish a startup failure
    // (process died before ever being ready) from a runtime crash.
    let confirmed_running = Arc::new(AtomicBool::new(false));
    // Set to true by the readiness task if the CurseForge mod API unreachable
    // error is seen in the log. The watcher task emits a dedicated retry event
    // instead of "start-failed" so the frontend can auto-retry silently.
    let cfcore_unreachable = Arc::new(AtomicBool::new(false));

    // Register in the running map.
    {
        let mut registry = state.running_servers.lock().unwrap();
        registry.insert(
            params.server_id.clone(),
            crate::state::RunningServer {
                pid,
                started_at: Instant::now(),
                install_path: params.install_path.clone(),
                confirmed_running: false,
                start_params: params.clone(),
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
            error: None,
        },
    );

    // Spawn a watcher task that owns the child handle and waits for it to exit.
    // Concurrently reads up to 4 KB of stderr (Proton diagnostic output) so we
    // can surface the reason when a genuine start failure occurs.
    let sid                  = params.server_id.clone();
    let install_path_watcher = params.install_path.clone();
    let handle_clone         = app_handle.clone();
    let confirmed_clone      = Arc::clone(&confirmed_running);
    let cfcore_clone         = Arc::clone(&cfcore_unreachable);
    let server_name_notif    = params.server_name.clone();
    tauri::async_runtime::spawn(async move {
        let (_, raw_stderr) = tokio::join!(
            child.wait(),
            async move {
                let Some(s) = child_stderr else {
                    return String::new();
                };
                use tokio::io::AsyncReadExt;
                use tokio::time::{timeout, Duration};
                let mut buf = Vec::new();
                // 3-second safety timeout in case Wine children keep the pipe open.
                let _ = timeout(
                    Duration::from_secs(3),
                    s.take(4096).read_to_end(&mut buf),
                )
                .await;
                String::from_utf8_lossy(&buf).to_string()
            }
        );

        let app_state    = handle_clone.state::<AppState>();
        let was_intentional = app_state.stopping_servers.lock().unwrap().remove(&sid);

        // ── Intentional stop ─────────────────────────────────────────────────
        if was_intentional {
            app_state.running_servers.lock().unwrap().remove(&sid);
            handle_clone.state::<RconPool>().remove_server(&sid).await;
            LogManagerState::archive_all_server_logs(&handle_clone, &sid, &install_path_watcher).await;

            // If a restart/update flow is waiting on this stop, wake it now
            // that cleanup above is actually done — it'll emit whatever
            // comes next (startup_queued, updating, etc.) itself. Otherwise
            // this is a plain stop: report "stopped" ourselves.
            if !app_state.handoff_stop_to_restart_flow(&sid) {
                crate::commands::notifications::dispatch_notification(
                    &handle_clone, "server_stopped", Some(&sid), &server_name_notif,
                    &format!("{} stopped", server_name_notif), "Server has shut down.", "info",
                ).await;
                emit_status(&handle_clone, &ServerStatus {
                    server_id: sid, status: "stopped".into(),
                    pid: None, uptime_seconds: None, error: None,
                });
            }
            return;
        }

        // ── Runtime crash (was confirmed running) ────────────────────────────
        if confirmed_clone.load(Ordering::Relaxed) {
            app_state.running_servers.lock().unwrap().remove(&sid);
            handle_clone.state::<RconPool>().remove_server(&sid).await;
            LogManagerState::archive_all_server_logs(&handle_clone, &sid, &install_path_watcher).await;
            crate::commands::notifications::dispatch_notification(
                &handle_clone, "server_crashed", Some(&sid), &server_name_notif,
                &format!("{} crashed", server_name_notif),
                "The server process crashed unexpectedly.", "error",
            ).await;
            emit_status(&handle_clone, &ServerStatus {
                server_id: sid, status: "crashed".into(),
                pid: None, uptime_seconds: None, error: None,
            });
            return;
        }

        // ── Proton exited before the server was confirmed ────────────────────
        // On Linux with the Steam Runtime, Proton (a Python script) hands the
        // Wine process off to the container daemon and exits — this is NORMAL.
        // The game continues under a different PID.  Before declaring a start
        // failure, scan /proc for up to 10 s (20 × 500 ms) to see if the game
        // process appears. If it does, update the tracked PID and let the
        // log-watcher task handle the "running" transition.
        #[cfg(target_os = "linux")]
        {
            for i in 0..20u32 {
                if let Some(game_pid) =
                    super::utils::find_game_process_pid(&install_path_watcher)
                {
                    // Game is alive — Proton handed off normally.
                    // Update the PID so stats and the log watcher use the right process.
                    let mut registry = app_state.running_servers.lock().unwrap();
                    if let Some(rs) = registry.get_mut(&sid) {
                        rs.pid = game_pid;
                    }
                    // Do NOT remove from running_servers or emit start-failed.
                    // The log-watcher task will emit "running" when the ready line appears.
                    return;
                }
                if i < 19 {
                    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                }
            }
        }

        // ── Genuine start failure ─────────────────────────────────────────────
        app_state.running_servers.lock().unwrap().remove(&sid);
        LogManagerState::archive_all_server_logs(&handle_clone, &sid, &install_path_watcher).await;

        // CurseForge mod API was unreachable — this is almost always a transient
        // network issue. Emit a dedicated event so CfcoreRetryManager can silently
        // retry up to 3 times before surfacing a failure to the user. The server
        // status stays "starting" in the DB (no start-failed event emitted here).
        if cfcore_clone.load(Ordering::Relaxed) {
            let _ = handle_clone.emit("server://cfcore-error", serde_json::json!({ "serverId": sid }));
            return;
        }

        let cleaned = strip_ansi(raw_stderr.trim());
        let filtered = filter_steam_noise(&cleaned);
        let trimmed = if filtered.len() > 800 {
            format!("\u{2026}{}", &filtered[filtered.len() - 800..])
        } else {
            filtered
        };
        let err_body = if trimmed.is_empty() {
            "Server failed to start.".to_string()
        } else {
            trimmed.clone()
        };
        crate::commands::notifications::dispatch_notification(
            &handle_clone, "server_start_failed", Some(&sid), &server_name_notif,
            &format!("{} failed to start", server_name_notif), &err_body, "error",
        ).await;
        emit_status(&handle_clone, &ServerStatus {
            server_id: sid,
            status: "start-failed".into(),
            pid: None,
            uptime_seconds: None,
            error: Some(trimmed).filter(|s| !s.is_empty()),
        });
    });

    // On Linux, spawn a background task that resolves the real game PID as soon
    // as the Wine process appears — typically 15–30 s after Proton launches.
    // This lets the frontend show CPU/RAM stats while the server is still loading
    // (status = "starting"), without waiting 5–15 min for RCON to confirm.
    //
    // Once found, we update running_servers.pid and re-emit "starting" with the
    // game PID so the frontend writes it to SQLite and useServerStats starts
    // polling the correct process immediately.
    #[cfg(target_os = "linux")]
    {
        let sid_pid = params.server_id.clone();
        let path_pid = params.install_path.clone();
        let handle_pid = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            use tokio::time::{sleep, Duration};

            // Wait for Proton to finish launching Wine.
            sleep(Duration::from_secs(20)).await;

            // Poll up to 3 minutes (36 × 5 s) for the game process to appear.
            for _ in 0..36u32 {
                let state = handle_pid.state::<AppState>();

                // Stop if the server was stopped/crashed before we found it.
                let current_pid = {
                    let registry = state.running_servers.lock().unwrap();
                    registry.get(&sid_pid).map(|rs| rs.pid)
                };
                let Some(tracked_pid) = current_pid else { return; };

                if let Some(game_pid) = super::utils::find_game_process_pid(&path_pid) {
                    if game_pid != tracked_pid {
                        // Update in-memory state and notify the frontend.
                        let uptime = {
                            let mut registry = state.running_servers.lock().unwrap();
                            registry.get_mut(&sid_pid).map(|rs| {
                                rs.pid = game_pid;
                                rs.started_at.elapsed().as_secs()
                            })
                        };
                        if let Some(up) = uptime {
                            emit_status(
                                &handle_pid,
                                &ServerStatus {
                                    server_id: sid_pid,
                                    status: "starting".into(),
                                    pid: Some(game_pid),
                                    uptime_seconds: Some(up),
                                    error: None,
                                },
                            );
                        }
                    }
                    return; // PID resolved — task is done.
                }

                sleep(Duration::from_secs(5)).await;
            }
        });
    }

    // Spawn a readiness poller.  ASA on Linux via Proton can take several
    // minutes to load the map before it accepts connections.  We poll the
    // RCON TCP port every 5 s; the first successful TCP connect means the
    // server is up and players can join.  Timeout after 15 min.
    //
    // Spawn a readiness task that watches the server log for the definitive
    // "server is up" message.  This is the most reliable signal available:
    // RCON opens seconds after launch (before map loads), Source Query may
    // not respond from loopback on all configurations, but the log line
    // "Server has completed startup and is now advertising for join" appears
    // exactly when players can connect.
    //
    // Falls back to emitting "running" after 15 minutes if the message is
    // never seen (e.g. log location changed, log disabled) so the server
    // doesn't stay in "starting" forever.
    let sid2              = params.server_id.clone();
    let handle2           = app_handle.clone();
    let query_port2       = params.query_port;
    let server_name_ready = params.server_name.clone();
    let log_path2         = format!(
        "{}/ShooterGame/Saved/Logs/ShooterGame.log",
        params.install_path
    );

    let confirmed2  = Arc::clone(&confirmed_running);
    let cfcore2     = Arc::clone(&cfcore_unreachable);
    tauri::async_runtime::spawn(async move {
        use std::io::SeekFrom;
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, BufReader};
        use tokio::time::{sleep, Duration, Instant};

        // The exact log line ARK SA writes when the server is fully loaded.
        const READY_MSG: &str =
            "Server has completed startup and is now advertising for join";
        const TIMEOUT: Duration = Duration::from_secs(20 * 60); // 20 min absolute max

        let deadline = Instant::now() + TIMEOUT;

        // Mark the server as confirmed-running, read its PID/uptime, and emit "running".
        // Sets confirmed_running = true so the crash monitor emits "crashed" (not
        // "start-failed") if the process dies after this point.
        // Returns false if the server was already removed from the map.
        let confirm_running = |handle: &tauri::AppHandle, sid: &str| -> bool {
            let pid_uptime = {
                let state = handle.state::<AppState>();
                let mut registry = state.running_servers.lock().unwrap();
                registry.get_mut(sid).map(|rs| {
                    rs.confirmed_running = true;
                    (rs.pid, rs.started_at.elapsed().as_secs())
                })
            };

            let Some((game_pid, uptime)) = pid_uptime else { return false; };

            emit_status(
                handle,
                &ServerStatus {
                    server_id: sid.to_string(),
                    status: "running".into(),
                    pid: Some(game_pid),
                    uptime_seconds: Some(uptime),
                    error: None,
                },
            );
            let handle_n = handle.clone();
            let sid_n    = sid.to_string();
            let name_n   = server_name_ready.clone();
            tauri::async_runtime::spawn(async move {
                crate::commands::notifications::dispatch_notification(
                    &handle_n, "server_started", Some(&sid_n), &name_n,
                    &format!("{name_n} is online"), "Players can now connect.", "success",
                ).await;
            });
            true
        };

        // ── Wait for the fresh log file to appear ────────────────────────────
        // Rotation happens on stop/crash/startup, so by the time the server
        // starts there is no pre-existing ShooterGame.log. Read from byte 0.
        let file = loop {
            if Instant::now() >= deadline { return; }

            let still_tracked = handle2
                .state::<AppState>()
                .running_servers
                .lock()
                .unwrap()
                .contains_key(&sid2);
            if !still_tracked { return; }

            match tokio::fs::File::open(&log_path2).await {
                Ok(f) => break f,
                Err(_) => sleep(Duration::from_secs(1)).await,
            }
        };

        let mut reader = BufReader::new(file);
        let mut buf = String::new();

        // ── Tail the log ─────────────────────────────────────────────────────
        loop {
            if Instant::now() >= deadline { break; }

            match reader.read_line(&mut buf).await {
                Ok(0) => {
                    // No new data yet.
                    let still_tracked = handle2
                        .state::<AppState>()
                        .running_servers
                        .lock()
                        .unwrap()
                        .contains_key(&sid2);
                    if !still_tracked { return; }
                    sleep(Duration::from_millis(200)).await;
                }
                Ok(_) => {
                    if buf.contains(READY_MSG) {
                        confirmed2.store(true, Ordering::Relaxed);
                        confirm_running(&handle2, &sid2);
                        crate::commands::build_version::maybe_capture_server_version(
                            &handle2, &sid2, query_port2,
                        );
                        return;
                    }
                    if buf.contains("Error querying server mods: ApiError: Failed (serverUnreachable)") {
                        cfcore2.store(true, Ordering::Relaxed);
                    }
                    buf.clear();
                }
                Err(_) => sleep(Duration::from_millis(200)).await,
            }
        }

        // ── 20-minute fallback — verify before promoting ──────────────────────
        // The tail loop timed out without seeing READY_MSG. Before blindly
        // promoting to "running", make two verification attempts:
        //
        // 1. Re-scan the tail of the current log file from scratch. This catches
        //    the TOCTOU race where we spent 20 min tailing the pre-rotation
        //    archived copy — the live file will have READY_MSG even though we
        //    never saw it in the tailed stream.
        //
        // 2. Source Query (A2S_INFO) on localhost. An independent signal that
        //    the server is advertising to Steam. May not respond from loopback
        //    on all Linux/Proton configurations, but worth a few attempts.
        //
        // If both checks fail we still promote as a last resort: the server has
        // been running 20+ minutes without crashing, so it is almost certainly
        // up. Leaving it in "starting" forever is worse than a false positive.
        let still_tracked = handle2
            .state::<AppState>()
            .running_servers
            .lock()
            .unwrap()
            .contains_key(&sid2);
        if !still_tracked { return; }

        // 1. Re-scan the tail of the log file (last 512 KB) for READY_MSG.
        let log_confirmed = 'scan: {
            let Ok(mut lf) = tokio::fs::File::open(&log_path2).await else { break 'scan false };
            const TAIL: u64 = 512 * 1024;
            let size = lf.metadata().await.map(|m| m.len()).unwrap_or(0);
            let _ = lf.seek(SeekFrom::Start(size.saturating_sub(TAIL))).await;
            let mut snippet = String::new();
            let _ = lf.read_to_string(&mut snippet).await;
            snippet.contains(READY_MSG)
        };
        if log_confirmed {
            confirmed2.store(true, Ordering::Relaxed);
            confirm_running(&handle2, &sid2);
            crate::commands::build_version::maybe_capture_server_version(
                &handle2, &sid2, query_port2,
            );
            return;
        }

        // 2. Try Source Query on localhost (3 attempts, 5 s apart).
        for _ in 0..3u8 {
            if try_source_query_local(query_port2).await {
                confirmed2.store(true, Ordering::Relaxed);
                confirm_running(&handle2, &sid2);
                crate::commands::build_version::maybe_capture_server_version(
                    &handle2, &sid2, query_port2,
                );
                return;
            }
            sleep(Duration::from_secs(5)).await;
        }

        // 3. Last resort — promote regardless.
        confirmed2.store(true, Ordering::Relaxed);
        confirm_running(&handle2, &sid2);
        crate::commands::build_version::maybe_capture_server_version(
            &handle2, &sid2, query_port2,
        );
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
/// wait up to 15 s for it to exit, then hand off to the staggered startup
/// queue rather than re-spawning directly — so a batch of restarts (Restart
/// All, or several servers hitting their memory limit around the same time)
/// doesn't cold-boot all of them at once.
#[tauri::command]
pub async fn restart_server(
    app_handle: tauri::AppHandle,
    _state: tauri::State<'_, AppState>,
    params: StartServerParams,
    graceful: bool,
) -> Result<(), String> {
    inner_restart_server(app_handle, params, graceful).await
}

/// Internal: restart logic shared between the `restart_server` command and the scheduler.
pub async fn inner_restart_server(
    app_handle: tauri::AppHandle,
    params: StartServerParams,
    graceful: bool,
) -> Result<(), String> {
    let state = app_handle.state::<AppState>();

    let running_info = {
        let registry = state.running_servers.lock().unwrap();
        registry.get(&params.server_id).map(|rs| (rs.pid, rs.install_path.clone()))
    };

    // Fail fast rather than kill/restart a server whose files a scheduled
    // backup is currently reading — held for the whole function so it also
    // covers the memory-limit auto-restart path, which calls this directly,
    // and guards against two concurrent restart triggers for the same
    // server_id (manual + scheduled + memory-limit) stepping on each other.
    let _lock = if running_info.is_some() {
        Some(state.try_lock_server(&params.server_id)
            .ok_or_else(|| format!("An operation is already in progress for {} — try again in a moment", params.server_id))?)
    } else {
        None
    };

    if let Some((pid, install_path)) = running_info {
        // Register before killing — the exit watcher can resolve almost
        // immediately, so this must be visible before the process actually dies.
        let notify = state.register_stop_handoff(&params.server_id);
        state.stopping_servers.lock().unwrap().insert(params.server_id.clone());

        if graceful {
            // Graceful path: ask the server to save and exit via RCON so it
            // flushes world data cleanly (same as the Stop button does).
            graceful_shutdown_via_rcon_pid(pid, &install_path, params.rcon_port, &params.rcon_password).await;
        } else {
            kill_process_tree(pid, false, &install_path);
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        }

        // Force-kill anything still alive after the graceful window.
        if pid_alive(pid) {
            kill_process_tree(pid, false, &install_path);
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        }

        // Wait for the watcher task to confirm its own cleanup (registry,
        // RCON pool, log rotation) is actually done before we proceed —
        // otherwise its delayed "stopped" report can race in after our
        // "startup_queued" below and silently overwrite it.
        state.wait_for_stop_handoff(&params.server_id, notify).await;

        // Fallback cleanup in case the watcher's handoff timed out.
        state.stopping_servers.lock().unwrap().remove(&params.server_id);
        state.running_servers.lock().unwrap().remove(&params.server_id);
        // Drop any RCON state tied to the process we just killed — the new
        // instance gets a fresh connection, and this avoids briefly showing
        // a stale pre-restart player list.
        app_handle.state::<RconPool>().remove_server(&params.server_id).await;
    }

    // Hand off to the frontend's staggered startup queue instead of starting
    // directly — the "server://any-change" listener re-enqueues on this status.
    emit_status(&app_handle, &ServerStatus {
        server_id: params.server_id.clone(),
        status: "startup_queued".into(),
        pid: None,
        uptime_seconds: None,
        error: None,
    });
    Ok(())
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
            error: None,
        }),
        Some((pid, started_at)) => {
            if pid_alive(pid) {
                Ok(ServerStatus {
                    server_id,
                    status: "running".into(),
                    pid: Some(pid),
                    uptime_seconds: Some(started_at.elapsed().as_secs()),
                    error: None,
                })
            } else {
                Ok(ServerStatus {
                    server_id,
                    status: "stopped".into(),
                    pid: None,
                    uptime_seconds: None,
                    error: None,
                })
            }
        }
    }
}

/// Scan for running ASA server processes on app startup.
///
/// For each entry, scans the OS for a matching game process by install path.
/// Servers that are found are registered in the running map and get a dedicated
/// watcher task that fires a crash event within ~5 s of the process dying.
/// Returns the live PID for each server found, or null if not running.
/// This replaces stored-PID reconciliation — the OS is the source of truth.
#[tauri::command]
pub async fn scan_running_servers(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    servers: Vec<ScanEntry>,
) -> Result<Vec<ScanResult>, String> {
    let mut results = Vec::new();
    let mut to_rotate: Vec<(String, String)> = Vec::new();

    for entry in servers {
        let pid = find_server_process(&entry.install_path);

        if let Some(pid) = pid {
            // Keep a copy of install_path for the watcher closure before it's moved.
            let install_path_watcher = entry.install_path.clone();
            {
                let mut registry = state.running_servers.lock().unwrap();
                // Build a minimal params stub — port/rcon fields are unknown for
                // servers detected on startup.  The memory-limit checker emits an
                // event instead of doing an in-process restart when rcon_port == 0.
                let stub_params = StartServerParams {
                    server_id:    entry.server_id.clone(),
                    server_name:  String::new(),
                    install_path: entry.install_path.clone(),
                    map_path:     String::new(),
                    port:         0,
                    query_port:   0,
                    rcon_port:    0,
                    rcon_password: String::new(),
                    extra_args:   vec![],
                    mod_ids:      vec![],
                    proton_path:  None,
                    prefix_path:  None,
                };
                registry.insert(
                    entry.server_id.clone(),
                    crate::state::RunningServer {
                        pid,
                        started_at: Instant::now(),
                        install_path: entry.install_path,
                        confirmed_running: true,
                        start_params: stub_params,
                    },
                );
            }

            let handle = app_handle.clone();
            let sid = entry.server_id.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;

                    let app_state = handle.state::<AppState>();

                    // stop_server removes the entry — if it's gone, exit cleanly.
                    if !app_state.running_servers.lock().unwrap().contains_key(&sid) {
                        break;
                    }

                    if !pid_alive(pid) {
                        let was_intentional = app_state
                            .stopping_servers
                            .lock()
                            .unwrap()
                            .remove(&sid);

                        app_state.running_servers.lock().unwrap().remove(&sid);

                        // Rotate logs before announcing the status change so the
                        // frontend can display the archived last-session log immediately.
                        LogManagerState::archive_all_server_logs(&handle, &sid, &install_path_watcher).await;

                        // If a restart/update flow is waiting on this stop,
                        // wake it now that cleanup above is actually done —
                        // it'll emit whatever comes next itself. See the same
                        // handoff in inner_start_server's watcher task.
                        let handed_off = was_intentional && app_state.handoff_stop_to_restart_flow(&sid);
                        if !handed_off {
                            let status = if was_intentional { "stopped" } else { "crashed" };
                            let payload = ServerStatus {
                                server_id: sid.clone(),
                                status: status.into(),
                                pid: None,
                                uptime_seconds: None,
                                error: None,
                            };

                            let _ = handle.emit(
                                &events::server_event(events::SERVER_STATUS, &sid),
                                payload.clone(),
                            );
                            let _ = handle.emit(events::SERVER_ANY_CHANGE, payload);
                        }
                        break;
                    }
                }
            });
        } else {
            // Not running — schedule for startup rotation.
            to_rotate.push((entry.server_id.clone(), entry.install_path.clone()));
        }

        results.push(ScanResult { server_id: entry.server_id, pid });
    }

    // Rotate all stopped servers before returning so the scan-complete signal
    // only reaches the frontend after logs are already in central storage.
    for (server_id, install_path) in to_rotate {
        LogManagerState::archive_all_server_logs(&app_handle, &server_id, &install_path).await;
    }

    Ok(results)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanEntry {
    pub server_id: String,
    pub install_path: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub server_id: String,
    pub pid: Option<u32>,
}

/// Find a running ASA server process by install path.
/// Linux: procfs cmdline scan finds the Wine game process even when re-parented.
/// Windows: sysinfo exe-path scan finds ArkAscendedServer.exe directly.
#[cfg(target_os = "linux")]
fn find_server_process(install_path: &str) -> Option<u32> {
    super::utils::find_game_process_pid(install_path)
}

#[cfg(target_os = "windows")]
fn find_server_process(install_path: &str) -> Option<u32> {
    use sysinfo::{ProcessesToUpdate, System};

    if install_path.is_empty() {
        return None;
    }

    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, false);

    let base = install_path.trim_end_matches('\\').trim_end_matches('/').to_lowercase();

    for (pid, proc) in sys.processes() {
        let exe = proc
            .exe()
            .map(|p| p.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if exe.starts_with(&base) && exe.contains("arkascendedserver") {
            return Some(pid.as_u32());
        }
    }
    None
}

/// Return the total on-disk size (in bytes) of an arbitrary directory tree.
/// Returns 0 if the path doesn't exist.
#[tauri::command]
pub async fn get_dir_size(path: String) -> u64 {
    fn walk(p: &std::path::Path) -> u64 {
        if !p.exists() { return 0; }
        let mut total = 0u64;
        if let Ok(rd) = std::fs::read_dir(p) {
            for entry in rd.flatten() {
                let ep = entry.path();
                if ep.is_dir() { total += walk(&ep); }
                else if let Ok(m) = ep.metadata() { total += m.len(); }
            }
        }
        total
    }
    walk(std::path::Path::new(&path))
}

/// Return the total on-disk size (in bytes) of a server's backup, log, and save data.
/// Values are 0 if the directories don't exist.
#[tauri::command]
pub async fn get_server_disk_usage(
    app: tauri::AppHandle,
    server_id: String,
    backup_dir: String,
    base_dir: String,
) -> Result<serde_json::Value, String> {
    fn dir_size(path: &std::path::Path) -> u64 {
        if !path.exists() { return 0; }
        // Follow symlinks for the top-level dir but not recursively, to handle
        // the SavedArks symlink case where the real data is under base_dir/Saves/.
        let mut total = 0u64;
        if let Ok(walker) = std::fs::read_dir(path) {
            for entry in walker.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    total += dir_size(&p);
                } else if let Ok(meta) = p.metadata() {
                    total += meta.len();
                }
            }
        }
        total
    }

    let backup_bytes = if !backup_dir.is_empty() {
        let p = std::path::PathBuf::from(&backup_dir).join(&server_id);
        dir_size(&p)
    } else {
        0
    };

    let log_bytes = {
        use crate::state::log_manager::LogManagerState;
        let p = LogManagerState::server_logs_dir(&app, &server_id);
        p.map(|d| dir_size(&d)).unwrap_or(0)
    };

    let save_bytes = if !base_dir.is_empty() {
        let p = std::path::PathBuf::from(&base_dir).join("saves").join(&server_id).join("SavedArks");
        dir_size(&p)
    } else {
        0
    };

    Ok(serde_json::json!({
        "backupBytes": backup_bytes,
        "logBytes": log_bytes,
        "saveBytes": save_bytes,
    }))
}

/// Delete a server from disk (optionally) and clean up in-memory state.
///
/// Database record deletion is handled by the frontend via `db.deleteServerRecord()`.
/// This command only removes the install directory when `delete_files` is true.
#[tauri::command]
pub async fn delete_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    server_id: String,
    install_path: String,
    backup_dir: String,
    base_dir: String,
    delete_files: bool,
    delete_backups: bool,
    delete_logs: bool,
    delete_saves: bool,
) -> Result<(), String> {
    // Held for the whole delete so a scheduled backup/update can't be
    // touching this server's files at the same moment we start removing them.
    let _lock = state.try_lock_server(&server_id)
        .ok_or_else(|| format!("An operation is already in progress for {server_id} — try again in a moment"))?;

    // If the server is running, force-stop it first.
    let pid = {
        let registry = state.running_servers.lock().unwrap();
        registry.get(&server_id).map(|rs| rs.pid)
    };
    if let Some(pid) = pid {
        // Register before killing so the exit watcher hands its cleanup off
        // to us — otherwise it can independently recreate the log directory
        // (via its own archive step) moments after we delete it below.
        let notify = state.register_stop_handoff(&server_id);
        state
            .stopping_servers
            .lock()
            .unwrap()
            .insert(server_id.clone());
        kill_process_tree(pid, false, &install_path);
        // Wait for the process to actually exit (up to 15 s) before touching
        // its files — a fixed 500 ms wait isn't enough on a slow-to-release
        // process (common on Windows under antivirus scanning), and would
        // make remove_dir_all below fail with "file in use".
        for _ in 0..30 {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            if !pid_alive(pid) { break; }
        }
        if pid_alive(pid) {
            kill_process_tree(pid, false, &install_path);
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        }
        // Wait for the watcher's own cleanup (including log archiving) to
        // actually finish before we proceed to delete files below.
        state.wait_for_stop_handoff(&server_id, notify).await;
        state.running_servers.lock().unwrap().remove(&server_id);
        state.stopping_servers.lock().unwrap().remove(&server_id);
    }
    // The server is being permanently removed — always drop its RCON state,
    // regardless of which delete_* flags were set.
    app.state::<RconPool>().remove_server(&server_id).await;

    if delete_files && !install_path.is_empty() {
        std::fs::remove_dir_all(&install_path)
            .map_err(|e| format!("Failed to delete server files at {install_path}: {e}"))?;
    }

    if delete_backups && !backup_dir.is_empty() {
        let p = std::path::PathBuf::from(&backup_dir).join(&server_id);
        if p.exists() {
            std::fs::remove_dir_all(&p)
                .map_err(|e| format!("Failed to delete backup data: {e}"))?;
        }
    }

    if delete_logs {
        use crate::state::log_manager::LogManagerState;
        if let Some(p) = LogManagerState::server_logs_dir(&app, &server_id) {
            if p.exists() {
                std::fs::remove_dir_all(&p)
                    .map_err(|e| format!("Failed to delete log data: {e}"))?;
            }
        }
    }

    if delete_saves && !base_dir.is_empty() {
        let p = std::path::PathBuf::from(&base_dir).join("saves").join(&server_id);
        if p.exists() {
            std::fs::remove_dir_all(&p)
                .map_err(|e| format!("Failed to delete save data: {e}"))?;
        }
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
        copy_dir_recursive(&src, &dst, &["Saved"], None)
            .map_err(|e| format!("Failed to clone server files: {e}"))
    })
    .await
    .map_err(|e| format!("Clone task panicked: {e}"))??;

    Ok(())
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

/// Gracefully stop a running server with optional player countdown warnings.
///
/// Flow:
///   1. Emit "stopping" status
///   2. If warn_players AND players are online: send countdown chat messages
///   3. SaveWorld (wait for acknowledgment)
///   4. DoExit
///   5. Wait up to 30 s for process to exit, then force-kill
///   6. Emit "stopped" status
#[tauri::command]
pub async fn graceful_stop_server(
    app_handle: tauri::AppHandle,
    server_id: String,
    rcon_port: u16,
    rcon_password: String,
    warn_players: bool,
    warn_minutes: u64,
    warn_message: String,
) -> Result<(), String> {
    use crate::commands::rcon::transient_rcon_command;
    use tokio::time::{sleep, Duration};

    let state = app_handle.state::<AppState>();
    let pool = app_handle.state::<RconPool>();

    // Held for the whole operation (including the player-warning countdown,
    // which can run for several minutes) so a scheduled backup can't start
    // mid-shutdown and produce a truncated archive.
    let _lock = state.try_lock_server(&server_id)
        .ok_or_else(|| format!("An operation is already in progress for {server_id} — try again in a moment"))?;

    let (pid, install_path, server_name) = {
        let registry = state.running_servers.lock().unwrap();
        registry
            .get(&server_id)
            .map(|rs| (rs.pid, rs.install_path.clone(), rs.start_params.server_name.clone()))
            .ok_or_else(|| format!("Server {server_id} is not running"))?
    };

    // Register before killing — see inner_restart_server for why. Ensures the
    // exit watcher hands its cleanup off to us instead of emitting its own
    // "stopped" (and notification) concurrently with what we emit below.
    let notify = state.register_stop_handoff(&server_id);
    state.stopping_servers.lock().unwrap().insert(server_id.clone());

    emit_status(&app_handle, &ServerStatus {
        server_id: server_id.clone(),
        status: "stopping".into(),
        pid: Some(pid),
        uptime_seconds: None,
        error: None,
    });

    // Helper: returns true if at least one player is connected right now.
    let has_players = |resp: &str| -> bool {
        !resp.trim().is_empty() && !resp.to_lowercase().contains("no players")
    };

    // Optional player countdown — re-checks player count before each message
    // so we skip straight to save+exit the moment the server empties.
    if warn_players && warn_minutes > 0 {
        let initial_check = transient_rcon_command(rcon_port, &rcon_password, "listplayers").await.unwrap_or_default();

        if has_players(&initial_check) {
            let total_secs = warn_minutes * 60;
            let mut elapsed: u64 = 0;

            let initial_msg = warn_message.replace(
                "{time}",
                &format!("{warn_minutes} minute{}", if warn_minutes == 1 { "" } else { "s" }),
            );
            let _ = transient_rcon_command(rcon_port, &rcon_password, &format!("ServerChat {initial_msg}")).await;

            'countdown: while elapsed < total_secs {
                let remaining = total_secs - elapsed;
                let interval_secs: u64 = if remaining <= 5 { 1 } else if remaining <= 30 { 5 } else { 60 };

                sleep(Duration::from_secs(interval_secs)).await;
                elapsed += interval_secs;

                // If server is now empty, skip the rest of the countdown.
                let check = transient_rcon_command(rcon_port, &rcon_password, "listplayers").await.unwrap_or_default();
                if !has_players(&check) {
                    break 'countdown;
                }

                let still_remaining = total_secs.saturating_sub(elapsed);
                if still_remaining == 0 { break; }

                let time_str = if still_remaining >= 60 {
                    let m = still_remaining / 60;
                    format!("{m} minute{}", if m == 1 { "" } else { "s" })
                } else {
                    format!("{still_remaining} second{}", if still_remaining == 1 { "" } else { "s" })
                };

                let msg = warn_message.replace("{time}", &time_str);
                let _ = transient_rcon_command(rcon_port, &rcon_password, &format!("ServerChat {msg}")).await;
            }
        }
    }

    // SaveWorld → wait → DoExit → poll for exit → force-kill if still alive.
    graceful_shutdown_via_rcon_pid(pid, &install_path, rcon_port, &rcon_password).await;

    // Wait for the exit watcher's own cleanup (registry, RCON pool, log
    // archiving) to actually finish before we report "stopped" — otherwise
    // its delayed completion could race in after we've already moved on.
    state.wait_for_stop_handoff(&server_id, notify).await;

    // Fallback cleanup in case the watcher's handoff timed out (30s) —
    // log archiving isn't repeated here since the watcher always does that
    // unconditionally as part of its own cleanup, handoff or not.
    state.stopping_servers.lock().unwrap().remove(&server_id);
    state.running_servers.lock().unwrap().remove(&server_id);
    pool.remove_server(&server_id).await;

    crate::commands::notifications::dispatch_notification(
        &app_handle, "server_stopped", Some(&server_id), &server_name,
        &format!("{server_name} stopped"), "Server has shut down.", "info",
    ).await;
    emit_status(&app_handle, &ServerStatus {
        server_id,
        status: "stopped".into(),
        pid: None,
        uptime_seconds: None,
        error: None,
    });

    Ok(())
}

/// Called by CfcoreRetryManager after all 3 auto-retry attempts have failed.
/// Emits the standard "start-failed" status event with a user-friendly
/// explanation so the UI and NotificationManager treat it as a normal failure.
#[tauri::command]
pub async fn force_server_start_failed(
    server_id: String,
    error: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    emit_status(&app, &ServerStatus {
        server_id,
        status: "start-failed".into(),
        pid: None,
        uptime_seconds: None,
        error: Some(error),
    });
    Ok(())
}
