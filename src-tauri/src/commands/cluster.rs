/// Create a new cluster record in SQLite and create the shared cluster directory on disk.
#[tauri::command]
pub async fn create_cluster(_name: String, _cluster_dir_override: Option<String>) -> Result<String, String> {
    Err("Not implemented".into())
}

/// Delete a cluster record. Servers in the cluster have their cluster_id set to NULL.
/// The cluster directory is NOT deleted automatically.
#[tauri::command]
pub async fn delete_cluster(_cluster_id: String) -> Result<(), String> {
    Err("Not implemented".into())
}

/// Set a server's cluster_id in SQLite and update its launch args with the cluster
/// flags (ClusterID, ClusterDirOverride).
#[tauri::command]
pub async fn add_server_to_cluster(_server_id: String, _cluster_id: String) -> Result<(), String> {
    Err("Not implemented".into())
}

/// Clear a server's cluster_id and remove cluster-related launch args.
#[tauri::command]
pub async fn remove_server_from_cluster(_server_id: String) -> Result<(), String> {
    Err("Not implemented".into())
}
