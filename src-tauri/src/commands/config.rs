use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Serialized representation of a server's full configuration.
/// `game_user_settings` maps to GameUserSettings.ini keys/values.
/// `game_ini` maps to Game.ini keys/values.
/// `launch_args` is a key→value map of ASA launch parameters.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfigJson {
    pub game_user_settings: Value,
    pub game_ini: Value,
    pub launch_args: Value,
}

/// Read GameUserSettings.ini and Game.ini from disk for a given server,
/// parse them, and return the structured JSON representation.
#[tauri::command]
pub async fn read_server_config(_server_id: String) -> Result<ServerConfigJson, String> {
    Err("Not implemented".into())
}

/// Serialize `config` back into GameUserSettings.ini and Game.ini and write them
/// to the server's config path. Does NOT restart the server automatically.
#[tauri::command]
pub async fn write_server_config(
    _server_id: String,
    _config: ServerConfigJson,
) -> Result<(), String> {
    Err("Not implemented".into())
}

/// Parse existing GameUserSettings.ini and Game.ini files provided by the user
/// (e.g., from an existing ASA install) and return the structured JSON.
/// Used in the "Import from existing config files" preset option.
#[tauri::command]
pub async fn import_ini_files(
    _gus_path: String,
    _game_ini_path: String,
) -> Result<ServerConfigJson, String> {
    Err("Not implemented".into())
}
