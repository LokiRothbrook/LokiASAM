mod commands;
mod events;
mod state;

use tauri::{Emitter, Manager};
use tauri_plugin_sql::{Migration, MigrationKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "initial_schema",
            sql: include_str!("../migrations/001_initial.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "clusters",
            sql: include_str!("../migrations/002_clusters.sql"),
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        // ── Single-instance guard ──────────────────────────────────────────
        // If a second instance is launched, focus the existing window and exit.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
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
        .plugin(
            tauri_plugin_sql::Builder::new()
                .add_migrations("sqlite:lokiasam.db", migrations)
                .build(),
        )
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
            // RCON (Phase 4)
            commands::rcon::rcon_connect,
            commands::rcon::rcon_send,
            commands::rcon::rcon_disconnect,
            commands::rcon::rcon_get_players,
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
            // System stats
            commands::system::check_dir,
            commands::system::check_file_exists,
            commands::system::get_process_stats,
            commands::system::query_server,
            commands::system::check_port_available,
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
