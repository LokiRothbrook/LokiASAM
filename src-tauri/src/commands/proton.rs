use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProtonEntry {
    pub path: String,
    pub version: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProtonUpdateInfo {
    pub latest_version: String,
    pub current_version: String,
    pub update_available: bool,
    pub download_url: String,
}

fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/root"))
}

fn is_valid_proton_dir(p: &Path) -> bool {
    p.join("proton").exists()
        && (p.join("files/bin/wine64").exists() || p.join("files/bin/wine").exists())
}

fn emit_download_line(app: &AppHandle, msg: &str) {
    let _ = app.emit(
        "proton://output/download",
        serde_json::json!({ "line": msg, "stream": "stdout" }),
    );
}

/// Scan well-known Steam compatibilitytools.d locations and {base_dir}/lokiasam/proton/
/// for valid GE-Proton installations.
#[tauri::command]
pub async fn scan_for_proton(base_dir: String) -> Result<Vec<ProtonEntry>, String> {
    let home = home_dir();
    let search_dirs = vec![
        home.join(".steam/root/compatibilitytools.d"),
        home.join(".steam/steam/compatibilitytools.d"),
        home.join(".local/share/Steam/compatibilitytools.d"),
        home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam/compatibilitytools.d"),
        PathBuf::from(&base_dir).join("lokiasam").join("proton"),
    ];

    let mut results = Vec::new();

    for dir in &search_dirs {
        if !dir.exists() {
            continue;
        }
        let rd = match std::fs::read_dir(dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            let path = entry.path();
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            if name.starts_with("GE-Proton") && path.is_dir() && is_valid_proton_dir(&path) {
                results.push(ProtonEntry {
                    path: path.to_string_lossy().into_owned(),
                    version: name,
                });
            }
        }
    }

    Ok(results)
}

/// Validate that the given path contains a usable Proton-GE installation.
#[tauri::command]
pub async fn validate_proton_path(path: String) -> Result<bool, String> {
    Ok(is_valid_proton_dir(Path::new(&path)))
}

/// Download the latest GE-Proton release from GitHub, extract it to
/// `target_dir`, and return the full path to the extracted directory.
/// Progress is streamed to the `proton://output/download` event channel.
/// Abort key: "proton_download" — call `abort_operation` to cancel.
/// On abort, the partial download file is removed; the target_dir is left (may be empty).
#[tauri::command]
pub async fn download_proton_ge(
    app_handle: AppHandle,
    target_dir: String,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<String, String> {
    let abort = state.register_abort("proton_download");
    let result = download_proton_ge_inner(&app_handle, &target_dir, &abort).await;
    state.clear_abort("proton_download");
    result
}

async fn download_proton_ge_inner(
    app_handle: &AppHandle,
    target_dir: &str,
    abort: &std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<String, String> {
    use tokio::io::AsyncWriteExt;

    emit_download_line(&app_handle, "Fetching latest GE-Proton release from GitHub...");

    let client = reqwest::Client::builder()
        .user_agent("LokiASAM/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    let release: serde_json::Value = client
        .get("https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases/latest")
        .send()
        .await
        .map_err(|e| format!("GitHub API request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub API response: {e}"))?;

    let tag = release["tag_name"]
        .as_str()
        .ok_or("Release has no tag_name")?
        .to_string();

    emit_download_line(&app_handle, &format!("Latest release: {tag}"));

    let assets = release["assets"]
        .as_array()
        .ok_or("No assets in release")?;

    let asset = assets
        .iter()
        .find(|a| {
            a["name"]
                .as_str()
                .map(|n| n.ends_with(".tar.gz"))
                .unwrap_or(false)
        })
        .ok_or("No .tar.gz asset found in release")?;

    let asset_name = asset["name"]
        .as_str()
        .unwrap_or("proton.tar.gz")
        .to_string();
    let download_url = asset["browser_download_url"]
        .as_str()
        .ok_or("Asset has no download URL")?
        .to_string();
    let size_bytes = asset["size"].as_u64().unwrap_or(0);

    emit_download_line(
        &app_handle,
        &format!(
            "Downloading {} ({:.1} MB)...",
            asset_name,
            size_bytes as f64 / 1_048_576.0
        ),
    );

    let target = PathBuf::from(&target_dir);
    tokio::fs::create_dir_all(&target)
        .await
        .map_err(|e| format!("Failed to create target dir: {e}"))?;

    let tmp_path = target.join(format!("{asset_name}.tmp"));
    let tar_path = target.join(&asset_name);

    let mut response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    let mut file = tokio::fs::File::create(&tmp_path)
        .await
        .map_err(|e| format!("Failed to create temp file: {e}"))?;

    let mut downloaded: u64 = 0;
    let mut last_reported_bucket: u64 = 0;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Download chunk error: {e}"))?
    {
        if abort.load(Ordering::Relaxed) {
            drop(file);
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err("Aborted".into());
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Write error: {e}"))?;
        downloaded += chunk.len() as u64;
        if size_bytes > 0 {
            let pct = downloaded * 100 / size_bytes;
            let bucket = pct / 10;
            if bucket > last_reported_bucket {
                last_reported_bucket = bucket;
                emit_download_line(
                    &app_handle,
                    &format!(
                        "  {}% ({:.0} / {:.0} MB)",
                        pct,
                        downloaded as f64 / 1_048_576.0,
                        size_bytes as f64 / 1_048_576.0
                    ),
                );
            }
        }
    }

    drop(file);

    tokio::fs::rename(&tmp_path, &tar_path)
        .await
        .map_err(|e| format!("Failed to finalize download: {e}"))?;

    emit_download_line(&app_handle, "Download complete. Extracting archive...");

    let tar_path_clone = tar_path.clone();
    let target_clone = target.clone();
    let tag_clone = tag.clone();
    let abort_extract = std::sync::Arc::clone(abort);
    tokio::task::spawn_blocking(move || {
        use flate2::read::GzDecoder;
        use tar::Archive;

        let f = std::fs::File::open(&tar_path_clone)
            .map_err(|e| format!("Failed to open archive: {e}"))?;
        let gz = GzDecoder::new(f);
        let mut archive = Archive::new(gz);

        // Iterate entries one-by-one so we can check the abort flag between
        // files. unpack() has no cancellation hook.
        for entry in archive.entries().map_err(|e| format!("Failed to read archive: {e}"))? {
            if abort_extract.load(Ordering::Relaxed) {
                let _ = std::fs::remove_file(&tar_path_clone);
                let _ = std::fs::remove_dir_all(target_clone.join(&tag_clone));
                return Err("Aborted".into());
            }
            let mut entry = entry.map_err(|e| format!("Archive entry error: {e}"))?;
            entry
                .unpack_in(&target_clone)
                .map_err(|e| format!("Failed to extract entry: {e}"))?;
        }

        let _ = std::fs::remove_file(&tar_path_clone);
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Extraction task error: {e}"))??;

    let extracted_path = target.join(&tag);

    if !extracted_path.exists() {
        return Err(format!(
            "Extraction finished but expected directory not found: {}",
            extracted_path.display()
        ));
    }

    emit_download_line(
        &app_handle,
        &format!(
            "Proton-GE installed successfully to: {}",
            extracted_path.display()
        ),
    );

    Ok(extracted_path.to_string_lossy().into_owned())
}

/// Query GitHub for the latest GE-Proton release without downloading.
/// `current_path` is the currently configured proton_path (may be empty).
#[tauri::command]
pub async fn check_proton_ge_update(current_path: String) -> Result<ProtonUpdateInfo, String> {
    let client = reqwest::Client::builder()
        .user_agent("LokiASAM/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    let release: serde_json::Value = client
        .get("https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases/latest")
        .send()
        .await
        .map_err(|e| format!("GitHub API request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub API response: {e}"))?;

    let latest_version = release["tag_name"]
        .as_str()
        .ok_or("Release has no tag_name")?
        .to_string();

    let download_url = release["assets"]
        .as_array()
        .and_then(|a| {
            a.iter().find(|asset| {
                asset["name"]
                    .as_str()
                    .map(|n| n.ends_with(".tar.gz"))
                    .unwrap_or(false)
            })
        })
        .and_then(|asset| asset["browser_download_url"].as_str())
        .unwrap_or("")
        .to_string();

    // Derive current version from the last path component of current_path.
    let current_version = if current_path.is_empty() {
        String::new()
    } else {
        Path::new(&current_path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    };

    let update_available = !current_version.is_empty() && current_version != latest_version;

    Ok(ProtonUpdateInfo {
        latest_version,
        current_version,
        update_available,
        download_url,
    })
}
