mod commands;
mod state;
mod events;

use tauri::Manager;
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
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Initialize shared application state
            app.manage(state::AppState::new());

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
            // Config / INI
            commands::config::read_server_config,
            commands::config::write_server_config,
            commands::config::import_ini_files,
            // Backups
            commands::backup::create_backup,
            commands::backup::restore_backup,
            commands::backup::delete_backup,
            commands::backup::prune_backups,
            // Mods
            commands::mods::install_mods,
            commands::mods::add_mod,
            commands::mods::remove_mod,
            commands::mods::reorder_mods,
            // System stats
            commands::system::check_dir,
            commands::system::get_process_stats,
            commands::system::query_server,
            commands::system::check_port_available,
            // Notifications
            commands::notifications::send_discord_notification,
            commands::notifications::send_email_notification,
            commands::notifications::send_os_notification,
            // Cluster
            commands::cluster::create_cluster,
            commands::cluster::delete_cluster,
            commands::cluster::add_server_to_cluster,
            commands::cluster::remove_server_from_cluster,
            // Scheduler
            commands::scheduler::create_schedule,
            commands::scheduler::delete_schedule,
            commands::scheduler::toggle_schedule,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LokiASAM");
}
