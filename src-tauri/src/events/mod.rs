/// Typed Tauri event name constants.
/// Frontend subscribes to these via `listen()` / `useTauriEvent()`.

pub const SERVER_STATUS: &str = "server://status";
pub const SERVER_STATS: &str = "server://stats";
pub const SERVER_PLAYERS: &str = "server://players";
pub const STEAMCMD_OUTPUT: &str = "steamcmd://output";
pub const LOG_LINE: &str = "log://line";
pub const RCON_RESPONSE: &str = "rcon://response";
pub const NOTIFICATION_NEW: &str = "notification://new";
pub const BACKUP_PROGRESS: &str = "backup://progress";

/// Build a namespaced event name for a specific server.
/// e.g. `server_event("server://status", "abc-123")` → `"server://status/abc-123"`
pub fn server_event(base: &str, server_id: &str) -> String {
    format!("{}/{}", base, server_id)
}
