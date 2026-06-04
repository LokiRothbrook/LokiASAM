use crate::{events, state::AppState};
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
fn emit_status(app: &tauri::AppHandle, status: &ServerStatus) {
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

    // Rotate any existing ShooterGame.log before launching. We own log rotation
    // from here on — archiving the old file ourselves so the fresh log starts at
    // byte 0 and the readiness watcher below never has to deal with inodes.
    let current_log_path = format!(
        "{}/ShooterGame/Saved/Logs/ShooterGame.log",
        params.install_path
    );
    let did_rotate: bool = if tokio::fs::metadata(&current_log_path).await.is_ok() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let (year, month, day, hh, mm, ss) = {
            let secs_per_day = 86_400u64;
            let days = now_secs / secs_per_day;
            let day_secs = now_secs % secs_per_day;
            let mut d = days;
            let mut y = 1970u64;
            loop {
                let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
                let days_in_year = if leap { 366 } else { 365 };
                if d < days_in_year { break; }
                d -= days_in_year;
                y += 1;
            }
            let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
            let days_in_month = [31u64, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
            let mut mo = 0usize;
            while mo < 12 && d >= days_in_month[mo] { d -= days_in_month[mo]; mo += 1; }
            (y, (mo + 1) as u64, d + 1, day_secs / 3600, (day_secs % 3600) / 60, day_secs % 60)
        };
        let archive_path = format!(
            "{}/ShooterGame/Saved/Logs/ShooterGame_{year:04}-{month:02}-{day:02}_{hh:02}-{mm:02}-{ss:02}.log",
            params.install_path
        );
        // Rename preferred; fall back to delete so we always start with a clean slate.
        if tokio::fs::rename(&current_log_path, &archive_path).await.is_ok() {
            true
        } else {
            tokio::fs::remove_file(&current_log_path).await.is_ok()
        }
    } else {
        // No pre-existing log — fresh install or first ever start.
        true
    };

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
            emit_status(&handle_clone, &ServerStatus {
                server_id: sid, status: "stopped".into(),
                pid: None, uptime_seconds: None, error: None,
            });
            return;
        }

        // ── Runtime crash (was confirmed running) ────────────────────────────
        if confirmed_clone.load(Ordering::Relaxed) {
            app_state.running_servers.lock().unwrap().remove(&sid);
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
        // failure, scan /proc for up to 30 s to see if the game process appears.
        // If it does, update the tracked PID and let the log-watcher task handle
        // the "running" transition.
        #[cfg(target_os = "linux")]
        {
            for i in 0..30u32 {
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
                if i < 29 {
                    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                }
            }
        }

        // ── Genuine start failure ─────────────────────────────────────────────
        app_state.running_servers.lock().unwrap().remove(&sid);
        let cleaned = strip_ansi(raw_stderr.trim());
        let trimmed = if cleaned.len() > 800 {
            format!("\u{2026}{}", &cleaned[cleaned.len() - 800..])
        } else {
            cleaned
        };
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
    let sid2        = params.server_id.clone();
    let handle2     = app_handle.clone();
    let query_port2 = params.query_port;
    let log_path2   = format!(
        "{}/ShooterGame/Saved/Logs/ShooterGame.log",
        params.install_path
    );

    let confirmed2 = Arc::clone(&confirmed_running);
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
            true
        };

        // ── Wait for the fresh log file to appear ────────────────────────────
        // We rotated any pre-existing ShooterGame.log before spawning, so the
        // first file to appear at this path belongs to the current session.
        // Read from byte 0 — no need for inode detection or seek-to-end.
        // If rotation failed (permissions, locked file), did_rotate is false
        // and we seek to end to skip stale content from the previous session.
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

        let mut file = file;
        if !did_rotate {
            // Rotation failed — old file is still in place. Seek past stale
            // content so we don't false-positive on a READY_MSG from a prior run.
            let _ = file.seek(SeekFrom::End(0)).await;
        }
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
                        return;
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
            return;
        }

        // 2. Try Source Query on localhost (3 attempts, 5 s apart).
        for _ in 0..3u8 {
            if try_source_query_local(query_port2).await {
                confirmed2.store(true, Ordering::Relaxed);
                confirm_running(&handle2, &sid2);
                return;
            }
            sleep(Duration::from_secs(5)).await;
        }

        // 3. Last resort — promote regardless.
        confirmed2.store(true, Ordering::Relaxed);
        confirm_running(&handle2, &sid2);
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
    let running_info = {
        let state = app_handle.state::<AppState>();
        let registry = state.running_servers.lock().unwrap();
        registry.get(&params.server_id).map(|rs| (rs.pid, rs.install_path.clone()))
    };

    if let Some((pid, install_path)) = running_info {
        {
            let state = app_handle.state::<AppState>();
            state.stopping_servers.lock().unwrap().insert(params.server_id.clone());
        }

        kill_process_tree(pid, graceful, &install_path);

        // Wait up to 15 s for the process to exit.
        for _ in 0..30 {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            if !pid_alive(pid) {
                break;
            }
        }

        // Ensure it's gone regardless.
        if pid_alive(pid) {
            kill_process_tree(pid, false, &install_path);
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
    install_path: String,
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
                install_path,
                // A re-registered server was already running before the app restarted.
                confirmed_running: true,
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
        kill_process_tree(pid, false, &install_path);
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
