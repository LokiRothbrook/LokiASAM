/// Typed Tauri event name constants.
/// Frontend subscribes to these via `listen()` / `useTauriEvent()`.

/// Per-server status change: server started, stopped, crashed.
pub const SERVER_STATUS: &str = "server://status";
/// Fired on every server status change so the dashboard can invalidate its query
/// without subscribing to every individual per-server channel.
pub const SERVER_ANY_CHANGE: &str = "server://any-change";
/// SteamCMD stdout/stderr lines streamed during install / update / validate.
pub const STEAMCMD_OUTPUT: &str = "steamcmd://output";
/// ASA server log lines streamed from the ShooterGame.log file watcher.
pub const LOG_LINE: &str = "log://line";
/// New in-app notification created.
pub const NOTIFICATION_NEW: &str = "notification://new";
/// Backup progress update (Phase 6).
pub const BACKUP_PROGRESS: &str = "backup://progress";

/// Build a namespaced event name for a specific server.
/// e.g. `server_event("server://status", "abc-123")` → `"server://status/abc-123"`
pub fn server_event(base: &str, server_id: &str) -> String {
    format!("{}/{}", base, server_id)
}
