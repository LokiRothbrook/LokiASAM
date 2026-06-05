mod commands;
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
            app.manage(state::log_watcher::LogWatcherState::new());
            app.manage(state::scheduler::SchedulerState::new());

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
            app.get_webview_window("main")
                .unwrap()
                .on_window_event(move |event| {
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

            // ── Crash-monitor background task ──────────────────────────────
            // Polls every 30 s for any PID in `running_servers` that has exited
            // unexpectedly. This catches servers started in a previous app session
            // that were re-registered via `register_running_server`, as well as
            // any watcher-task gaps. For servers started in the current session
            // the per-server watcher task in `start_server` provides instant
            // detection; this loop acts as a safety net.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval =
                    tokio::time::interval(std::time::Duration::from_secs(30));
                // Skip the immediate first tick so we don't race with startup
                // reconciliation on the frontend.
                interval.tick().await;

                loop {
                    interval.tick().await;

                    let app_state = handle.state::<state::AppState>();

                    // Snapshot current entries to avoid holding the lock
                    // across the sysinfo calls.
                    let entries: Vec<(String, u32)> = {
                        let registry = app_state.running_servers.lock().unwrap();
                        registry
                            .iter()
                            .map(|(id, rs)| (id.clone(), rs.pid))
                            .collect()
                    };

                    if entries.is_empty() {
                        continue;
                    }

                    use sysinfo::{Pid, ProcessesToUpdate, System};
                    let mut sys = System::new();

                    for (server_id, pid) in &entries {
                        let spid = Pid::from_u32(*pid);
                        sys.refresh_processes(ProcessesToUpdate::Some(&[spid]), false);
                        let alive = sys.process(spid).is_some();

                        if !alive {
                            let was_intentional = app_state
                                .stopping_servers
                                .lock()
                                .unwrap()
                                .remove(server_id);

                            let confirmed_running = {
                                let mut registry = app_state.running_servers.lock().unwrap();
                                let confirmed = registry
                                    .get(server_id)
                                    .map_or(false, |rs| rs.confirmed_running);
                                registry.remove(server_id);
                                confirmed
                            };

                            let status_str = if was_intentional {
                                "stopped"
                            } else if confirmed_running {
                                "crashed"
                            } else {
                                "start-failed"
                            };

                            let error_msg = if status_str == "start-failed" {
                                Some("Server process exited before completing startup. Try disabling mods — if the problem persists, reinstall the server.".to_string())
                            } else {
                                None
                            };

                            let payload = commands::server::ServerStatus {
                                server_id: server_id.clone(),
                                status: status_str.into(),
                                pid: None,
                                uptime_seconds: None,
                                error: error_msg,
                            };

                            let _ = handle.emit(
                                &events::server_event(
                                    events::SERVER_STATUS,
                                    server_id,
                                ),
                                payload.clone(),
                            );
                            let _ = handle.emit(events::SERVER_ANY_CHANGE, payload);
                        }
                    }
                }
            });

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

            // ── RCON GetChat poll background task ──────────────────────────
            // Polls GetChat every 5 s for any server that has an active subscriber
            // (RCON tab or pop-out window open). Results are logged to the buffer
            // and emitted as rcon://log/{server_id} events.
            let rcon_chat_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval =
                    tokio::time::interval(std::time::Duration::from_secs(5));
                interval.tick().await;
                loop {
                    interval.tick().await;
                    let pool = rcon_chat_handle.state::<state::rcon_pool::RconPool>();

                    let active: Vec<String> = pool
                        .chat_poll_active
                        .lock()
                        .await
                        .iter()
                        .cloned()
                        .collect();

                    for server_id in active {
                        let conn_arc = {
                            let guard = pool.connections.lock().await;
                            guard.get(&server_id).cloned()
                        };
                        if let Some(conn_arc) = conn_arc {
                            let mut conn = conn_arc.lock().await;
                            let cmd_id = conn.next_id;
                            conn.next_id += 1;
                            if conn.send_packet(cmd_id, state::rcon_pool::RCON_EXECCOMMAND, "GetChat").await.is_err() {
                                continue;
                            }
                            let mut resp = String::new();
                            let mut got_any = false;
                            loop {
                                let wait = if got_any {
                                    std::time::Duration::from_millis(200)
                                } else {
                                    std::time::Duration::from_secs(3)
                                };
                                match tokio::time::timeout(wait, conn.recv_packet()).await {
                                    Ok(Ok((id, _, body))) if id == cmd_id => {
                                        got_any = true;
                                        resp.push_str(&body);
                                    }
                                    _ => break,
                                }
                            }
                            drop(conn);
                            for line in resp.lines().map(|l| l.trim()).filter(|l| !l.is_empty()) {
                                let tl = line.to_lowercase();
                                if tl == "(no response)"
                                    || tl.contains("server received, but no response")
                                    || tl.contains("server received but no response")
                                {
                                    continue;
                                }
                                let log_line = state::rcon_pool::RconLogLine {
                                    timestamp_ms: state::rcon_pool::RconPool::now_ms(),
                                    text: line.to_string(),
                                    kind: "chat".into(),
                                };
                                pool.push_log(&server_id, log_line.clone()).await;
                                let _ = rcon_chat_handle.emit(&format!("rcon://log/{server_id}"), &log_line);
                            }
                        }
                    }
                }
            });

            // ── RCON player list refresh background task ───────────────────
            // Polls listplayers every 30 s for every server with an active RCON
            // connection, caches the result, and emits rcon://players/{server_id}.
            let rcon_pl_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval =
                    tokio::time::interval(std::time::Duration::from_secs(30));
                interval.tick().await;
                loop {
                    interval.tick().await;
                    let pool = rcon_pl_handle.state::<state::rcon_pool::RconPool>();

                    let connected: Vec<String> = pool
                        .connections
                        .lock()
                        .await
                        .keys()
                        .cloned()
                        .collect();

                    for server_id in connected {
                        let conn_arc = {
                            let guard = pool.connections.lock().await;
                            guard.get(&server_id).cloned()
                        };
                        if let Some(conn_arc) = conn_arc {
                            let mut conn = conn_arc.lock().await;
                            let cmd_id = conn.next_id;
                            conn.next_id += 1;
                            if conn.send_packet(cmd_id, state::rcon_pool::RCON_EXECCOMMAND, "listplayers").await.is_err() {
                                continue;
                            }
                            let mut resp = String::new();
                            let mut got_any = false;
                            loop {
                                let wait = if got_any {
                                    std::time::Duration::from_millis(200)
                                } else {
                                    std::time::Duration::from_secs(5)
                                };
                                match tokio::time::timeout(wait, conn.recv_packet()).await {
                                    Ok(Ok((id, _, body))) if id == cmd_id => {
                                        got_any = true;
                                        resp.push_str(&body);
                                    }
                                    _ => break,
                                }
                            }
                            drop(conn);
                            let players: Vec<state::rcon_pool::CachedPlayer> = resp
                                .lines()
                                .filter_map(|line| {
                                    let line = line.trim();
                                    if line.is_empty() || line.to_lowercase().starts_with("no players") {
                                        return None;
                                    }
                                    let after_dot = line.find(". ").map(|i| &line[i + 2..])?;
                                    if let Some(comma) = after_dot.rfind(", ") {
                                        let name = after_dot[..comma].trim().to_string();
                                        let player_id = after_dot[comma + 2..].trim().to_string();
                                        if !player_id.is_empty() {
                                            return Some(state::rcon_pool::CachedPlayer { name, player_id });
                                        }
                                    }
                                    None
                                })
                                .collect();

                            pool.player_cache.lock().await.insert(server_id.clone(), players.clone());
                            let _ = rcon_pl_handle.emit(&format!("rcon://players/{server_id}"), &players);
                        }
                    }
                }
            });

            Ok(())
        })
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            // Server lifecycle
            commands::server::start_server,
            commands::server::stop_server,
            commands::server::restart_server,
            commands::server::graceful_stop_server,
            commands::server::get_server_status,
            commands::server::register_running_server,
            commands::server::clone_server,
            commands::server::delete_server,
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
            // RCON
            commands::rcon::rcon_connect,
            commands::rcon::rcon_send,
            commands::rcon::rcon_disconnect,
            commands::rcon::rcon_is_connected,
            commands::rcon::rcon_get_players,
            commands::rcon::rcon_get_cached_players,
            commands::rcon::rcon_get_chat,
            commands::rcon::rcon_get_log,
            commands::rcon::rcon_clear_log,
            commands::rcon::rcon_enable_chat_poll,
            commands::rcon::rcon_disable_chat_poll,
            commands::rcon::rcon_read_ban_list,
            commands::rcon::rcon_read_whitelist,
            // Log watcher
            commands::logs::watch_server_log,
            commands::logs::stop_log_watch,
            // Config / INI
            commands::config::read_server_config,
            commands::config::write_server_config,
            commands::config::import_ini_files,
            // Backups (Phase 6)
            commands::backup::create_backup,
            commands::backup::restore_backup,
            commands::backup::delete_backup,
            commands::backup::prune_backups,
            // Mods (Phase 5)
            commands::mods::install_mods,
            commands::mods::open_mod_browser,
            commands::mods::close_mod_browser,
            commands::mods::start_mod_verification,
            commands::mods::close_mod_verify,
            // System stats
            commands::system::check_appimage_integration,
            commands::system::install_appimage_integration,
            commands::system::uninstall_appimage_integration,
            commands::system::check_dir,
            commands::system::check_file_exists,
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
            commands::scheduler::create_schedule,
            commands::scheduler::delete_schedule,
            commands::scheduler::toggle_schedule,
            commands::scheduler::sync_schedules,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LokiASAM");
}
