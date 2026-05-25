use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use tauri::Emitter;
use tokio::io::BufReader;
use tokio::process::Command;

/// ASA Dedicated Server Steam App ID.
const ASA_SERVER_APP_ID: &str = "2430930";

/// Payload emitted on `steamcmd://output/{channel}` for each line of stdout/stderr.
#[derive(Clone, Serialize, Deserialize)]
pub struct SteamCmdLine {
    pub line: String,
    pub stream: String, // "stdout" or "stderr"
}

/// Emit a single text line as a SteamCMD output event.
fn emit_line(app: &tauri::AppHandle, channel: &str, stream: &str, line: &str) -> Result<(), String> {
    app.emit(channel, SteamCmdLine {
        line: line.to_string(),
        stream: stream.to_string(),
    })
    .map_err(|e| e.to_string())
}

/// Stream all stdout/stderr from a child process to a Tauri event channel.
/// Returns Ok(exit_success).
async fn stream_process(
    app: &tauri::AppHandle,
    child: &mut tokio::process::Child,
    channel: &str,
) -> Result<bool, String> {
    use tokio::io::AsyncBufReadExt;

    let stdout = child.stdout.take().ok_or("failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("failed to capture stderr")?;

    let mut out_lines = BufReader::new(stdout).lines();
    let mut err_lines = BufReader::new(stderr).lines();

    loop {
        tokio::select! {
            line = out_lines.next_line() => {
                match line.map_err(|e| e.to_string())? {
                    Some(l) => emit_line(app, channel, "stdout", &l)?,
                    None => break,
                }
            }
            line = err_lines.next_line() => {
                match line.map_err(|e| e.to_string())? {
                    Some(l) => emit_line(app, channel, "stderr", &l)?,
                    None => break,
                }
            }
        }
    }

    // Drain any remaining stderr after stdout closes
    while let Ok(Some(l)) = err_lines.next_line().await {
        emit_line(app, channel, "stderr", &l)?;
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    Ok(status.success())
}

/// Download and extract SteamCMD into `target_dir`.
/// Emits progress to `steamcmd://output/setup`.
/// Supports Windows (.zip) and Linux (.tar.gz).
#[tauri::command]
pub async fn install_steamcmd(
    target_dir: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let channel = "steamcmd://output/setup";
    let dir = Path::new(&target_dir);

    emit_line(&app_handle, channel, "stdout", &format!("Creating directory: {}", dir.display()))?;
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| format!("Failed to create target directory: {e}"))?;

    // Platform-specific download URL
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

    emit_line(&app_handle, channel, "stdout", &format!("Downloading SteamCMD from {url}"))?;

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
        channel,
        "stdout",
        &format!("Downloaded {} / {} bytes. Extracting...", bytes.len(), total),
    )?;

    if is_zip {
        // Windows: extract ZIP using the `zip` crate
        let cursor = std::io::Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(cursor)
            .map_err(|e| format!("Failed to open ZIP: {e}"))?;
        archive
            .extract(dir)
            .map_err(|e| format!("Failed to extract ZIP: {e}"))?;
    } else {
        // Linux: extract .tar.gz using flate2 + tar
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
        return Err(format!("Extraction succeeded but {} not found at {}", exe_name, exe_path.display()));
    }

    // Make executable on Linux
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

    emit_line(&app_handle, channel, "stdout", "SteamCMD extracted successfully.")?;
    emit_line(&app_handle, channel, "stdout", &format!("Executable: {}", exe_path.display()))?;
    Ok(())
}

/// Run `steamcmd +quit` to verify the binary works and trigger any first-run updates.
/// Emits output to `steamcmd://output/validate`. Returns true if exit code is 0.
#[tauri::command]
pub async fn validate_steamcmd(
    path: String,
    app_handle: tauri::AppHandle,
) -> Result<bool, String> {
    let channel = "steamcmd://output/validate";
    emit_line(&app_handle, channel, "stdout", &format!("Validating SteamCMD at: {path}"))?;

    let mut child = Command::new(&path)
        .args(["+quit"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch SteamCMD: {e}"))?;

    let ok = stream_process(&app_handle, &mut child, channel).await?;

    if ok {
        emit_line(&app_handle, channel, "stdout", "SteamCMD validation successful.")?;
    } else {
        emit_line(&app_handle, channel, "stderr", "SteamCMD exited with a non-zero code.")?;
    }

    Ok(ok)
}

/// Install the ASA Dedicated Server (App ID 2430930) via SteamCMD.
/// Emits line-by-line output to `steamcmd://output/{server_id}`.
/// The frontend passes the install path and steamcmd path; no DB lookup required.
#[tauri::command]
pub async fn install_server(
    server_id: String,
    install_path: String,
    steamcmd_path: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let channel = format!("steamcmd://output/{}", server_id);
    emit_line(&app_handle, &channel, "stdout", &format!("Installing ASA server to: {install_path}"))?;
    emit_line(&app_handle, &channel, "stdout", &format!("Using SteamCMD: {steamcmd_path}"))?;

    let mut child = Command::new(&steamcmd_path)
        .args([
            "+force_install_dir", &install_path,
            "+login", "anonymous",
            "+app_update", ASA_SERVER_APP_ID,
            "+quit",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch SteamCMD: {e}"))?;

    let ok = stream_process(&app_handle, &mut child, &channel).await?;

    if ok {
        emit_line(&app_handle, &channel, "stdout", "Server installation complete.")?;
        Ok(())
    } else {
        let msg = "SteamCMD exited with a non-zero code. Installation may have failed.";
        emit_line(&app_handle, &channel, "stderr", msg)?;
        Err(msg.to_string())
    }
}

/// Update an existing ASA server via SteamCMD +app_update.
/// Emits output to `steamcmd://output/{server_id}`.
#[tauri::command]
pub async fn update_server(
    server_id: String,
    install_path: String,
    steamcmd_path: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let channel = format!("steamcmd://output/{}", server_id);
    emit_line(&app_handle, &channel, "stdout", "Checking for updates...")?;

    let mut child = Command::new(&steamcmd_path)
        .args([
            "+force_install_dir", &install_path,
            "+login", "anonymous",
            "+app_update", ASA_SERVER_APP_ID,
            "+quit",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch SteamCMD: {e}"))?;

    let ok = stream_process(&app_handle, &mut child, &channel).await?;

    if ok {
        emit_line(&app_handle, &channel, "stdout", "Server update complete.")?;
        Ok(())
    } else {
        Err("SteamCMD update exited with non-zero code.".to_string())
    }
}

/// Run SteamCMD +app_update with the `validate` flag to repair corrupted files.
#[tauri::command]
pub async fn validate_server_files(
    server_id: String,
    install_path: String,
    steamcmd_path: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let channel = format!("steamcmd://output/{}", server_id);
    emit_line(&app_handle, &channel, "stdout", "Validating server files...")?;

    let mut child = Command::new(&steamcmd_path)
        .args([
            "+force_install_dir", &install_path,
            "+login", "anonymous",
            "+app_update", ASA_SERVER_APP_ID, "validate",
            "+quit",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch SteamCMD: {e}"))?;

    let ok = stream_process(&app_handle, &mut child, &channel).await?;

    if ok {
        Ok(())
    } else {
        Err("SteamCMD validate exited with non-zero code.".to_string())
    }
}

/// Check whether a newer build is available for the ASA server.
/// Compares the local appmanifest build ID against Steam's depot info.
/// Returns true if an update is available.
#[tauri::command]
pub async fn check_server_update_available(_server_id: String) -> Result<bool, String> {
    // Phase 3 — compare appmanifest_2430930.acf buildid against Steam depot API
    Err("Not implemented".into())
}
