use uuid::Uuid;

/// Create a new cluster directory on disk and return the generated UUID.
/// The frontend is responsible for inserting the cluster record into SQLite.
///
/// If `cluster_dir_override` is provided and non-empty, that path is used as the
/// cluster directory. Otherwise the directory is created at
/// `{base_dir}/clusters/{uuid}`.
#[tauri::command]
pub async fn create_cluster(
    name: String,
    base_dir: String,
    cluster_dir_override: Option<String>,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();

    let cluster_dir = match cluster_dir_override {
        Some(ref d) if !d.trim().is_empty() => d.clone(),
        _ => format!(
            "{}/clusters/{}",
            base_dir.trim_end_matches('/').trim_end_matches('\\'),
            id
        ),
    };

    std::fs::create_dir_all(&cluster_dir).map_err(|e| {
        format!(
            "Failed to create cluster directory '{}': {e}",
            cluster_dir
        )
    })?;

    let _ = name; // stored in SQLite by the frontend
    Ok(id)
}

/// Delete the cluster directory from disk when `delete_files` is true.
/// The frontend removes the SQLite record and clears cluster_id on member servers.
#[tauri::command]
pub async fn delete_cluster(cluster_dir: String, delete_files: bool) -> Result<(), String> {
    if delete_files && !cluster_dir.is_empty() {
        let p = std::path::Path::new(&cluster_dir);
        if p.exists() {
            std::fs::remove_dir_all(p)
                .map_err(|e| format!("Failed to delete cluster directory: {e}"))?;
        }
    }
    Ok(())
}

/// Associate a server with a cluster.
/// All SQLite work (updating servers.cluster_id) is done by the frontend.
#[tauri::command]
pub async fn add_server_to_cluster(
    _server_id: String,
    _cluster_id: String,
) -> Result<(), String> {
    Ok(())
}

/// Disassociate a server from its cluster.
/// All SQLite work (setting servers.cluster_id = NULL) is done by the frontend.
#[tauri::command]
pub async fn remove_server_from_cluster(_server_id: String) -> Result<(), String> {
    Ok(())
}
