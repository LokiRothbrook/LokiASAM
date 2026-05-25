use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleConfig {
    pub server_id: String,
    /// One of: backup | update | restart | broadcast
    pub schedule_type: String,
    /// Standard 5-field cron expression (e.g. "0 3 * * *" for 3 AM daily)
    pub cron_expression: String,
    /// JSON blob of type-specific options (broadcast message, retention count, etc.)
    pub config_json: String,
}

/// Register a new cron job with `tokio-cron-scheduler` and persist it to SQLite.
/// Returns the new schedule UUID.
#[tauri::command]
pub async fn create_schedule(_config: ScheduleConfig) -> Result<String, String> {
    Err("Not implemented".into())
}

/// Remove a schedule from the cron scheduler and delete its SQLite record.
#[tauri::command]
pub async fn delete_schedule(_schedule_id: String) -> Result<(), String> {
    Err("Not implemented".into())
}

/// Enable or disable a schedule without deleting it.
/// Pauses/resumes the underlying cron job and updates the `enabled` flag in SQLite.
#[tauri::command]
pub async fn toggle_schedule(_schedule_id: String, _enabled: bool) -> Result<(), String> {
    Err("Not implemented".into())
}
