mod commands;
mod db;
mod events;
mod state;

// Suppress the "libayatana-appindicator is deprecated" stderr warning that the
// library emits unconditionally when the tray icon is initialized on Linux.
// The warning is informational only (Tauri still works correctly); we silence
// it by registering a no-op GLib log handler for that specific domain before
// the tray is created.
#[cfg(target_os = "linux")]
#[link(name = "glib-2.0")]
extern "C" {
    fn g_log_set_handler(
        log_domain: *const std::ffi::c_char,
        log_levels: u32,
        log_func: unsafe extern "C" fn(
            *const std::ffi::c_char,
            u32,
            *const std::ffi::c_char,
            *mut std::ffi::c_void,
        ),
        user_data: *mut std::ffi::c_void,
    ) -> u32;
}

#[cfg(target_os = "linux")]
unsafe extern "C" fn noop_log(
    _domain: *const std::ffi::c_char,
    _level: u32,
    _message: *const std::ffi::c_char,
    _user_data: *mut std::ffi::c_void,
) {
}

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

/// Stores menu items that need to be updated dynamically at runtime.
struct TrayMenuState {
    show_item: MenuItem<tauri::Wry>,
    hide_item: MenuItem<tauri::Wry>,
}

/// Show, un-minimize, and focus the main window. Updates tray menu to reflect visible state.
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let is_min = w.is_minimized().unwrap_or(false);
        if is_min {
            // Wayland XDG Shell has no unminimize operation; maximize overrides it.
            let _ = w.maximize();
        }
        let _ = w.show();

        let w2 = w.clone();
        tauri::async_runtime::spawn(async move {
            // KDE/KWin leaves decoration buttons non-interactive after a hide→show
            // cycle. Cycling through maximize state forces KWin to re-initialize
            // button input regions. Only needed on KDE — other DEs handle remap fine.
            #[cfg(target_os = "linux")]
            let on_kde = std::env::var("XDG_CURRENT_DESKTOP")
                .map(|v| v.to_uppercase().contains("KDE"))
                .unwrap_or(false);
            #[cfg(not(target_os = "linux"))]
            let on_kde = false;

            if on_kde {
                let already_max = w2.is_maximized().unwrap_or(false);
                if already_max {
                    let _ = w2.unmaximize();
                    tokio::time::sleep(std::time::Duration::from_millis(16)).await;
                    let _ = w2.maximize();
                } else {
                    let _ = w2.maximize();
                    tokio::time::sleep(std::time::Duration::from_millis(16)).await;
                    let _ = w2.unmaximize();
                }
            }
            let _ = w2.set_focus();
        });
    }
    if let Some(tray_state) = app.try_state::<TrayMenuState>() {
        let _ = tray_state.show_item.set_text("Bring to Front");
        let _ = tray_state.hide_item.set_enabled(true);
    }
}

/// Hide the main window and update tray menu to reflect hidden state.
/// Emits "tray-first-hide" only on the very first hide so the frontend can show a
/// one-time "minimized to tray" hint.
/// Also closes any open mod browser/verify overlay so it doesn't float orphaned.
fn hide_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    if let Some(browser) = app.get_webview_window("mod-browser") {
        let _ = browser.close();
        let _ = app.emit("mod://browser-closed", ());
    }
    if let Some(verify) = app.get_webview_window("mod-verify") {
        let _ = verify.close();
        let _ = app.emit("mod://verify-complete", ());
    }
    if let Some(tray_state) = app.try_state::<TrayMenuState>() {
        let _ = tray_state.show_item.set_text("Show LokiASAM");
        let _ = tray_state.hide_item.set_enabled(false);
    }
    // Only fire the hint event the first time the window is hidden.
    if let Some(app_state) = app.try_state::<state::AppState>() {
        let was_shown = app_state
            .tray_hint_shown
            .swap(true, std::sync::atomic::Ordering::Relaxed);
        if !was_shown {
            let _ = app.emit("tray-first-hide", ());
        }
    }
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    unsafe {
        // G_LOG_LEVEL_WARNING = 1 << 4
        g_log_set_handler(
            b"libayatana-appindicator\0".as_ptr() as *const std::ffi::c_char,
            1u32 << 4,
            noop_log,
            std::ptr::null_mut(),
        );
    }

    tauri::Builder::default()
        // ── Single-instance guard ──────────────────────────────────────────
        // If a second instance is launched, focus the existing window and exit.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            app.manage(state::AppState::new());
            app.manage(state::rcon_pool::RconPool::new());
            app.manage(state::log_manager::LogManagerState::new());
            app.manage(state::scheduler::SchedulerState::new());
            app.manage(state::stats_recorder::StatsRecorderState::new());

            // ── System tray ───────────────────────────────────────────────
            // Window starts visible, so "Bring to Front" is the correct initial label.
            // "Hide" starts enabled; it becomes disabled while the window is hidden.
            let show_i = MenuItem::with_id(app, "show", "Bring to Front", true, None::<&str>)?;
            let hide_i = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit LokiASAM", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_i, &hide_i, &quit_i])?;

            // Embed the tray icon from the PNG at compile time so it always
            // reflects the current icon file, even in dev hot-reload mode.
            let tray_icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

            let tray = TrayIconBuilder::with_id("lokiasam-tray")
                .icon(tray_icon)
                .tooltip("LokiASAM")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "hide" => hide_main_window(app),
                    "quit" => {
                        // Show the window first so the frontend dialog is visible,
                        // then ask the frontend to handle quit (may have active installs).
                        show_main_window(app);
                        let _ = app.emit("tray-quit-requested", ());
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // Hidden by default — shown once the frontend confirms setup + close_to_tray=true.
            let _ = tray.set_visible(false);

            // Keep the TrayIcon alive for the duration of the app.
            app.manage(tray);
            // Keep menu item handles alive for dynamic text/enabled updates.
            app.manage(TrayMenuState { show_item: show_i, hide_item: hide_i });

            // ── Close-to-tray handler ─────────────────────────────────────
            // If setup is complete AND close_to_tray is enabled, intercept the
            // close button and hide to tray instead of exiting.
            // During setup or when close_to_tray=false, the X button exits normally.
            let handle_for_close = app.handle().clone();
            if let Some(main_window) = app.get_webview_window("main") {
                main_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        let app_state = handle_for_close.state::<state::AppState>();
                        let setup_done = app_state
                            .setup_complete
                            .load(std::sync::atomic::Ordering::Relaxed);
                        let close_to_tray = app_state
                            .close_to_tray
                            .load(std::sync::atomic::Ordering::Relaxed);
                        if setup_done && close_to_tray {
                            api.prevent_close();
                            hide_main_window(&handle_for_close);
                        }
                    }
                });
            } else {
                eprintln!("Warning: main window not found at setup — close-to-tray handler not attached.");
            }

            // ── Scheduler background task ──────────────────────────────────
            let scheduler_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval =
                    tokio::time::interval(std::time::Duration::from_secs(30));
                interval.tick().await;
                loop {
                    interval.tick().await;
                    commands::scheduler::tick_scheduler(&scheduler_handle);
                }
            });

            // ── Hourly backup tick ─────────────────────────────────────────
            // Fires at each wall-clock hour boundary (7:00, 8:00, …) so backup
            // checks are predictable and independent of when the app started.
            let backup_tick_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use std::time::{SystemTime, UNIX_EPOCH};

                // Sleep until the next :00:00 boundary.
                let now_secs = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                let secs_until_next_hour = 3600 - (now_secs % 3600);
                tokio::time::sleep(tokio::time::Duration::from_secs(secs_until_next_hour)).await;

                loop {
                    crate::commands::backup_manager::execute_tick(&backup_tick_handle).await;
                    // Re-anchor to the next wall-clock hour boundary after each
                    // tick so backup execution time does not cause cumulative drift.
                    let now_secs = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                    let secs_until_next_hour = 3600 - (now_secs % 3600);
                    tokio::time::sleep(tokio::time::Duration::from_secs(secs_until_next_hour)).await;
                }
            });

            // ── Stats recorder background task ─────────────────────────────
            // Polls all running servers every 5 s.  On every poll:
            //   - Emits "stats://live" so the frontend live buffer stays current.
            //   - Writes a raw sample to server_stats_history every 12th poll (60 s).
            //   - Opens / closes server_uptime_sessions when servers start / stop.
            // Waits until the frontend calls init_stats_recorder (which opens the
            // rusqlite connection) before doing any DB work.
            let stats_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use std::collections::{HashMap, HashSet};

                let mut poll_counters: HashMap<String, u32> = HashMap::new();
                let mut prev_active: HashSet<String> = HashSet::new();
                let mut open_sessions: HashMap<String, String> = HashMap::new();
                let mut rollup_done = false;
                let mut last_rollup = tokio::time::Instant::now();
                // Servers currently being memory-limit-restarted — skip them in the
                // memory check until the restart completes.
                let mem_restarting: std::sync::Arc<std::sync::Mutex<HashSet<String>>> =
                    std::sync::Arc::new(std::sync::Mutex::new(HashSet::new()));

                // Shared sysinfo System + per-server PID discovery cache, both
                // persisted across ticks (not rebuilt per server, not rebuilt per
                // tick) — see collect_all_server_stats' doc comment for why.
                let mut sys = sysinfo::System::new();
                let mut discovery: HashMap<String, commands::system::PidDiscoveryCache> = HashMap::new();

                let mut interval =
                    tokio::time::interval(std::time::Duration::from_secs(5));
                interval.set_missed_tick_behavior(
                    tokio::time::MissedTickBehavior::Skip,
                );
                interval.tick().await; // consume the immediate first tick

                loop {
                    interval.tick().await;

                    let now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as i64;

                    let recorder = stats_handle
                        .state::<state::stats_recorder::StatsRecorderState>();

                    if !recorder.is_ready() {
                        continue;
                    }

                    // Initial rollup on first ready tick; then every 24 h.
                    if !rollup_done {
                        rollup_done = true;
                        last_rollup = tokio::time::Instant::now();
                        recorder.run_rollup(now_ms);
                    } else if last_rollup.elapsed()
                        >= std::time::Duration::from_secs(24 * 60 * 60)
                    {
                        last_rollup = tokio::time::Instant::now();
                        recorder.run_rollup(now_ms);
                    }

                    // Snapshot running servers.
                    let app_state = stats_handle.state::<state::AppState>();
                    let servers: Vec<(String, u32, String)> = {
                        let lock = app_state.running_servers.lock().unwrap();
                        lock.iter()
                            .map(|(id, rs)| {
                                (id.clone(), rs.pid, rs.install_path.clone())
                            })
                            .collect()
                    };
                    let active_now: HashSet<String> =
                        servers.iter().map(|(id, _, _)| id.clone()).collect();

                    // Open uptime sessions for newly-started servers.
                    for id in active_now.difference(&prev_active) {
                        let session_id = uuid::Uuid::new_v4().to_string();
                        open_sessions.insert(id.clone(), session_id.clone());
                        recorder.open_uptime_session(id, &session_id, now_ms);
                    }
                    // Close uptime sessions for servers that stopped.
                    for id in prev_active.difference(&active_now) {
                        if let Some(sid) = open_sessions.remove(id) {
                            recorder.close_uptime_session(&sid, now_ms);
                        }
                        poll_counters.remove(id);
                        discovery.remove(id);
                    }
                    prev_active = active_now;

                    // One shared refresh + one blocking pass covers every running
                    // server, instead of each server independently refreshing the
                    // whole system and re-scanning /proc on its own worker thread.
                    let servers_for_blocking = servers.clone();
                    let (sys_back, discovery_back, stats_map) = tokio::task::spawn_blocking(move || {
                        let stats_map = commands::system::collect_all_server_stats(&mut sys, &mut discovery, &servers_for_blocking);
                        (sys, discovery, stats_map)
                    }).await.unwrap_or_else(|_| (sysinfo::System::new(), HashMap::new(), HashMap::new()));
                    sys = sys_back;
                    discovery = discovery_back;

                    let rcon_pool =
                        stats_handle.state::<state::rcon_pool::RconPool>();

                    for (server_id, _pid, _install_path) in &servers {
                        let server_id = server_id.clone();
                        let ps = stats_map.get(&server_id).cloned();
                        let players: Option<i32> = rcon_pool
                            .player_cache
                            .lock()
                            .await
                            .get(&server_id)
                            .map(|v| v.len() as i32);

                        let cpu = ps.as_ref().map(|s| s.cpu_percent);
                        let mem = ps.as_ref().map(|s| s.memory_mb);

                        let _ = stats_handle.emit(
                            "stats://live",
                            serde_json::json!({
                                "serverId": server_id,
                                "ts":       now_ms,
                                "cpu":      cpu,
                                "mem":      mem,
                                "players":  players,
                            }),
                        );

                        // Write raw sample every 12th poll (~60 s).
                        let count =
                            poll_counters.entry(server_id.clone()).or_insert(0);
                        *count += 1;
                        if *count % 12 == 0 {
                            recorder.insert_stat_sample(
                                &server_id,
                                now_ms,
                                cpu,
                                mem,
                                players,
                            );
                        }

                        // ── Memory-limit restart ───────────────────────────────
                        // Check memory_limit_gb from the DB and restart the server
                        // gracefully if RAM usage exceeds the configured threshold.
                        if mem_restarting.lock().unwrap().contains(&server_id) {
                            continue;
                        }
                        if let Some(mem_mb) = mem {
                            let app_state = stats_handle.state::<state::AppState>();
                            let db_path = app_state.get_db_path();
                            let start_params = app_state
                                .running_servers.lock().unwrap()
                                .get(&server_id).map(|rs| rs.start_params.clone());

                            if let (Some(db_path), Some(params)) = (db_path, start_params) {
                                let limit_mb: Option<f64> = crate::db::open(&db_path).ok()
                                    .and_then(|conn| crate::db::get_server(&conn, &server_id))
                                    .and_then(|s| s.memory_limit_gb)
                                    .map(|gb| gb * 1024.0);

                                if let Some(limit_mb) = limit_mb {
                                    if (mem_mb as f64) > limit_mb {
                                        eprintln!(
                                            "[mem-limit] {} using {mem_mb} MB > {limit_mb:.0} MB limit — restarting",
                                            server_id
                                        );
                                        mem_restarting.lock().unwrap().insert(server_id.clone());
                                        let handle = stats_handle.clone();
                                        let sid = server_id.clone();
                                        let restarting = mem_restarting.clone();
                                        tauri::async_runtime::spawn(async move {
                                            let _ = crate::commands::server::inner_restart_server(
                                                handle.clone(), params, true,
                                            ).await;
                                            restarting.lock().unwrap().remove(&sid);
                                        });
                                        let _ = stats_handle.emit(
                                            "server://memory-restart",
                                            serde_json::json!({ "serverId": server_id }),
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            });

            // RCON chat and player polling are now handled inside per-server
            // manager tasks spawned by rcon_connect.  No background tasks needed here.

            Ok(())
        })
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            // Server lifecycle
            commands::server::start_server,
            commands::server::stop_server,
            commands::server::restart_server,
            commands::server::graceful_stop_server,
            // Graceful countdown (restart / update with player warning)
            commands::countdown::start_graceful_restart,
            commands::countdown::start_graceful_update,
            commands::countdown::cancel_countdown,
            commands::countdown::proceed_now,
            commands::server::get_server_status,
            commands::server::scan_running_servers,
            commands::server::clone_server,
            commands::server::delete_server,
            commands::server::get_server_disk_usage,
            commands::server::get_dir_size,
            commands::server::force_server_start_failed,
            // Certificates
            commands::certs::download_amazon_root_ca,
            commands::certs::install_amazon_root_ca,
            commands::certs::check_amazon_root_ca_installed,
            // Firewall management
            commands::firewall::check_firewall_ports,
            commands::firewall::add_firewall_rules,
            commands::firewall::remove_firewall_rules,
            commands::firewall::get_all_firewall_ports,
            // SteamCMD / installation
            commands::steamcmd::install_steamcmd,
            commands::steamcmd::validate_steamcmd,
            commands::steamcmd::install_server,
            commands::steamcmd::update_server,
            commands::steamcmd::validate_server_files,
            commands::steamcmd::check_asa_update,
            commands::steamcmd::get_installed_build_id,
            commands::steamcmd::update_cache,
            commands::steamcmd::apply_cache_to_server,
            commands::steamcmd::detect_server_install,
            // Build version cache
            commands::build_version::fetch_build_version,
            // RCON
            commands::rcon::rcon_connect,
            commands::rcon::rcon_send,
            commands::rcon::rcon_disconnect,
            commands::rcon::rcon_is_connected,
            commands::rcon::rcon_get_players,
            commands::rcon::rcon_get_cached_players,
            commands::rcon::rcon_get_log,
            commands::rcon::rcon_clear_log,
            commands::rcon::rcon_read_ban_list,
            commands::rcon::rcon_read_whitelist,
            // Log watcher + archive + crash + chat
            commands::logs::watch_server_log,
            commands::logs::stop_log_watch,
            commands::logs::list_archived_logs,
            commands::logs::read_archived_log,
            commands::logs::delete_archived_log,
            commands::logs::list_crashes,
            commands::logs::read_crash_report,
            commands::logs::delete_crash_report,
            commands::logs::list_other_logs,
            commands::logs::read_other_log,
            commands::logs::list_chat_logs,
            commands::logs::read_chat_log,
            commands::logs::cleanup_logs,
            commands::logs::get_log_storage_root,
            // Config / INI
            commands::config::read_server_config,
            commands::config::write_server_config,
            commands::config::import_ini_files,
            // Backups
            commands::backup::create_server_backup,
            commands::backup::create_player_backup,
            commands::backup::backup_all_players,
            commands::backup::create_ini_backup,
            commands::backup::create_save_link,
            commands::backup::create_mods_saves_link,
            commands::backup::wipe_server_saves,
            commands::backup::import_server_saves,
            commands::backup::create_full_backup,
            commands::backup::list_ini_backups,
            commands::backup::restore_server_backup,
            commands::backup::restore_player_backup,
            commands::backup::restore_ini_backup,
            commands::backup::restore_full_backup,
            commands::backup::delete_backup,
            commands::backup::cleanup_ark_own_backups,
            commands::backup::estimate_dir_size,
            commands::backup::rename_backup_file,
            commands::backup::backup_file_exists,
            commands::backup::scan_backup_dir,
            // Mods (Phase 5)
            commands::mods::install_mods,
            commands::mods::open_mod_browser,
            commands::mods::close_mod_browser,
            commands::mods::start_mod_verification,
            commands::mods::close_mod_verify,
            // Stats recorder
            commands::stats::init_stats_recorder,
            // System stats
            commands::system::check_appimage_integration,
            commands::system::install_appimage_integration,
            commands::system::uninstall_appimage_integration,
            commands::system::get_install_method,
            commands::system::get_running_ops,
            commands::system::check_dir,
            commands::system::check_file_exists,
            commands::system::wipe_lokiasam_dir,
            commands::system::delete_directory,
            commands::system::move_base_dir,
            commands::system::abort_operation,
            commands::system::get_process_stats,
            commands::system::get_platform,
            commands::system::set_setup_complete,
            commands::system::set_close_to_tray,
            commands::system::query_server,
            commands::system::check_port_available,
            commands::system::force_quit,
            commands::system::read_bootstrap,
            commands::system::write_bootstrap,
            commands::system::open_folder,
            commands::system::remap_import_paths,
            // Proton-GE (Linux)
            commands::proton::scan_for_proton,
            commands::proton::validate_proton_path,
            commands::proton::download_proton_ge,
            commands::proton::check_proton_ge_update,
            // Notifications (Phase 8)
            commands::notifications::send_discord_notification,
            commands::notifications::send_email_notification,
            commands::notifications::send_os_notification,
            // Clusters (Phase 7)
            commands::cluster::create_cluster,
            commands::cluster::delete_cluster,
            commands::cluster::add_server_to_cluster,
            commands::cluster::remove_server_from_cluster,
            // Scheduler
            commands::scheduler::sync_schedules,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LokiASAM");
}
