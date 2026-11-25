use crate::state::{scheduler::SchedulerState, AppState};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

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
/// Any entry whose fire task is still running (tracked in
/// `SchedulerState::in_flight`) stays parked at `u64::MAX` regardless of what
/// the frontend pushes — it only gets re-armed by the resync that follows its
/// own `scheduler://fired` event, after the task has removed itself from
/// `in_flight`.
#[tauri::command]
pub async fn sync_schedules(
    entries: Vec<crate::state::scheduler::ScheduleEntry>,
    state: tauri::State<'_, SchedulerState>,
) -> Result<(), String> {
    let in_flight = state.in_flight.lock().unwrap().clone();
    let mut store = state.entries.lock().unwrap();
    let mut updated = entries;
    for entry in updated.iter_mut() {
        if in_flight.contains(&entry.schedule_id) {
            entry.next_run_ms = u64::MAX;
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

/// Send one scheduled RCON command. Errors (server not up, wrong admin
/// password) are returned so the schedule's run is recorded as failed
/// instead of silently reporting success.
async fn scheduled_rcon(entry: &crate::state::scheduler::ScheduleEntry, command: &str) -> Result<(), String> {
    super::rcon::transient_rcon_command(entry.rcon_port, &entry.rcon_password, command)
        .await
        .map(|_| ())
}

async fn fire_broadcast(_app: &AppHandle, entry: &crate::state::scheduler::ScheduleEntry) -> Result<(), String> {
    let cfg: serde_json::Value =
        serde_json::from_str(&entry.config_json).unwrap_or_default();
    let message = cfg["message"]
        .as_str()
        .unwrap_or("Server broadcast.")
        .to_string();
    scheduled_rcon(entry, &format!("ServerChat {message}")).await
}

async fn fire_wipe_dinos(_app: &AppHandle, entry: &crate::state::scheduler::ScheduleEntry) -> Result<(), String> {
    scheduled_rcon(entry, "ServerChat Wild dinos are being wiped — expect brief lag.").await?;
    scheduled_rcon(entry, "DestroyWildDinos").await
}

/// Wait for this server's operation lock, queueing behind whatever backup /
/// restart / update / stop already holds it. Returns the guard plus whether
/// we actually had to wait (i.e. something else ran on this server first).
async fn queue_for_server(app: &AppHandle, server_id: &str) -> (crate::state::ServerLockGuard, bool) {
    let state = app.state::<AppState>();
    if let Some(guard) = state.try_lock_server(server_id) {
        return (guard, false);
    }
    (state.lock_server(server_id).await, true)
}

fn is_confirmed_running(app: &AppHandle, server_id: &str) -> bool {
    let state = app.state::<AppState>();
    let registry = state.running_servers.lock().unwrap();
    registry.get(server_id).map(|rs| rs.confirmed_running).unwrap_or(false)
}

async fn fire_restart(app: &AppHandle, entry: &crate::state::scheduler::ScheduleEntry) -> Result<(), String> {
    if !super::server::is_server_running(app, &entry.server_id) {
        return Ok(());
    }

    // Queue behind any backup / update / stop already in progress on this
    // server rather than failing — killing the process mid-backup could
    // produce a silently incomplete archive, but dropping the restart until
    // its next occurrence (as this used to) isn't what anyone wants either.
    let (_lock, waited) = queue_for_server(app, &entry.server_id).await;
    let state = app.state::<AppState>();

    // Re-evaluate now that we hold the lock — whatever we waited on may have
    // stopped or restarted the server already.
    if !super::server::is_server_running(app, &entry.server_id) {
        return Ok(());
    }
    // Mid-boot (spawned but not yet RCON-confirmed) — see fire_update for why
    // this skips the countdown/graceful handshake entirely.
    let is_confirmed_running = is_confirmed_running(app, &entry.server_id);
    if waited && !is_confirmed_running {
        // We queued behind something (typically an update) that already
        // restarted this server — it's booting fresh right now, so a second
        // restart would only throw that boot away.
        return Ok(());
    }

    if is_confirmed_running {
        let cfg: serde_json::Value = serde_json::from_str(&entry.config_json).unwrap_or_default();
        let warn_minutes  = if cfg["broadcastWarning"].as_bool().unwrap_or(false) { cfg["warningMinutes"].as_u64().unwrap_or(0) } else { 0 };
        let message       = cfg["message"].as_str().unwrap_or("Server restarting in {time}.").to_string();
        let cancel_msg    = cfg["cancelMessage"].as_str().unwrap_or("").to_string();

        let (tx, mut rx) = tokio::sync::mpsc::channel::<crate::state::CountdownSignal>(1);
        {
            let mut cd = state.countdowns.lock().unwrap();
            // A countdown not started under this server's lock (shouldn't
            // happen, but never clobber another task's cancel handle).
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

        state.countdowns.lock().unwrap().remove(&entry.server_id);

        if matches!(result, super::countdown::CountdownResult::Cancel) {
            return Ok(());
        }

        // Registered immediately before the kill (not earlier — cancelling
        // above never touches the process, so registering any sooner would
        // leak a handoff entry nothing will ever wait on or clear).
        let notify = state.register_stop_handoff(&entry.server_id);
        super::server::graceful_shutdown_via_rcon(app, &entry.server_id, entry.rcon_port, &entry.rcon_password).await;
        // Wait for the watcher's own cleanup to finish before we emit our
        // next status below, so its delayed "stopped" can't race in after.
        state.wait_for_stop_handoff(&entry.server_id, notify).await;
    } else {
        // Nothing loaded to save, no players connected yet — go straight to a
        // synchronous hard kill rather than waiting out an RCON handshake
        // that isn't up yet.
        let notify = state.register_stop_handoff(&entry.server_id);
        let _ = super::server::inner_stop_server(app, &entry.server_id, false);
        state.wait_for_stop_handoff(&entry.server_id, notify).await;
    }

    crate::commands::notifications::dispatch_notification(
        app, "scheduled_restart", Some(&entry.server_id), &entry.server_name,
        &format!("{} restarting", entry.server_name),
        "Scheduled restart — the server will be back up shortly.",
        "info",
    ).await;

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
    // A manual check is running right now — skip this tick silently (before
    // announcing anything to the UI); the next scheduled tick will retry.
    if state.abort_flags.lock().unwrap().contains_key(crate::commands::steamcmd::ASA_CACHE_CHECK_KEY) {
        return Ok(());
    }
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
    use crate::commands::server::{emit_status, ServerStatus};
    use crate::commands::steamcmd::{get_cache_build_id, read_acf_build_id, ACF_REL_PATH};

    let cfg: serde_json::Value = serde_json::from_str(&entry.config_json).unwrap_or_default();

    let sep = if entry.base_dir.contains('\\') { '\\' } else { '/' };
    let cache_dir = format!("{}{sep}lokiasam{sep}cache{sep}asa-server", entry.base_dir);

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

    // Queue behind any backup / restart / stop / manual update already
    // running on this server instead of failing — overwriting files
    // mid-backup could produce a silently incomplete archive, so we wait our
    // turn and then pick up wherever that operation left the server.
    let (_lock, _waited) = queue_for_server(app, &entry.server_id).await;
    let state = app.state::<AppState>();

    // Whatever we waited on may already have applied this exact update
    // (e.g. the user clicked Update All, or a manual update ran) — if the
    // server's installed build already matches the cache, there's nothing to
    // do, and stopping/restarting it would just kick players for no reason.
    let installed_build = read_acf_build_id(&std::path::Path::new(&entry.install_path).join(ACF_REL_PATH));
    let cache_build = get_cache_build_id(&cache_dir);
    if installed_build.is_some() && installed_build == cache_build {
        if let Some(db_path) = state.get_db_path() {
            if let Ok(conn) = crate::db::open(&db_path) {
                crate::db::clear_update_available(&conn, &entry.server_id);
            }
        }
        let _ = app.emit(crate::events::ASA_UPDATE_CHECK, serde_json::json!({
            "updateApplied": true,
            "serverId": entry.server_id,
        }));
        return Ok(());
    }

    // Evaluated only now, after the wait — the server's state may have
    // changed completely while we were queued.
    let is_running = super::server::is_server_running(app, &entry.server_id);
    // Distinguish "fully up and joinable" from "spawned but still mid-boot" —
    // the confirmed_running flag on the running_servers entry tells them apart.
    let is_confirmed_running = is_confirmed_running(app, &entry.server_id);
    // A server that hadn't even been spawned yet, but was sitting in the
    // startup queue, isn't caught by is_running at all — read the live DB
    // status directly to catch that case too.
    let was_queued_for_startup = state.get_db_path()
        .and_then(|p| crate::db::open(&p).ok())
        .and_then(|conn| crate::db::get_server_status(&conn, &entry.server_id))
        .as_deref() == Some("startup_queued");
    // Either of these means the server was on its way up (mid-boot or merely
    // queued for its turn) when this update interrupted it — see the restart
    // branch below for why that always finishes the launch regardless of
    // only_if_running, and does so via the startup queue rather than directly.
    let interrupted_startup = (is_running && !is_confirmed_running) || was_queued_for_startup;

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

    if is_running && !is_confirmed_running {
        // Mid-boot: the process is spawned but RCON isn't up yet, so there's no
        // world state to save and no players to warn — the countdown and the
        // RCON SaveWorld/doexit handshake would just run out the clock (up to
        // the full warn duration, then up to 30s of polling in
        // graceful_shutdown_via_rcon) before falling back to a hard kill
        // anyway. Skip straight to it. SIGKILL (not SIGTERM) specifically,
        // since it's synchronous — sync_cache_to_server below must never race
        // a process that might still be exiting.
        let notify = state.register_stop_handoff(&entry.server_id);
        let _ = super::server::inner_stop_server(app, &entry.server_id, false);
        // Wait for the watcher's own cleanup to finish before proceeding —
        // otherwise its delayed "stopped" can race in after our own status
        // emissions below and silently overwrite them.
        state.wait_for_stop_handoff(&entry.server_id, notify).await;
    } else if is_confirmed_running {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<crate::state::CountdownSignal>(1);
        {
            let mut cd = state.countdowns.lock().unwrap();
            // See fire_restart — never clobber another task's cancel handle.
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

        state.countdowns.lock().unwrap().remove(&entry.server_id);

        if matches!(result, super::countdown::CountdownResult::Cancel) {
            return Ok(());
        }

        // Registered immediately before the kill (not earlier — cancelling
        // above never touches the process, so registering any sooner would
        // leak a handoff entry nothing will ever wait on or clear).
        let notify = state.register_stop_handoff(&entry.server_id);
        super::server::graceful_shutdown_via_rcon(app, &entry.server_id, entry.rcon_port, &entry.rcon_password).await;
        state.wait_for_stop_handoff(&entry.server_id, notify).await;
    }

    crate::commands::notifications::dispatch_notification(
        app, "update_started", Some(&entry.server_id), &entry.server_name,
        "Auto-Update Started",
        &format!("Applying ASA server update to {}…", entry.server_name),
        "info",
    ).await;

    // Emit "updating" so the server card shows the spinner.
    emit_status(app, &ServerStatus {
        server_id: entry.server_id.clone(),
        status: "updating".into(),
        pid: None,
        uptime_seconds: None,
        error: None,
    });

    // Sync the shared cache to the server directory (preserving Saved/). The
    // cache itself is NOT re-validated/re-downloaded here — it was already
    // brought current by the global check that flagged this server as
    // outdated in the first place (same as the manual/bulk apply path, which
    // only ever calls apply_cache_to_server, never steamcmd_app_update).
    // Re-running SteamCMD per server would mean several SteamCMD processes
    // against the same shared cache directory at once, which SteamCMD does
    // not handle safely.
    let channel = format!("steamcmd://output/{}", entry.server_id);
    let sync_result: Result<(), String> = async {
        tokio::fs::create_dir_all(&cache_dir)
            .await
            .map_err(|e| format!("Failed to create cache dir: {e}"))?;

        // Read half of the cache lock — several servers may sync at once, but
        // never while an update check has SteamCMD rewriting the cache.
        let _cache_guard = state.asa_cache_lock.clone().read_owned().await;
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
        .map_err(|e| format!("Failed to sync server files: {e}"))
    }
    .await;

    if let Err(e) = sync_result {
        // Never leave the server stuck on the "updating" spinner — the
        // update_available flag stays set so it's retried / visible.
        emit_status(app, &ServerStatus {
            server_id: entry.server_id.clone(),
            status: "stopped".into(),
            pid: None,
            uptime_seconds: None,
            error: Some(e.clone()),
        });
        return Err(e);
    }

    // Record updated build ID and trigger internet version fetch
    let acf = std::path::Path::new(&entry.install_path).join(ACF_REL_PATH);
    let new_build = read_acf_build_id(&acf);
    if let Some(build_id) = &new_build {
        crate::commands::build_version::record_install(app, &entry.server_id, build_id);
    }

    // Clear the per-server update flag — otherwise the UI keeps showing
    // "Update Available" and, for "immediately" mode, the next scheduler
    // sync would generate this same auto-update entry all over again.
    if let Some(db_path) = state.get_db_path() {
        if let Ok(conn) = crate::db::open(&db_path) {
            crate::db::clear_update_available(&conn, &entry.server_id);
        }
    }

    let _ = app.emit(crate::events::ASA_UPDATE_CHECK, serde_json::json!({
        "updateApplied": true,
        "serverId": entry.server_id,
    }));

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
    let restarting = restart_after && (is_confirmed_running || !only_if_running || interrupted_startup);
    emit_status(app, &ServerStatus {
        server_id: entry.server_id.clone(),
        // No restart coming → explicitly "stopped"; nothing else would ever
        // clear the "updating" status set above for this case.
        status: if restarting { "startup_queued" } else { "stopped" }.into(),
        pid: None,
        uptime_seconds: None,
        error: None,
    });

    crate::commands::notifications::dispatch_notification(
        app, "server_updated", Some(&entry.server_id), &entry.server_name,
        "Server Auto-Updated",
        &format!(
            "{} was updated{}{}.",
            entry.server_name,
            new_build.map(|b| format!(" to build {b}")).unwrap_or_default(),
            if restarting { " and is restarting" } else { "" },
        ),
        "success",
    ).await;

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
        // Registered under the entries lock so a concurrent sync_schedules
        // can't slip in between and re-arm one of these.
        let mut in_flight = scheduler.in_flight.lock().unwrap();
        for entry in &due {
            in_flight.insert(entry.schedule_id.clone());
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

            if schedule_type == "update" && !success {
                crate::commands::notifications::dispatch_notification(
                    &app, "update_failed", Some(&server_id), &server_name,
                    "Auto-Update Failed",
                    &format!("{server_name}: {}", error.as_deref().unwrap_or("unknown error")),
                    "error",
                ).await;
            }

            // Cleared before emitting `scheduler://fired`, so the resync the
            // frontend runs in response is allowed to re-arm this entry.
            app.state::<SchedulerState>().in_flight.lock().unwrap().remove(&schedule_id);

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
