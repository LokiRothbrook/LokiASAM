use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleConfig {
    pub server_id: String,
    /// One of: backup | update | restart | broadcast
    pub schedule_type: String,
    /// Standard 5-field cron expression (e.g. "0 3 * * *" for 3 AM daily)
    pub cron_expression: String,
    /// JSON blob of type-specific options (broadcast message, warning minutes, etc.)
    pub config_json: String,
}

/// Generate and return a UUID for a new schedule.
/// All schedule persistence is handled by the frontend via SQLite (db.ts).
#[tauri::command]
pub async fn create_schedule(_config: ScheduleConfig) -> Result<String, String> {
    Ok(Uuid::new_v4().to_string())
}

/// No-op — the frontend removes the schedule record from SQLite.
#[tauri::command]
pub async fn delete_schedule(_schedule_id: String) -> Result<(), String> {
    Ok(())
}

/// No-op — the frontend updates the enabled flag in SQLite.
#[tauri::command]
pub async fn toggle_schedule(_schedule_id: String, _enabled: bool) -> Result<(), String> {
    Ok(())
}
