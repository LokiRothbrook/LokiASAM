use crate::state::{scheduler::SchedulerState, AppState};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::time::Duration;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Emitted as the payload of `scheduler://fired` so the frontend can update
/// SQLite (last_run / next_run) and requeue the entry via sync_schedules.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerFiredPayload {
    pub schedule_id: String,
    pub server_id: String,
    pub server_name: String,
    pub schedule_type: String,
    pub success: bool,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Atomically replace all active schedule entries.
///
/// Called by the frontend whenever schedules are created, updated, toggled, or deleted,
/// and once on startup after the DB is ready. Rust fires entries purely based on
/// `next_run_ms` — cron parsing lives entirely in the frontend (cron-parser).
///
/// Preserves `u64::MAX` for any entry that is currently in-flight. The frontend
/// may push a stale (already-past) `next_run_ms` for such entries before it has
/// had a chance to update the DB with the fire's real result — overwriting
/// `u64::MAX` with that stale value would cause an immediate re-fire on the
/// next tick. Only guard against *stale* incoming values though: the resync
/// that runs right after the fire actually completes carries a genuinely
/// future `next_run_ms`, and must be allowed through — otherwise the entry
/// would stay locked at `u64::MAX` forever (every later resync would see the
/// still-MAX stored value and re-lock its own fresh value too), so a schedule
/// would only ever fire once per app session.
#[tauri::command]
pub async fn sync_schedules(
    entries: Vec<crate::state::scheduler::ScheduleEntry>,
    state: tauri::State<'_, SchedulerState>,
) -> Result<(), String> {
    let now = now_ms();
    let mut store = state.entries.lock().unwrap();
    let mut updated = entries;
    for entry in updated.iter_mut() {
        if let Some(existing) = store.iter().find(|e| e.schedule_id == entry.schedule_id) {
            if existing.next_run_ms == u64::MAX && entry.next_run_ms <= now {
                // Entry is in-flight and this push still looks stale — keep the guard.
                entry.next_run_ms = u64::MAX;
            }
        }
    }
    *store = updated;
    Ok(())
}

// ---------------------------------------------------------------------------
// Internal fire helpers — called by the background scheduler task in lib.rs
// ---------------------------------------------------------------------------

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Open a one-shot RCON connection, send one command, then drop the connection.
/// Silently swallows all errors — broadcast failures must never block a schedule.
async fn transient_rcon_send(port: u16, password: &str, command: &str) {
    use crate::state::rcon_pool::{RconConn, RCON_AUTH, RCON_AUTH_RESPONSE, RCON_EXECCOMMAND};
    use tokio::net::TcpStream;
    use tokio::time::timeout;

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let stream = match timeout(Duration::from_secs(5), TcpStream::connect(addr)).await {
        Ok(Ok(s)) => s,
        _ => return,
    };
    let _ = stream.set_nodelay(true);
    let mut conn = RconConn { stream, next_id: 1 };

    if conn.send_packet(1, RCON_AUTH, password).await.is_err() {
        return;
    }
    // Wait for auth response (up to 3 packets).
    for _ in 0..3 {
        match timeout(Duration::from_secs(5), conn.recv_packet()).await {
            Ok(Ok((_, t, _))) if t == RCON_AUTH_RESPONSE => break,
            Ok(Err(_)) | Err(_) => return,
            _ => {}
        }
    }

    let _ = timeout(
        Duration::from_secs(5),
        conn.send_packet(2, RCON_EXECCOMMAND, command),
    )
    .await;
    // Don't wait for a response — fire-and-forget.
}

async fn fire_broadcast(app: &AppHandle, entry: &crate::state::scheduler::ScheduleEntry) -> Result<(), String> {
    let cfg: serde_json::Value =
        serde_json::from_str(&entry.config_json).unwrap_or_default();
    let message = cfg["message"]
        .as_str()
        .unwrap_or("Server broadcast.")
        .to_string();
    transient_rcon_send(entry.rcon_port, &entry.rcon_password, &format!("ServerChat {message}")).await;
    let _ = app; // no app events needed for chat
    Ok(())
}

async fn fire_wipe_dinos(app: &AppHandle, entry: &crate::state::scheduler::ScheduleEntry) -> Result<(), String> {
    let _ = app;
    transient_rcon_send(entry.rcon_port, &entry.rcon_password, "ServerChat Wild dinos are being wiped — expect brief lag.").await;
    transient_rcon_send(entry.rcon_port, &entry.rcon_password, "destroywilddinos").await;
    Ok(())
}

async fn fire_restart(app: &AppHandle, entry: &crate::state::scheduler::ScheduleEntry) -> Result<(), String> {
    if !super::server::is_server_running(app, &entry.server_id) {
        return Ok(());
    }
    // Mid-boot (spawned but not yet RCON-confirmed) — see fire_update for why
    // this skips the countdown/graceful handshake entirely.
    let is_confirmed_running = {
        let state = app.state::<AppState>();
        let registry = state.running_servers.lock().unwrap();
        registry.get(&entry.server_id).map(|rs| rs.confirmed_running).unwrap_or(false)
    };

    // Refuse to restart a server whose hourly backup is currently in
    // progress — killing the process mid-backup can produce a silently
    // incomplete archive. The restart will fire again at its next scheduled
    // occurrence.
    let state = app.state::<AppState>();
    let _lock = state.try_lock_server(&entry.server_id)
        .ok_or_else(|| format!("A backup is currently in progress for {} — restart will retry next time", entry.server_id))?;

    if is_confirmed_running {
        let cfg: serde_json::Value = serde_json::from_str(&entry.config_json).unwrap_or_default();
        let warn_minutes  = if cfg["broadcastWarning"].as_bool().unwrap_or(false) { cfg["warningMinutes"].as_u64().unwrap_or(0) } else { 0 };
        let message       = cfg["message"].as_str().unwrap_or("Server restarting in {time}.").to_string();
        let cancel_msg    = cfg["cancelMessage"].as_str().unwrap_or("").to_string();

        let (tx, mut rx) = tokio::sync::mpsc::channel::<crate::state::CountdownSignal>(1);
        {
            let state = app.state::<AppState>();
            let mut cd = state.countdowns.lock().unwrap();
            // Refuse to start a second countdown for this server — otherwise a
            // restart and an update schedule (or two restarts) becoming due in
            // the same tick would silently overwrite each other's countdown
            // handle and both run their own stop/start sequence concurrently.
            if cd.contains_key(&entry.server_id) {
                return Err(format!("A countdown is already in progress for {}", entry.server_id));
            }
            cd.insert(entry.server_id.clone(), tx);
        }

        let result = super::countdown::run_countdown(
            app,
            &entry.server_id,
            warn_minutes * 60,
            entry.rcon_port,
            &entry.rcon_password,
            &message,
            &cancel_msg,
            "restart",
            &mut rx,
        ).await;

        {
            let state = app.state::<AppState>();
            state.countdowns.lock().unwrap().remove(&entry.server_id);
        }

        if matches!(result, super::countdown::CountdownResult::Cancel) {
            return Ok(());
        }

        super::server::graceful_shutdown_via_rcon(app, &entry.server_id, entry.rcon_port, &entry.rcon_password).await;
    } else {
        // Nothing loaded to save, no players connected yet — go straight to a
        // synchronous hard kill rather than waiting out an RCON handshake
        // that isn't up yet.
        let _ = super::server::inner_stop_server(app, &entry.server_id, false);
    }

    // Hand off to the frontend's staggered startup queue instead of starting
    // directly, so a batch of same-time restart schedules doesn't cold-boot
    // several servers at once — the "server://any-change" listener re-enqueues
    // on this status.
    use crate::commands::server::{emit_status, ServerStatus};
    emit_status(app, &ServerStatus {
        server_id: entry.server_id.clone(),
        status: "startup_queued".into(),
        pid: None,
        uptime_seconds: None,
        error: None,
    });
    Ok(())
}

/// Run a global cache update check: update the shared SteamCMD cache, compare
/// old vs new build IDs, and emit `asa://update-check` so the frontend can
/// mark outdated servers and prompt the user.
///
/// Shares `update_cache_inner`'s mutual-exclusion guard with the manual
/// "Check for Updates" flow (both key on `ASA_CACHE_CHECK_KEY`) so a
/// background tick can never run a second concurrent SteamCMD process
/// against the same cache dir if the user triggers a manual check at the
/// same moment — it just skips this tick silently and retries next time.
async fn fire_global_update_check(
    app: &AppHandle,
    entry: &crate::state::scheduler::ScheduleEntry,
) -> Result<(), String> {
    let sep = if entry.base_dir.contains('\\') { '\\' } else { '/' };
    let cache_dir = format!("{}{sep}lokiasam{sep}cache{sep}asa-server", entry.base_dir);

    let old_build = crate::commands::steamcmd::get_cache_build_id(&cache_dir)
        .unwrap_or_else(|| "0".to_string());

    let state = app.state::<AppState>();
    let _ = app.emit(crate::events::ASA_UPDATE_CHECK_RUNNING, serde_json::json!({ "running": true }));
    let result = crate::commands::steamcmd::update_cache_inner(
        crate::commands::steamcmd::ASA_CACHE_CHECK_KEY,
        &cache_dir,
        &entry.steamcmd_path,
        &state,
        app,
    )
    .await;
    let _ = app.emit(crate::events::ASA_UPDATE_CHECK_RUNNING, serde_json::json!({ "running": false }));

    let new_build = match result {
        Ok(b) => b,
        Err(e) if e.contains("already in progress") => {
            // A manual check is running right now — skip this tick silently,
            // the next scheduled tick will retry.
            return Ok(());
        }
        Err(e) => return Err(e),
    };

    let _ = app.emit(
        crate::events::ASA_UPDATE_CHECK,
        serde_json::json!({
            "updateAvailable": new_build != old_build,
            "cachedBuildId":   old_build,
            "latestBuildId":   new_build,
        }),
    );

    Ok(())
}

async fn fire_update(app: &AppHandle, entry: &crate::state::scheduler::ScheduleEntry) -> Result<(), String> {
    let cfg: serde_json::Value = serde_json::from_str(&entry.config_json).unwrap_or_default();

    let sep = if entry.base_dir.contains('\\') { '\\' } else { '/' };
    let cache_dir = format!("{}{sep}lokiasam{sep}cache{sep}asa-server", entry.base_dir);

    let is_running    = super::server::is_server_running(app, &entry.server_id);
    // Distinguish "fully up and joinable" from "spawned but still mid-boot" —
    // the confirmed_running flag on the running_servers entry tells them apart.
    let is_confirmed_running = {
        let state = app.state::<AppState>();
        let registry = state.running_servers.lock().unwrap();
        registry.get(&entry.server_id).map(|rs| rs.confirmed_running).unwrap_or(false)
    };
    // A server that hadn't even been spawned yet, but was sitting in the
    // startup queue, isn't caught by is_running at all — read the live DB
    // status directly to catch that case too.
    let was_queued_for_startup = app.state::<AppState>().get_db_path()
        .and_then(|p| crate::db::open(&p).ok())
        .and_then(|conn| crate::db::get_server_status(&conn, &entry.server_id))
        .as_deref() == Some("startup_queued");
    // Either of these means the server was on its way up (mid-boot or merely
    // queued for its turn) when this update interrupted it — see the restart
    // branch below for why that always finishes the launch regardless of
    // only_if_running, and does so via the startup queue rather than directly.
    let interrupted_startup = (is_running && !is_confirmed_running) || was_queued_for_startup;
    let warn_minutes  = if cfg["broadcastWarning"].as_bool().unwrap_or(false) { cfg["warningMinutes"].as_u64().unwrap_or(0) } else { 0 };
    let skip_if_players = cfg["skipIfPlayersOnline"].as_bool().unwrap_or(false);
    let restart_after   = cfg["restartAfterUpdate"].as_bool().unwrap_or(true);
    // When false, restart_after applies even if the server was stopped before
    // the update (used by per-server Auto-Update automation's "Only restart if
    // server was already running" toggle — unchecked means "always end up
    // running after an update").
    let only_if_running = cfg["onlyIfRunning"].as_bool().unwrap_or(true);
    let message         = cfg["message"].as_str().unwrap_or("Server going down for update in {time}.").to_string();
    let cancel_msg      = cfg["cancelMessage"].as_str().unwrap_or("").to_string();

    // Skip entirely if players are online and the schedule says to.
    if is_running && skip_if_players {
        let resp = super::rcon::transient_rcon_command(entry.rcon_port, &entry.rcon_password, "listplayers")
            .await
            .unwrap_or_default();
        let has_players = !resp.trim().is_empty() && !resp.to_lowercase().contains("no players");
        if has_players {
            return Ok(());
        }
    }

    // Refuse to update a server whose hourly backup is currently reading its
    // files — overwriting them mid-backup can produce a silently incomplete
    // archive. The per-server auto-update entry is regenerated on the next
    // schedule sync as long as update_available stays set, so this retries
    // shortly rather than being lost.
    let state = app.state::<AppState>();
    let _lock = state.try_lock_server(&entry.server_id)
        .ok_or_else(|| format!("A backup is currently in progress for {} — update will retry shortly", entry.server_id))?;

    if is_running && !is_confirmed_running {
        // Mid-boot: the process is spawned but RCON isn't up yet, so there's no
        // world state to save and no players to warn — the countdown and the
        // RCON SaveWorld/doexit handshake would just run out the clock (up to
        // the full warn duration, then up to 30s of polling in
        // graceful_shutdown_via_rcon) before falling back to a hard kill
        // anyway. Skip straight to it. SIGKILL (not SIGTERM) specifically,
        // since it's synchronous — sync_cache_to_server below must never race
        // a process that might still be exiting.
        let _ = super::server::inner_stop_server(app, &entry.server_id, false);
    } else if is_confirmed_running {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<crate::state::CountdownSignal>(1);
        {
            let state = app.state::<AppState>();
            let mut cd = state.countdowns.lock().unwrap();
            // See fire_restart — refuse to clobber a countdown already in
            // progress for this server (e.g. a restart schedule racing this
            // update schedule in the same tick).
            if cd.contains_key(&entry.server_id) {
                return Err(format!("A countdown is already in progress for {}", entry.server_id));
            }
            cd.insert(entry.server_id.clone(), tx);
        }

        let result = super::countdown::run_countdown(
            app,
            &entry.server_id,
            warn_minutes * 60,
            entry.rcon_port,
            &entry.rcon_password,
            &message,
            &cancel_msg,
            "update",
            &mut rx,
        ).await;

        {
            let state = app.state::<AppState>();
            state.countdowns.lock().unwrap().remove(&entry.server_id);
        }

        if matches!(result, super::countdown::CountdownResult::Cancel) {
            return Ok(());
        }

        super::server::graceful_shutdown_via_rcon(app, &entry.server_id, entry.rcon_port, &entry.rcon_password).await;
    }

    // Emit "updating" so the server card shows the spinner.
    use crate::commands::server::{emit_status, ServerStatus};
    emit_status(app, &ServerStatus {
        server_id: entry.server_id.clone(),
        status: "updating".into(),
        pid: None,
        uptime_seconds: None,
        error: None,
    });

    // Update shared cache via SteamCMD.
    let channel = format!("steamcmd://output/{}", entry.server_id);
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| format!("Failed to create cache dir: {e}"))?;

    crate::commands::steamcmd::steamcmd_app_update(
        app, &entry.steamcmd_path, &cache_dir, false, &channel, None,
    ).await?;

    // Sync updated files to the server directory (preserving Saved/).
    let cache_path  = std::path::PathBuf::from(&cache_dir);
    let server_path = std::path::PathBuf::from(&entry.install_path);
    let app_clone = app.clone();
    let channel_clone = channel.clone();
    tokio::task::spawn_blocking(move || {
        // Scheduled updates aren't individually cancellable — a never-set flag is correct here.
        let no_abort = std::sync::atomic::AtomicBool::new(false);
        crate::commands::steamcmd::sync_cache_to_server(&cache_path, &server_path, &app_clone, &channel_clone, &no_abort)
    })
    .await
    .map_err(|e| format!("Sync task panicked: {e}"))?
    .map_err(|e| format!("Failed to sync server files: {e}"))?;

    // Record updated build ID and trigger internet version fetch
    let acf = std::path::Path::new(&entry.install_path)
        .join(crate::commands::steamcmd::ACF_REL_PATH);
    if let Some(build_id) = crate::commands::steamcmd::read_acf_build_id(&acf) {
        crate::commands::build_version::record_install(app, &entry.server_id, &build_id);
    }

    let _ = app.emit(crate::events::ASA_UPDATE_CHECK, serde_json::json!({
        "updateApplied": true,
        "serverId": entry.server_id,
    }));

    // Clear the per-server update flag — otherwise the UI keeps showing
    // "Update Available" and, for "immediately" mode, the next scheduler
    // sync would generate this same auto-update entry all over again.
    if let Some(db_path) = app.state::<AppState>().get_db_path() {
        if let Ok(conn) = crate::db::open(&db_path) {
            crate::db::clear_update_available(&conn, &entry.server_id);
        }
    }

    // Restart if requested — either the server was already fully running, the
    // schedule says to bring it up regardless (only_if_running = false), or it
    // was on its way up (mid-boot or queued) when this update interrupted it.
    // The last case always finishes the launch regardless of only_if_running —
    // that toggle is about whether a server that was merely *stopped* should
    // come back up, not about abandoning a launch already in motion.
    //
    // Always hands off to the frontend's staggered startup queue rather than
    // starting directly — several servers restarting after the same update
    // check shouldn't all cold-boot at once. The "server://any-change"
    // listener re-enqueues on this status.
    if restart_after && (is_confirmed_running || !only_if_running || interrupted_startup) {
        use crate::commands::server::{emit_status, ServerStatus};
        emit_status(app, &ServerStatus {
            server_id: entry.server_id.clone(),
            status: "startup_queued".into(),
            pid: None,
            uptime_seconds: None,
            error: None,
        });
    }

    Ok(())
}

/// Called by the background scheduler loop in lib.rs.
/// Checks for due entries, fires them in separate spawned tasks, and marks them
/// as fired (next_run_ms = u64::MAX) to prevent double-fire until the frontend resyncs.
pub fn tick_scheduler(app: &AppHandle) {
    let now = now_ms();

    let scheduler = app.state::<SchedulerState>();
    let due: Vec<crate::state::scheduler::ScheduleEntry> = {
        let mut entries = scheduler.entries.lock().unwrap();
        let mut due = Vec::new();
        for entry in entries.iter_mut() {
            if entry.enabled && entry.next_run_ms != u64::MAX && entry.next_run_ms <= now {
                entry.next_run_ms = u64::MAX; // prevent double-fire
                due.push(entry.clone());
            }
        }
        due
    };

    for entry in due {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let schedule_type = entry.schedule_type.clone();
            let schedule_id = entry.schedule_id.clone();
            let server_id = entry.server_id.clone();
            let server_name = entry.server_name.clone();

            let (success, error) = match schedule_type.as_str() {
                "broadcast" => match fire_broadcast(&app, &entry).await {
                    Ok(_) => (true, None),
                    Err(e) => (false, Some(e)),
                },
                "restart" => match fire_restart(&app, &entry).await {
                    Ok(_) => (true, None),
                    Err(e) => (false, Some(e)),
                },
                "update" => match fire_update(&app, &entry).await {
                    Ok(_) => (true, None),
                    Err(e) => (false, Some(e)),
                },
                "global_update_check" => match fire_global_update_check(&app, &entry).await {
                    Ok(_) => (true, None),
                    Err(e) => (false, Some(e)),
                },
                "wipe_dinos" => match fire_wipe_dinos(&app, &entry).await {
                    Ok(_) => (true, None),
                    Err(e) => (false, Some(e)),
                },
                _ => (false, Some(format!("Unknown schedule type: {schedule_type}"))),
            };

            let _ = app.emit(
                "scheduler://fired",
                SchedulerFiredPayload {
                    schedule_id,
                    server_id,
                    server_name,
                    schedule_type,
                    success,
                    error,
                },
            );
        });
    }
}
