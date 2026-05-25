/// Install all enabled mods for a server via SteamCMD workshop_download_item.
/// Workshop items use the ASA CLIENT App ID (2399830), not the server App ID.
/// Downloads into the shared mod cache and hardlinks to the server's mod directory.
#[tauri::command]
pub async fn install_mods(_server_id: String) -> Result<(), String> {
    Err("Not implemented".into())
}

/// Add a mod to a server's mod list in SQLite (does not install yet).
/// The user must call `install_mods` or click "Apply Changes" to download.
#[tauri::command]
pub async fn add_mod(
    _server_id: String,
    _mod_id: String,
    _mod_name: String,
) -> Result<(), String> {
    Err("Not implemented".into())
}

/// Remove a mod from a server's mod list and update ActiveMods in GameUserSettings.ini.
#[tauri::command]
pub async fn remove_mod(_server_id: String, _mod_id: String) -> Result<(), String> {
    Err("Not implemented".into())
}

/// Update the install_order of all mods for a server in one atomic operation.
/// `ordered_mod_ids` must contain all current mod IDs in the desired order.
#[tauri::command]
pub async fn reorder_mods(
    _server_id: String,
    _ordered_mod_ids: Vec<String>,
) -> Result<(), String> {
    Err("Not implemented".into())
}
