mod commands;
mod events;
mod state;

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
            let _ = w.unminimize();
        }
        let _ = w.show();

        // set_focus() alone is blocked by focus-stealing prevention on X11 and
        // most Wayland compositors (Cinnamon, GNOME, KDE, etc.).
        // Workaround: briefly set always-on-top so the WM is forced to raise and
        // present the window, then immediately restore normal z-order.
        // The 50 ms pre-delay gives the WM time to finish processing unminimize/show
        // before we try to raise. The 50 ms post-delay keeps the window pinned
        // long enough for focus to land before we clear the flag.
        let w2 = w.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let _ = w2.set_always_on_top(true);
            let _ = w2.set_focus();
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let _ = w2.set_always_on_top(false);
        });
    }
    if let Some(tray_state) = app.try_state::<TrayMenuState>() {
        let _ = tray_state.show_item.set_text("Bring to Front");
        let _ = tray_state.hide_item.set_enabled(true);
    }
}

/// Hide the main window and update tray menu to reflect hidden state.
/// Emits "tray-first-hide" the first time so the frontend can show a one-time hint.
/// Also closes any open mod browser overlay so it doesn't float orphaned.
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
    let _ = app.emit("tray-first-hide", ());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {

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

            let tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .tooltip("LokiASAM")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "hide" => hide_main_window(app),
                    "quit" => app.exit(0),
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

            // Keep the TrayIcon alive for the duration of the app.
            app.manage(tray);
            // Keep menu item handles alive for dynamic text/enabled updates.
            app.manage(TrayMenuState { show_item: show_i, hide_item: hide_i });

            // ── Close-to-tray handler ─────────────────────────────────────
            // If setup is complete, intercept the close button and hide the
            // window instead of exiting. During the setup wizard the close
            // button behaves normally (process exits).
            let handle_for_close = app.handle().clone();
            app.get_webview_window("main")
                .unwrap()
                .on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        let app_state = handle_for_close.state::<state::AppState>();
                        if app_state
                            .setup_complete
                            .load(std::sync::atomic::Ordering::Relaxed)
                        {
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

                            app_state
                                .running_servers
                                .lock()
                                .unwrap()
                                .remove(server_id);

                            let status_str =
                                if was_intentional { "stopped" } else { "crashed" };

                            let payload = commands::server::ServerStatus {
                                server_id: server_id.clone(),
                                status: status_str.into(),
                                pid: None,
                                uptime_seconds: None,
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

            Ok(())
        })
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
            commands::steamcmd::check_server_update_available,
            // RCON
            commands::rcon::rcon_connect,
            commands::rcon::rcon_send,
            commands::rcon::rcon_disconnect,
            commands::rcon::rcon_get_players,
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
            commands::mods::add_mod,
            commands::mods::remove_mod,
            commands::mods::reorder_mods,
            commands::mods::open_mod_browser,
            commands::mods::close_mod_browser,
            commands::mods::start_mod_verification,
            commands::mods::close_mod_verify,
            // System stats
            commands::system::check_dir,
            commands::system::check_file_exists,
            commands::system::delete_directory,
            commands::system::get_process_stats,
            commands::system::get_platform,
            commands::system::set_setup_complete,
            commands::system::query_server,
            commands::system::check_port_available,
            commands::system::read_bootstrap,
            commands::system::write_bootstrap,
            commands::system::open_folder,
            // Proton-GE (Linux)
            commands::proton::scan_for_proton,
            commands::proton::validate_proton_path,
            commands::proton::download_proton_ge,
            // Notifications (Phase 8)
            commands::notifications::send_discord_notification,
            commands::notifications::send_email_notification,
            commands::notifications::send_os_notification,
            // Clusters (Phase 7)
            commands::cluster::create_cluster,
            commands::cluster::delete_cluster,
            commands::cluster::add_server_to_cluster,
            commands::cluster::remove_server_from_cluster,
            // Scheduler (Phase 6)
            commands::scheduler::create_schedule,
            commands::scheduler::delete_schedule,
            commands::scheduler::toggle_schedule,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LokiASAM");
}
