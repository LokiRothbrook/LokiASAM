use crate::events;
use std::path::Path;

use super::utils::{build_steamcmd_cmd, copy_dir_recursive, emit_line, stream_process};

/// ASA Dedicated Server Steam App ID.
const ASA_SERVER_APP_ID: &str = "2430930";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Run SteamCMD `+force_install_dir {dir} +login anonymous +app_update {ASA_ID} +quit`
/// with an optional `validate` flag. Retries once on non-zero exit (Windows self-update).
pub async fn steamcmd_app_update(
    app: &tauri::AppHandle,
    steamcmd_path: &str,
    target_dir: &str,
    validate: bool,
    channel: &str,
) -> Result<(), String> {
    let validate_flag = if validate { "validate" } else { "" };

    let mut base_args = vec![
        "+force_install_dir", target_dir,
        "+login", "anonymous",
        "+app_update", ASA_SERVER_APP_ID,
    ];
    if validate {
        base_args.push(validate_flag);
    }
    base_args.push("+quit");

    let mut child = build_steamcmd_cmd(steamcmd_path, &base_args)
        .spawn()
        .map_err(|e| format!("Failed to launch SteamCMD: {e}"))?;

    let exit_code = stream_process(app, &mut child, channel).await?;
    if exit_code == 0 {
        return Ok(());
    }

    emit_line(
        app, channel, "stdout",
        &format!("SteamCMD exited {exit_code} (may be first-run self-update). Retrying…"),
    )?;
    let mut child2 = build_steamcmd_cmd(steamcmd_path, &base_args)
        .spawn()
        .map_err(|e| format!("Failed to re-launch SteamCMD: {e}"))?;
    let exit_code2 = stream_process(app, &mut child2, channel).await?;
    if exit_code2 == 0 {
        Ok(())
    } else {
        Err(format!("SteamCMD exited {exit_code2} after retry."))
    }
}

/// Copy from `cache` to `server`, skipping subdirectories that contain user
/// data (ShooterGame/Saved).  Directory names are compared case-insensitively.
pub fn sync_cache_to_server(cache: &Path, server: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(server)?;
    for entry in std::fs::read_dir(cache)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_lower = name.to_string_lossy().to_lowercase();
        let src = entry.path();
        let dst = server.join(&name);

        if src.is_dir() {
            if name_lower == "shootergame" {
                sync_shootergame(&src, &dst)?;
            } else {
                copy_dir_recursive(&src, &dst, &[])?;
            }
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// Recurse into `ShooterGame/`, skipping `Saved/` so player data is preserved.
fn sync_shootergame(cache_sg: &Path, server_sg: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(server_sg)?;
    for entry in std::fs::read_dir(cache_sg)? {
        let entry = entry?;
        let name = entry.file_name();
        if name.to_string_lossy().to_lowercase() == "saved" {
            continue;
        }
        let src = entry.path();
        let dst = server_sg.join(&name);
        if src.is_dir() {
            copy_dir_recursive(&src, &dst, &[])?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Download and extract SteamCMD into `target_dir`.
/// Emits progress to `steamcmd://output/setup`.
/// Supports Windows (.zip) and Linux (.tar.gz).
#[tauri::command]
pub async fn install_steamcmd(
    target_dir: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let channel = format!("{}/setup", events::STEAMCMD_OUTPUT);
    let dir = Path::new(&target_dir);

    emit_line(&app_handle, &channel, "stdout", &format!("Creating directory: {}", dir.display()))?;
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| format!("Failed to create target directory: {e}"))?;

    #[cfg(target_os = "windows")]
    let (url, is_zip) = (
        "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip",
        true,
    );
    #[cfg(not(target_os = "windows"))]
    let (url, is_zip) = (
        "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz",
        false,
    );

    emit_line(&app_handle, &channel, "stdout", &format!("Downloading SteamCMD from {url}"))?;

    let response = reqwest::get(url)
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    let total = response.content_length().unwrap_or(0);
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read download: {e}"))?;

    emit_line(
        &app_handle,
        &channel,
        "stdout",
        &format!("Downloaded {} / {} bytes. Extracting...", bytes.len(), total),
    )?;

    if is_zip {
        let cursor = std::io::Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(cursor)
            .map_err(|e| format!("Failed to open ZIP: {e}"))?;
        archive
            .extract(dir)
            .map_err(|e| format!("Failed to extract ZIP: {e}"))?;
    } else {
        let gz = flate2::read::GzDecoder::new(bytes.as_ref());
        let mut archive = tar::Archive::new(gz);
        archive
            .unpack(dir)
            .map_err(|e| format!("Failed to extract tar.gz: {e}"))?;
    }

    #[cfg(target_os = "windows")]
    let exe_name = "steamcmd.exe";
    #[cfg(not(target_os = "windows"))]
    let exe_name = "steamcmd.sh";

    let exe_path = dir.join(exe_name);
    if !exe_path.exists() {
        return Err(format!(
            "Extraction succeeded but {} not found at {}",
            exe_name,
            exe_path.display()
        ));
    }

    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = tokio::fs::metadata(&exe_path)
            .await
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        tokio::fs::set_permissions(&exe_path, perms)
            .await
            .map_err(|e| e.to_string())?;
    }

    emit_line(&app_handle, &channel, "stdout", "SteamCMD extracted successfully.")?;
    emit_line(&app_handle, &channel, "stdout", &format!("Executable: {}", exe_path.display()))?;
    Ok(())
}

/// Run `steamcmd +quit` to verify the binary works and trigger first-run self-updates.
///
/// On Windows, SteamCMD self-updates on its very first run and exits with code 7.
/// We detect this, log it, and automatically re-run once — the second run exits 0.
#[tauri::command]
pub async fn validate_steamcmd(
    path: String,
    app_handle: tauri::AppHandle,
) -> Result<bool, String> {
    let channel = format!("{}/validate", events::STEAMCMD_OUTPUT);
    emit_line(&app_handle, &channel, "stdout", &format!("Validating SteamCMD at: {path}"))?;

    let mut child = build_steamcmd_cmd(&path, &["+quit"])
        .spawn()
        .map_err(|e| format!("Failed to launch SteamCMD: {e}"))?;

    let exit_code = stream_process(&app_handle, &mut child, &channel).await?;

    if exit_code != 0 {
        emit_line(
            &app_handle,
            &channel,
            "stdout",
            &format!(
                "SteamCMD exited with code {exit_code} (first-run self-update is normal on Windows). Re-running..."
            ),
        )?;

        let mut child2 = build_steamcmd_cmd(&path, &["+quit"])
            .spawn()
            .map_err(|e| format!("Failed to re-launch SteamCMD: {e}"))?;

        let exit_code2 = stream_process(&app_handle, &mut child2, &channel).await?;

        if exit_code2 == 0 {
            emit_line(&app_handle, &channel, "stdout", "SteamCMD validation successful.")?;
            return Ok(true);
        } else {
            emit_line(
                &app_handle,
                &channel,
                "stderr",
                &format!("SteamCMD exited with code {exit_code2} after retry. Validation failed."),
            )?;
            return Ok(false);
        }
    }

    emit_line(&app_handle, &channel, "stdout", "SteamCMD validation successful.")?;
    Ok(true)
}

/// Install the ASA Dedicated Server using a shared cache directory to avoid
/// re-downloading the ~15 GB game files for every new server.
#[tauri::command]
pub async fn install_server(
    server_id: String,
    install_path: String,
    cache_dir: String,
    steamcmd_path: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let channel = format!("{}/{}", events::STEAMCMD_OUTPUT, server_id);

    emit_line(&app_handle, &channel, "stdout",
        &format!("Ensuring server cache at: {cache_dir}"))?;
    tokio::fs::create_dir_all(&cache_dir).await
        .map_err(|e| format!("Failed to create cache directory: {e}"))?;

    emit_line(&app_handle, &channel, "stdout",
        "Updating server cache (SteamCMD will skip unchanged files)…")?;
    steamcmd_app_update(&app_handle, &steamcmd_path, &cache_dir, false, &channel).await?;
    emit_line(&app_handle, &channel, "stdout", "Cache is up to date.")?;

    emit_line(&app_handle, &channel, "stdout",
        &format!("Copying server files from cache to: {install_path}"))?;
    tokio::fs::create_dir_all(&install_path).await
        .map_err(|e| format!("Failed to create install directory: {e}"))?;

    let src = std::path::PathBuf::from(&cache_dir);
    let dst = std::path::PathBuf::from(&install_path);

    tokio::task::spawn_blocking(move || copy_dir_recursive(&src, &dst, &[]))
        .await
        .map_err(|e| format!("Copy task panicked: {e}"))?
        .map_err(|e| format!("Failed to copy server files: {e}"))?;

    emit_line(&app_handle, &channel, "stdout", "Server installation complete.")?;
    Ok(())
}

/// Update an existing ASA server via the shared cache, preserving ShooterGame/Saved.
#[tauri::command]
pub async fn update_server(
    server_id: String,
    install_path: String,
    cache_dir: String,
    steamcmd_path: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let channel = format!("{}/{}", events::STEAMCMD_OUTPUT, server_id);

    emit_line(&app_handle, &channel, "stdout", "Checking for updates (cache)…")?;
    tokio::fs::create_dir_all(&cache_dir).await
        .map_err(|e| format!("Failed to ensure cache directory: {e}"))?;
    steamcmd_app_update(&app_handle, &steamcmd_path, &cache_dir, false, &channel).await?;
    emit_line(&app_handle, &channel, "stdout", "Cache updated.")?;

    emit_line(&app_handle, &channel, "stdout",
        "Syncing updated files to server (preserving Saved/ data)…")?;

    let cache_path = std::path::PathBuf::from(&cache_dir);
    let server_path = std::path::PathBuf::from(&install_path);

    tokio::task::spawn_blocking(move || sync_cache_to_server(&cache_path, &server_path))
        .await
        .map_err(|e| format!("Sync task panicked: {e}"))?
        .map_err(|e| format!("Failed to sync server files: {e}"))?;

    emit_line(&app_handle, &channel, "stdout", "Server update complete.")?;
    Ok(())
}

/// Validate and repair the server files in the shared cache, then re-copy to the server.
#[tauri::command]
pub async fn validate_server_files(
    server_id: String,
    install_path: String,
    cache_dir: String,
    steamcmd_path: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let channel = format!("{}/{}", events::STEAMCMD_OUTPUT, server_id);
    emit_line(&app_handle, &channel, "stdout", "Validating server files in cache…")?;

    tokio::fs::create_dir_all(&cache_dir).await
        .map_err(|e| format!("Failed to ensure cache directory: {e}"))?;

    steamcmd_app_update(&app_handle, &steamcmd_path, &cache_dir, true, &channel).await?;
    emit_line(&app_handle, &channel, "stdout", "Validation complete. Re-syncing to server…")?;

    let cache_path = std::path::PathBuf::from(&cache_dir);
    let server_path = std::path::PathBuf::from(&install_path);
    tokio::task::spawn_blocking(move || sync_cache_to_server(&cache_path, &server_path))
        .await
        .map_err(|e| format!("Sync task panicked: {e}"))?
        .map_err(|e| format!("Failed to sync after validate: {e}"))?;

    emit_line(&app_handle, &channel, "stdout", "Server files validated and synced.")?;
    Ok(())
}

/// Check whether a newer build is available for the ASA server.
/// Not yet implemented — returns false so the UI does not show a spurious error.
#[tauri::command]
pub async fn check_server_update_available(_server_id: String) -> Result<bool, String> {
    Ok(false)
}
