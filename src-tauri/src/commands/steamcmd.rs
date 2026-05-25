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

/// Build a `tokio::process::Command` for SteamCMD with:
/// - stdout and stderr piped for capture
/// - On Windows: CREATE_NO_WINDOW so no console terminal pops up
fn build_steamcmd_cmd(path: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new(path);
    cmd.args(args);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // Suppress the console window that Windows opens for console-subsystem EXEs.
    // CREATE_NO_WINDOW = 0x08000000
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);

    cmd
}

/// Stream all stdout/stderr from a child process to a Tauri event channel.
/// Returns the raw exit code so callers can distinguish codes (e.g. 7 = self-update).
async fn stream_process(
    app: &tauri::AppHandle,
    child: &mut tokio::process::Child,
    channel: &str,
) -> Result<i32, String> {
    use tokio::io::AsyncBufReadExt;

    let stdout = child.stdout.take().ok_or("failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("failed to capture stderr")?;

    let mut out_lines = BufReader::new(stdout).lines();
    let mut err_lines = BufReader::new(stderr).lines();

    // Read stdout and stderr concurrently until both are exhausted.
    // We use two separate tasks so neither stream starves the other.
    let app_out = app.clone();
    let channel_out = channel.to_string();
    let stdout_task = tauri::async_runtime::spawn(async move {
        while let Ok(Some(l)) = out_lines.next_line().await {
            let _ = emit_line(&app_out, &channel_out, "stdout", &l);
        }
    });

    let app_err = app.clone();
    let channel_err = channel.to_string();
    let stderr_task = tauri::async_runtime::spawn(async move {
        while let Ok(Some(l)) = err_lines.next_line().await {
            let _ = emit_line(&app_err, &channel_err, "stderr", &l);
        }
    });

    // Wait for both streams to finish, then collect the exit code.
    let _ = tokio::join!(stdout_task, stderr_task);
    let status = child.wait().await.map_err(|e| e.to_string())?;

    Ok(status.code().unwrap_or(-1))
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
    let channel = "steamcmd://output/setup";
    let dir = Path::new(&target_dir);

    emit_line(&app_handle, channel, "stdout", &format!("Creating directory: {}", dir.display()))?;
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

    emit_line(&app_handle, channel, "stdout", "SteamCMD extracted successfully.")?;
    emit_line(&app_handle, channel, "stdout", &format!("Executable: {}", exe_path.display()))?;
    Ok(())
}

/// Run `steamcmd +quit` to verify the binary works and trigger any first-run self-updates.
///
/// On Windows, SteamCMD self-updates on its very first run and exits with code 7.
/// We detect this, log it, and automatically re-run once — the second run exits 0
/// once the self-update is complete.
#[tauri::command]
pub async fn validate_steamcmd(
    path: String,
    app_handle: tauri::AppHandle,
) -> Result<bool, String> {
    let channel = "steamcmd://output/validate";
    emit_line(&app_handle, channel, "stdout", &format!("Validating SteamCMD at: {path}"))?;

    let mut child = build_steamcmd_cmd(&path, &["+quit"])
        .spawn()
        .map_err(|e| format!("Failed to launch SteamCMD: {e}"))?;

    let exit_code = stream_process(&app_handle, &mut child, channel).await?;

    // Exit code 7 is SteamCMD's "I just self-updated, please re-run me" signal.
    // Any other non-zero code on a first attempt also gets one retry, since
    // SteamCMD can be flaky on first launch while redistributables install.
    if exit_code != 0 {
        emit_line(
            &app_handle,
            channel,
            "stdout",
            &format!(
                "SteamCMD exited with code {exit_code} (first-run self-update is normal on Windows). Re-running..."
            ),
        )?;

        let mut child2 = build_steamcmd_cmd(&path, &["+quit"])
            .spawn()
            .map_err(|e| format!("Failed to re-launch SteamCMD: {e}"))?;

        let exit_code2 = stream_process(&app_handle, &mut child2, channel).await?;

        if exit_code2 == 0 {
            emit_line(&app_handle, channel, "stdout", "SteamCMD validation successful.")?;
            return Ok(true);
        } else {
            emit_line(
                &app_handle,
                channel,
                "stderr",
                &format!("SteamCMD exited with code {exit_code2} after retry. Validation failed."),
            )?;
            return Ok(false);
        }
    }

    emit_line(&app_handle, channel, "stdout", "SteamCMD validation successful.")?;
    Ok(true)
}

/// Install the ASA Dedicated Server (App ID 2430930) via SteamCMD.
/// Emits line-by-line output to `steamcmd://output/{server_id}`.
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

    let mut child = build_steamcmd_cmd(
        &steamcmd_path,
        &[
            "+force_install_dir", &install_path,
            "+login", "anonymous",
            "+app_update", ASA_SERVER_APP_ID,
            "+quit",
        ],
    )
    .spawn()
    .map_err(|e| format!("Failed to launch SteamCMD: {e}"))?;

    let exit_code = stream_process(&app_handle, &mut child, &channel).await?;

    if exit_code == 0 {
        emit_line(&app_handle, &channel, "stdout", "Server installation complete.")?;
        return Ok(());
    }

    // On Windows, SteamCMD can exit with code 7 (self-update) or 8 (missing config)
    // on its first real app_update call while it finishes initializing. Retry once.
    emit_line(
        &app_handle,
        &channel,
        "stdout",
        &format!(
            "SteamCMD exited with code {exit_code} (first-run initialization on Windows is normal). Retrying…"
        ),
    )?;

    let mut child2 = build_steamcmd_cmd(
        &steamcmd_path,
        &[
            "+force_install_dir", &install_path,
            "+login", "anonymous",
            "+app_update", ASA_SERVER_APP_ID,
            "+quit",
        ],
    )
    .spawn()
    .map_err(|e| format!("Failed to re-launch SteamCMD: {e}"))?;

    let exit_code2 = stream_process(&app_handle, &mut child2, &channel).await?;

    if exit_code2 == 0 {
        emit_line(&app_handle, &channel, "stdout", "Server installation complete.")?;
        Ok(())
    } else {
        let msg = format!("SteamCMD install exited with code {exit_code2} after retry. Installation may have failed.");
        emit_line(&app_handle, &channel, "stderr", &msg)?;
        Err(msg)
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

    let mut child = build_steamcmd_cmd(
        &steamcmd_path,
        &[
            "+force_install_dir", &install_path,
            "+login", "anonymous",
            "+app_update", ASA_SERVER_APP_ID,
            "+quit",
        ],
    )
    .spawn()
    .map_err(|e| format!("Failed to launch SteamCMD: {e}"))?;

    let exit_code = stream_process(&app_handle, &mut child, &channel).await?;

    if exit_code == 0 {
        emit_line(&app_handle, &channel, "stdout", "Server update complete.")?;
        Ok(())
    } else {
        Err(format!("SteamCMD update exited with code {exit_code}."))
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

    let mut child = build_steamcmd_cmd(
        &steamcmd_path,
        &[
            "+force_install_dir", &install_path,
            "+login", "anonymous",
            "+app_update", ASA_SERVER_APP_ID, "validate",
            "+quit",
        ],
    )
    .spawn()
    .map_err(|e| format!("Failed to launch SteamCMD: {e}"))?;

    let exit_code = stream_process(&app_handle, &mut child, &channel).await?;

    if exit_code == 0 {
        Ok(())
    } else {
        Err(format!("SteamCMD validate exited with code {exit_code}."))
    }
}

/// Check whether a newer build is available for the ASA server.
#[tauri::command]
pub async fn check_server_update_available(_server_id: String) -> Result<bool, String> {
    Err("Not implemented".into())
}
