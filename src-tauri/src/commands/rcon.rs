use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ArkPlayer {
    pub name: String,
    pub steam_id: String,
}

/// Open a Source RCON TCP connection to a running server and authenticate.
/// Stores the connection in the global RconPool state.
#[tauri::command]
pub async fn rcon_connect(_server_id: String) -> Result<(), String> {
    Err("Not implemented".into())
}

/// Send an RCON command string and return the server's text response.
/// Emits `rcon://response/{id}` with the command + response pair.
#[tauri::command]
pub async fn rcon_send(_server_id: String, _command: String) -> Result<String, String> {
    Err("Not implemented".into())
}

/// Close the RCON connection for this server and remove it from the pool.
#[tauri::command]
pub async fn rcon_disconnect(_server_id: String) -> Result<(), String> {
    Err("Not implemented".into())
}

/// Run RCON `listplayers` and parse the response into a typed player list.
#[tauri::command]
pub async fn rcon_get_players(_server_id: String) -> Result<Vec<ArkPlayer>, String> {
    Err("Not implemented".into())
}
