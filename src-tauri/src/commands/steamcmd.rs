use crate::events;
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
    let channel = format!("{}/validate", events::STEAMCMD_OUTPUT);
    emit_line(&app_handle, &channel, "stdout", &format!("Validating SteamCMD at: {path}"))?;

    let mut child = build_steamcmd_cmd(&path, &["+quit"])
        .spawn()
        .map_err(|e| format!("Failed to launch SteamCMD: {e}"))?;

    let exit_code = stream_process(&app_handle, &mut child, &channel).await?;

    // Exit code 7 is SteamCMD's "I just self-updated, please re-run me" signal.
    // Any other non-zero code on a first attempt also gets one retry, since
    // SteamCMD can be flaky on first launch while redistributables install.
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Run SteamCMD `+force_install_dir {dir} +login anonymous +app_update {ASA_ID} +quit`
/// with an optional `validate` flag. Retries once on non-zero exit (Windows self-update).
async fn steamcmd_app_update(
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

    // Retry once — SteamCMD exits non-zero on Windows first-run self-update.
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

/// Recursively copy `src` into `dst`, skipping `skip_rel` sub-paths (relative to `src`).
/// Creates `dst` if it doesn't exist. Existing files in `dst` are overwritten.
fn copy_dir_recursive(src: &Path, dst: &Path, skip_rel: &[&str]) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let file_name_str = file_name.to_string_lossy();

        // Build the relative path fragment for skip checking (case-insensitive on Windows)
        let should_skip = skip_rel.iter().any(|skip| {
            file_name_str.eq_ignore_ascii_case(skip)
        });
        if should_skip {
            continue;
        }

        let src_path = entry.path();
        let dst_path = dst.join(&file_name);

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path, &[])?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Install the ASA Dedicated Server using a shared cache directory to avoid
/// re-downloading the ~15 GB game files for every new server.
///
/// Flow:
///  1. Ensure `cache_dir` exists.
///  2. Run SteamCMD `+force_install_dir {cache_dir} +app_update 2430930` — this
///     updates the cache (fast no-op if already current).
///  3. Recursively copy the cache into `install_path` (full copy, no hardlinks).
///
/// Emits line-by-line output to `steamcmd://output/{server_id}`.
#[tauri::command]
pub async fn install_server(
    server_id: String,
    install_path: String,
    cache_dir: String,
    steamcmd_path: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let channel = format!("{}/{}", events::STEAMCMD_OUTPUT, server_id);

    // ── Step 1: ensure cache dir exists ──────────────────────────────────────
    emit_line(&app_handle, &channel, "stdout",
        &format!("Ensuring server cache at: {cache_dir}"))?;
    tokio::fs::create_dir_all(&cache_dir).await
        .map_err(|e| format!("Failed to create cache directory: {e}"))?;

    // ── Step 2: update/populate the cache via SteamCMD ───────────────────────
    emit_line(&app_handle, &channel, "stdout",
        "Updating server cache (SteamCMD will skip unchanged files)…")?;
    steamcmd_app_update(&app_handle, &steamcmd_path, &cache_dir, false, &channel).await?;
    emit_line(&app_handle, &channel, "stdout", "Cache is up to date.")?;

    // ── Step 3: copy cache → server install dir ───────────────────────────────
    emit_line(&app_handle, &channel, "stdout",
        &format!("Copying server files from cache to: {install_path}"))?;
    tokio::fs::create_dir_all(&install_path).await
        .map_err(|e| format!("Failed to create install directory: {e}"))?;

    let src = std::path::PathBuf::from(&cache_dir);
    let dst = std::path::PathBuf::from(&install_path);

    // Run the potentially slow recursive copy on a blocking thread.
    tokio::task::spawn_blocking(move || {
        copy_dir_recursive(&src, &dst, &[])
    })
    .await
    .map_err(|e| format!("Copy task panicked: {e}"))?
    .map_err(|e| format!("Failed to copy server files: {e}"))?;

    emit_line(&app_handle, &channel, "stdout", "Server installation complete.")?;
    Ok(())
}

/// Update an existing ASA server.
///
/// Flow:
///  1. Run SteamCMD against `cache_dir` to bring the cache up to date.
///  2. Copy updated files from cache to `install_path`, skipping
///     `ShooterGame/Saved` so player data and configs are preserved.
///
/// Emits output to `steamcmd://output/{server_id}`.
#[tauri::command]
pub async fn update_server(
    server_id: String,
    install_path: String,
    cache_dir: String,
    steamcmd_path: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let channel = format!("{}/{}", events::STEAMCMD_OUTPUT, server_id);

    // ── Step 1: update the shared cache ──────────────────────────────────────
    emit_line(&app_handle, &channel, "stdout", "Checking for updates (cache)…")?;
    tokio::fs::create_dir_all(&cache_dir).await
        .map_err(|e| format!("Failed to ensure cache directory: {e}"))?;
    steamcmd_app_update(&app_handle, &steamcmd_path, &cache_dir, false, &channel).await?;
    emit_line(&app_handle, &channel, "stdout", "Cache updated.")?;

    // ── Step 2: sync cache → server, preserving ShooterGame/Saved ────────────
    emit_line(&app_handle, &channel, "stdout",
        "Syncing updated files to server (preserving Saved/ data)…")?;

    let cache_path = std::path::PathBuf::from(&cache_dir);
    let server_path = std::path::PathBuf::from(&install_path);

    tokio::task::spawn_blocking(move || {
        sync_cache_to_server(&cache_path, &server_path)
    })
    .await
    .map_err(|e| format!("Sync task panicked: {e}"))?
    .map_err(|e| format!("Failed to sync server files: {e}"))?;

    emit_line(&app_handle, &channel, "stdout", "Server update complete.")?;
    Ok(())
}

/// Copy from `cache` to `server`, skipping subdirectories in `server` that
/// contain user data (ShooterGame/Saved).  Top-level directory names are
/// compared case-insensitively so the logic works on both Linux and Windows.
fn sync_cache_to_server(cache: &Path, server: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(server)?;
    for entry in std::fs::read_dir(cache)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_lower = name.to_string_lossy().to_lowercase();
        let src = entry.path();
        let dst = server.join(&name);

        if src.is_dir() {
            // For the "ShooterGame" directory, recurse but skip the "Saved" subtree.
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

/// Recurse into `ShooterGame/`, skipping the `Saved/` subdirectory so player
/// data, configs, and logs in the live server are never overwritten.
fn sync_shootergame(cache_sg: &Path, server_sg: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(server_sg)?;
    for entry in std::fs::read_dir(cache_sg)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_lower = name.to_string_lossy().to_lowercase();
        // Skip ShooterGame/Saved — contains player data and server configs.
        if name_lower == "saved" {
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

/// Validate and repair the server files in the shared cache, then re-copy to the
/// server install directory.  Use this when files are suspected to be corrupted.
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

    // Validate + repair the cache
    steamcmd_app_update(&app_handle, &steamcmd_path, &cache_dir, true, &channel).await?;
    emit_line(&app_handle, &channel, "stdout", "Validation complete. Re-syncing to server…")?;

    let cache_path = std::path::PathBuf::from(&cache_dir);
    let server_path = std::path::PathBuf::from(&install_path);
    tokio::task::spawn_blocking(move || {
        sync_cache_to_server(&cache_path, &server_path)
    })
    .await
    .map_err(|e| format!("Sync task panicked: {e}"))?
    .map_err(|e| format!("Failed to sync after validate: {e}"))?;

    emit_line(&app_handle, &channel, "stdout", "Server files validated and synced.")?;
    Ok(())
}

/// Check whether a newer build is available for the ASA server.
#[tauri::command]
pub async fn check_server_update_available(_server_id: String) -> Result<bool, String> {
    Err("Not implemented".into())
}
