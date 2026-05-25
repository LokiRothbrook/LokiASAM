/// Download and extract SteamCMD into `target_dir`.
/// Emits `steamcmd://output/{server_id}` events line-by-line during execution.
/// ASA Dedicated Server App ID: 2430930
#[tauri::command]
pub async fn install_steamcmd(_target_dir: String) -> Result<(), String> {
    Err("Not implemented".into())
}

/// Run `steamcmd +quit` against the given path and return true if it exits cleanly.
#[tauri::command]
pub async fn validate_steamcmd(_path: String) -> Result<bool, String> {
    Err("Not implemented".into())
}

/// Install the ASA dedicated server (App ID 2430930) via SteamCMD into the server's
/// install_path. Uses the shared cache at `{base_dir}/.cache/asa-server/` and
/// hardlinks unchanged files into the server directory to avoid redundant downloads.
#[tauri::command]
pub async fn install_server(_server_id: String) -> Result<(), String> {
    Err("Not implemented".into())
}

/// Update an existing ASA server install via SteamCMD +app_update.
/// Backs up the server automatically before updating if a schedule is configured.
#[tauri::command]
pub async fn update_server(_server_id: String) -> Result<(), String> {
    Err("Not implemented".into())
}

/// Run SteamCMD +app_update with the `validate` flag to repair corrupted files.
#[tauri::command]
pub async fn validate_server_files(_server_id: String) -> Result<(), String> {
    Err("Not implemented".into())
}

/// Check whether a newer build is available for the ASA dedicated server by
/// comparing the installed build ID against Steam's current published build ID.
#[tauri::command]
pub async fn check_server_update_available(_server_id: String) -> Result<bool, String> {
    Err("Not implemented".into())
}
