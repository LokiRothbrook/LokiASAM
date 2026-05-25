use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupRecord {
    pub id: String,
    pub server_id: String,
    pub file_path: String,
    pub file_size_bytes: u64,
    pub map_id: String,
    pub triggered_by: String,
    pub created_at: String,
}

/// Create a ZIP backup of the server's save directory.
/// Emits `backup://progress/{id}` events with percent + current file.
/// `triggered_by` should be one of: manual | schedule | pre_update | pre_restart
#[tauri::command]
pub async fn create_backup(
    _server_id: String,
    _triggered_by: String,
) -> Result<BackupRecord, String> {
    Err("Not implemented".into())
}

/// Restore a backup: stop the server, replace save files with the backup zip,
/// then restart the server.
#[tauri::command]
pub async fn restore_backup(_server_id: String, _backup_id: String) -> Result<(), String> {
    Err("Not implemented".into())
}

/// Delete a backup zip file from disk and remove its DB record.
#[tauri::command]
pub async fn delete_backup(_backup_id: String) -> Result<(), String> {
    Err("Not implemented".into())
}

/// Delete old backups for a server according to its retention policy
/// (max count and/or max age). Returns the number of backups pruned.
#[tauri::command]
pub async fn prune_backups(_server_id: String) -> Result<u32, String> {
    Err("Not implemented".into())
}
