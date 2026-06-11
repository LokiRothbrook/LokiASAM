/// Typed Tauri event name constants.
/// Frontend subscribes to these via `listen()` / `useTauriEvent()`.

/// Per-server status change: server started, stopped, crashed.
pub const SERVER_STATUS: &str = "server://status";
/// Fired on every server status change so the dashboard can invalidate its query
/// without subscribing to every individual per-server channel.
pub const SERVER_ANY_CHANGE: &str = "server://any-change";
/// SteamCMD stdout/stderr lines streamed during install / update / validate.
pub const STEAMCMD_OUTPUT: &str = "steamcmd://output";
/// ASA server log lines streamed from the ShooterGame.log file watcher (new lines only).
pub const LOG_LINE: &str = "log://line";
/// Batch of existing log lines sent once when the watcher first opens a file (backfill).
pub const LOG_BACKFILL: &str = "log://backfill";
/// Backup progress update.
pub const BACKUP_PROGRESS: &str = "backup://progress";
/// ASA update check result (or update-applied notification).
pub const ASA_UPDATE_CHECK: &str = "asa://update-check";
/// Player login detected from ShooterGame.log — carries { eosId, ip }.
/// Emitted on the per-server channel `player://login/{server_id}`.
pub const PLAYER_LOGIN: &str = "player://login";
/// Same login event broadcast globally — carries { serverId, eosId, ip }.
pub const PLAYER_LOGIN_ANY: &str = "player://login-any";

/// Build a namespaced event name for a specific server.
/// e.g. `server_event("server://status", "abc-123")` → `"server://status/abc-123"`
pub fn server_event(base: &str, server_id: &str) -> String {
    format!("{}/{}", base, server_id)
}
