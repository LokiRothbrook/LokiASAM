use crate::events;
use std::path::Path;
use std::sync::atomic::Ordering;

use super::utils::{build_steamcmd_cmd, copy_dir_recursive, emit_line, stream_process, stream_process_abortable};

/// ASA Dedicated Server Steam App ID.
const ASA_SERVER_APP_ID: &str = "2430930";

/// Relative path to the appmanifest ACF inside a Steam install directory.
pub const ACF_REL_PATH: &str = "steamapps/appmanifest_2430930.acf";

// ---------------------------------------------------------------------------
// ACF / INI helpers
// ---------------------------------------------------------------------------

/// Read the build ID from the shared cache directory's appmanifest ACF.
/// Returns None if the cache has never been downloaded.
pub fn get_cache_build_id(cache_dir: &str) -> Option<String> {
    let acf_path = Path::new(cache_dir).join(ACF_REL_PATH);
    read_acf_build_id(&acf_path)
}

/// Extract the "buildid" value from a SteamCMD appmanifest ACF file.
/// Returns None if the file is missing or the key is not found.
pub fn read_acf_build_id(acf_path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(acf_path).ok()?;
    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('"') {
            continue;
        }
        // Parse quote-delimited token pairs: "key"   "value"
        let mut tokens: Vec<String> = Vec::new();
        let mut in_quote = false;
        let mut token = String::new();
        for c in trimmed.chars() {
            match c {
                '"' => {
                    if in_quote {
                        tokens.push(token.clone());
                        token.clear();
                    }
                    in_quote = !in_quote;
                }
                _ if in_quote => token.push(c),
                _ => {}
            }
        }
        if tokens.len() >= 2 && tokens[0].to_lowercase() == "buildid" {
            return Some(tokens[1].clone());
        }
    }
    None
}

/// Minimal INI parser: returns section → key → value map.
fn parse_gus_ini(path: &Path) -> std::collections::HashMap<String, std::collections::HashMap<String, String>> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return Default::default(),
    };
    let mut result: std::collections::HashMap<String, std::collections::HashMap<String, String>> = Default::default();
    let mut section = String::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            section = trimmed[1..trimmed.len() - 1].to_string();
        } else if let Some(eq) = trimmed.find('=') {
            if !section.is_empty() {
                let key = trimmed[..eq].trim().to_string();
                let val = trimmed[eq + 1..].trim().to_string();
                result.entry(section.clone()).or_default().insert(key, val);
            }
        }
    }
    result
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub update_available: bool,
    pub cached_build_id: String,
    pub latest_build_id: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DetectedServerConfig {
    pub exe_found: bool,
    pub session_name: Option<String>,
    pub port: Option<u16>,
    pub query_port: Option<u16>,
    pub rcon_port: Option<u16>,
    pub admin_password: Option<String>,
    pub server_password: Option<String>,
    pub max_players: Option<u32>,
    pub build_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Steam API types (private)
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct SteamUpToDateCheck {
    response: SteamCheckResponse,
}

#[derive(serde::Deserialize)]
struct SteamCheckResponse {
    success: bool,
    #[serde(default)]
    up_to_date: bool,
    #[serde(default)]
    required_version: Option<u64>,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Run SteamCMD `+force_install_dir {dir} +login anonymous +app_update {ASA_ID} +quit`
/// with an optional `validate` flag. Retries once on non-zero exit (Windows self-update).
/// Pass `abort = None` to run without cancellation support.
pub async fn steamcmd_app_update(
    app: &tauri::AppHandle,
    steamcmd_path: &str,
    target_dir: &str,
    validate: bool,
    channel: &str,
    abort: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
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

    let exit_code = match &abort {
        Some(flag) => stream_process_abortable(app, &mut child, channel, std::sync::Arc::clone(flag)).await?,
        None       => stream_process(app, &mut child, channel).await?,
    };

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
    // Don't pre-check the abort flag and bail before calling
    // stream_process_abortable — that would skip its kill logic and leave
    // this freshly-spawned process orphaned. stream_process_abortable checks
    // the flag immediately on entry and kills the process tree if it's
    // already set, so it's always safe to hand off to directly.
    let exit_code2 = match &abort {
        Some(flag) => stream_process_abortable(app, &mut child2, channel, std::sync::Arc::clone(flag)).await?,
        None       => stream_process(app, &mut child2, channel).await?,
    };
    if exit_code2 == 0 {
        Ok(())
    } else {
        Err(format!("SteamCMD exited {exit_code2} after retry."))
    }
}

/// Copy from `cache` to `server`, skipping subdirectories that contain user
/// data (ShooterGame/Saved).  Directory names are compared case-insensitively.
/// Emits a progress line per top-level entry and checks `abort` between them
/// so a caller can cancel and so the operation isn't silently invisible for
/// the many minutes a full ShooterGame/ copy can take.
pub fn sync_cache_to_server(
    cache: &Path,
    server: &Path,
    app: &tauri::AppHandle,
    channel: &str,
    abort: &std::sync::atomic::AtomicBool,
) -> std::io::Result<()> {
    std::fs::create_dir_all(server)?;
    for entry in std::fs::read_dir(cache)? {
        if abort.load(Ordering::Relaxed) {
            return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "Aborted"));
        }
        let entry = entry?;
        let name = entry.file_name();
        let name_lower = name.to_string_lossy().to_lowercase();
        let src = entry.path();
        let dst = server.join(&name);

        let _ = emit_line(app, channel, "stdout", &format!("Syncing {}…", name.to_string_lossy()));

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
/// Abort key: "steamcmd_install" — call `abort_operation` with that key to cancel.
/// On abort the target directory is cleaned up.
#[tauri::command]
pub async fn install_steamcmd(
    target_dir: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), String> {
    let abort = state.register_abort("steamcmd_install");
    let channel = format!("{}/setup", events::STEAMCMD_OUTPUT);
    let dir = Path::new(&target_dir);

    let result = install_steamcmd_inner(&app_handle, &channel, dir, &abort).await;

    state.clear_abort("steamcmd_install");

    if result.is_err() {
        // Clean up on abort or error.
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
    result
}

async fn install_steamcmd_inner(
    app_handle: &tauri::AppHandle,
    channel: &str,
    dir: &Path,
    abort: &std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    emit_line(app_handle, channel, "stdout", &format!("Creating directory: {}", dir.display()))?;
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

    emit_line(app_handle, channel, "stdout", &format!("Downloading SteamCMD from {url}"))?;

    let client = reqwest::Client::builder()
        .user_agent("LokiASAM/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    let total = response.content_length().unwrap_or(0);
    let tmp_path = dir.join("steamcmd_download.tmp");
    let mut file = tokio::fs::File::create(&tmp_path)
        .await
        .map_err(|e| format!("Failed to create temp file: {e}"))?;
    let mut downloaded: u64 = 0;
    let mut last_pct: u64 = 0;

    while let Some(chunk) = response.chunk().await.map_err(|e| format!("Download chunk error: {e}"))? {
        if abort.load(Ordering::Relaxed) {
            drop(file);
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err("Aborted".into());
        }
        file.write_all(&chunk).await.map_err(|e| format!("Write error: {e}"))?;
        downloaded += chunk.len() as u64;
        if total > 0 {
            let pct = downloaded * 100 / total;
            if pct / 10 > last_pct / 10 {
                last_pct = pct;
                emit_line(app_handle, channel, "stdout",
                    &format!("  {}% ({:.0} / {:.0} KB)", pct, downloaded as f64 / 1024.0, total as f64 / 1024.0))?;
            }
        }
    }
    drop(file);

    // Read back the temp file for extraction.
    let bytes = tokio::fs::read(&tmp_path).await.map_err(|e| format!("Failed to read download: {e}"))?;
    let _ = tokio::fs::remove_file(&tmp_path).await;
    emit_line(app_handle, channel, "stdout", &format!("Downloaded {} bytes. Extracting...", bytes.len()))?;

    if is_zip {
        // ZIP extraction is blocking (sync std I/O under the hood) — run it
        // off the async executor like the tar.gz path below already does.
        let dir_owned = dir.to_path_buf();
        tokio::task::spawn_blocking(move || {
            let cursor = std::io::Cursor::new(bytes);
            let mut archive = zip::ZipArchive::new(cursor)
                .map_err(|e| format!("Failed to open ZIP: {e}"))?;
            archive.extract(&dir_owned).map_err(|e| format!("Failed to extract ZIP: {e}"))
        })
        .await
        .map_err(|e| format!("ZIP extraction task panicked: {e}"))??;
    } else {
        let dir_owned = dir.to_path_buf();
        let abort_extract = std::sync::Arc::clone(abort);
        tokio::task::spawn_blocking(move || {
            use flate2::read::GzDecoder;
            use tar::Archive;
            let gz = GzDecoder::new(std::io::Cursor::new(bytes));
            let mut archive = Archive::new(gz);
            for entry in archive.entries().map_err(|e| format!("Failed to read archive: {e}"))? {
                if abort_extract.load(Ordering::Relaxed) {
                    return Err("Aborted".into());
                }
                let mut entry = entry.map_err(|e| format!("Archive entry error: {e}"))?;
                entry.unpack_in(&dir_owned).map_err(|e| format!("Failed to extract entry: {e}"))?;
            }
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| format!("Extraction task error: {e}"))??;
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

    emit_line(app_handle, channel, "stdout", "SteamCMD extracted successfully.")?;
    emit_line(app_handle, channel, "stdout", &format!("Executable: {}", exe_path.display()))?;
    Ok(())
}

/// Run `steamcmd +quit` to verify the binary works and trigger first-run self-updates.
///
/// On Windows, SteamCMD self-updates on its very first run and exits with code 7.
/// We detect this, log it, and automatically re-run once — the second run exits 0.
/// Abort key: "steamcmd_install" (shared with install_steamcmd so Cancel works through both phases).
#[tauri::command]
pub async fn validate_steamcmd(
    path: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<bool, String> {
    let abort = state.register_abort("steamcmd_install");
    let result = validate_steamcmd_inner(&path, &app_handle, &abort).await;
    state.clear_abort("steamcmd_install");
    result
}

async fn validate_steamcmd_inner(
    path: &str,
    app_handle: &tauri::AppHandle,
    abort: &std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<bool, String> {
    let channel = format!("{}/validate", events::STEAMCMD_OUTPUT);
    emit_line(app_handle, &channel, "stdout", &format!("Validating SteamCMD at: {path}"))?;

    let mut child = build_steamcmd_cmd(path, &["+quit"])
        .spawn()
        .map_err(|e| format!("Failed to launch SteamCMD: {e}"))?;

    let exit_code = stream_process_abortable(app_handle, &mut child, &channel, std::sync::Arc::clone(abort)).await?;

    if exit_code != 0 {
        if abort.load(Ordering::Relaxed) {
            return Err("Aborted".into());
        }
        emit_line(
            app_handle,
            &channel,
            "stdout",
            &format!(
                "SteamCMD exited with code {exit_code} (first-run self-update is normal on Windows). Re-running..."
            ),
        )?;

        let mut child2 = build_steamcmd_cmd(path, &["+quit"])
            .spawn()
            .map_err(|e| format!("Failed to re-launch SteamCMD: {e}"))?;

        let exit_code2 = stream_process_abortable(app_handle, &mut child2, &channel, std::sync::Arc::clone(abort)).await?;

        if exit_code2 == 0 {
            emit_line(app_handle, &channel, "stdout", "SteamCMD validation successful.")?;
            return Ok(true);
        } else {
            emit_line(
                app_handle,
                &channel,
                "stderr",
                &format!("SteamCMD exited with code {exit_code2} after retry. Validation failed."),
            )?;
            return Ok(false);
        }
    }

    emit_line(app_handle, &channel, "stdout", "SteamCMD validation successful.")?;
    Ok(true)
}

/// Install the ASA Dedicated Server using a shared cache directory to avoid
/// re-downloading the ~15 GB game files for every new server.
/// Abort key: "server_{server_id}" — call `abort_operation` to cancel.
/// On abort the golden cache copy is preserved; only the individual server's install_path is cleaned.
#[tauri::command]
pub async fn install_server(
    server_id: String,
    install_path: String,
    cache_dir: String,
    steamcmd_path: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), String> {
    let op_key = format!("server_{server_id}");
    let abort = state.register_abort(&op_key);
    let channel = format!("{}/{}", events::STEAMCMD_OUTPUT, server_id);

    let result = async {
        emit_line(&app_handle, &channel, "stdout",
            &format!("Ensuring server cache at: {cache_dir}"))?;
        tokio::fs::create_dir_all(&cache_dir).await
            .map_err(|e| format!("Failed to create cache directory: {e}"))?;

        emit_line(&app_handle, &channel, "stdout",
            "Updating server cache (SteamCMD will skip unchanged files)…")?;
        steamcmd_app_update(&app_handle, &steamcmd_path, &cache_dir, false, &channel,
            Some(std::sync::Arc::clone(&abort))).await?;
        emit_line(&app_handle, &channel, "stdout", "Cache is up to date.")?;

        if abort.load(Ordering::Relaxed) { return Err("Aborted".into()); }

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

        // Record installed build ID and trigger internet version fetch
        let acf = Path::new(&install_path).join(ACF_REL_PATH);
        if let Some(build_id) = read_acf_build_id(&acf) {
            crate::commands::build_version::record_install(&app_handle, &server_id, &build_id);
        }

        Ok(())
    }.await;

    state.clear_abort(&op_key);
    result
}

/// Update an existing ASA server via the shared cache, preserving ShooterGame/Saved.
/// Abort key: "server_{server_id}".
#[tauri::command]
pub async fn update_server(
    server_id: String,
    install_path: String,
    cache_dir: String,
    steamcmd_path: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), String> {
    let op_key = format!("server_{server_id}");
    let abort = state.register_abort(&op_key);
    let channel = format!("{}/{}", events::STEAMCMD_OUTPUT, server_id);

    let result = async {
        emit_line(&app_handle, &channel, "stdout", "Checking for updates (cache)…")?;
        tokio::fs::create_dir_all(&cache_dir).await
            .map_err(|e| format!("Failed to ensure cache directory: {e}"))?;
        steamcmd_app_update(&app_handle, &steamcmd_path, &cache_dir, false, &channel,
            Some(std::sync::Arc::clone(&abort))).await?;
        emit_line(&app_handle, &channel, "stdout", "Cache updated.")?;

        if abort.load(Ordering::Relaxed) { return Err("Aborted".into()); }

        emit_line(&app_handle, &channel, "stdout",
            "Syncing updated files to server (preserving Saved/ data)…")?;

        let cache_path = std::path::PathBuf::from(&cache_dir);
        let server_path = std::path::PathBuf::from(&install_path);
        let app_clone = app_handle.clone();
        let channel_clone = channel.clone();
        let abort_clone = std::sync::Arc::clone(&abort);

        tokio::task::spawn_blocking(move || {
            sync_cache_to_server(&cache_path, &server_path, &app_clone, &channel_clone, &abort_clone)
        })
        .await
        .map_err(|e| format!("Sync task panicked: {e}"))?
        .map_err(|e| format!("Failed to sync server files: {e}"))?;

        emit_line(&app_handle, &channel, "stdout", "Server update complete.")?;

        // Record installed build ID and trigger internet version fetch
        let acf = Path::new(&install_path).join(ACF_REL_PATH);
        if let Some(build_id) = read_acf_build_id(&acf) {
            crate::commands::build_version::record_install(&app_handle, &server_id, &build_id);
        }

        Ok(())
    }.await;

    state.clear_abort(&op_key);
    result
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

    steamcmd_app_update(&app_handle, &steamcmd_path, &cache_dir, true, &channel, None).await?;
    emit_line(&app_handle, &channel, "stdout", "Validation complete. Re-syncing to server…")?;

    let cache_path = std::path::PathBuf::from(&cache_dir);
    let server_path = std::path::PathBuf::from(&install_path);
    let app_clone = app_handle.clone();
    let channel_clone = channel.clone();
    tokio::task::spawn_blocking(move || {
        // No cancellation for this path today — there's no Cancel affordance
        // wired up to the Verify Files button, so a never-set flag is correct.
        let no_abort = std::sync::atomic::AtomicBool::new(false);
        sync_cache_to_server(&cache_path, &server_path, &app_clone, &channel_clone, &no_abort)
    })
    .await
    .map_err(|e| format!("Sync task panicked: {e}"))?
    .map_err(|e| format!("Failed to sync after validate: {e}"))?;

    emit_line(&app_handle, &channel, "stdout", "Server files validated and synced.")?;
    Ok(())
}

/// Compare the cached build ID against the Steam UpToDateCheck API.
/// Does NOT run SteamCMD — this is a lightweight read-only check.
#[tauri::command]
pub async fn check_asa_update(cache_dir: String) -> Result<UpdateCheckResult, String> {
    let acf_path = Path::new(&cache_dir).join(ACF_REL_PATH);
    let cached_build_id = read_acf_build_id(&acf_path).unwrap_or_else(|| "0".to_string());

    // The Steam UpToDateCheck API rejects version=0 with success=false.
    // When the cache ACF does not exist yet, fall back to "1" so the API
    // returns the actual latest build ID in required_version.
    let query_version = if cached_build_id == "0" { "1" } else { &cached_build_id };

    let url = format!(
        "https://api.steampowered.com/ISteamApps/UpToDateCheck/v1/?appid={}&version={}&format=json",
        ASA_SERVER_APP_ID, query_version
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Steam API request failed: {e}"))?;

    let data: SteamUpToDateCheck = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Steam API response: {e}"))?;

    if !data.response.success {
        return Err("Steam API returned success=false".to_string());
    }

    let latest_build_id = if !data.response.up_to_date {
        data.response
            .required_version
            .map(|v| v.to_string())
            .unwrap_or_else(|| cached_build_id.clone())
    } else {
        cached_build_id.clone()
    };

    Ok(UpdateCheckResult {
        update_available: !data.response.up_to_date,
        cached_build_id,
        latest_build_id,
    })
}

/// Read the build ID installed at a specific server path.
/// Returns None if the server has never been installed (no ACF file).
#[tauri::command]
pub async fn get_installed_build_id(install_path: String) -> Result<Option<String>, String> {
    let acf_path = Path::new(&install_path).join(ACF_REL_PATH);
    Ok(read_acf_build_id(&acf_path))
}

/// Abort/mutex key shared by the manual "Check for Updates" flow and the
/// scheduled background check — both call `update_cache_inner` under this
/// same key so only one SteamCMD cache check can ever run at a time.
pub const ASA_CACHE_CHECK_KEY: &str = "check";

/// Run SteamCMD to update the shared cache only. Returns the new build ID.
/// Streams output to `steamcmd://output/{server_id}`.
#[tauri::command]
pub async fn update_cache(
    server_id: String,
    cache_dir: String,
    steamcmd_path: String,
    state: tauri::State<'_, crate::state::AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    update_cache_inner(&server_id, &cache_dir, &steamcmd_path, &state, &app_handle).await
}

/// Shared implementation behind `update_cache` — extracted so the scheduled
/// background check (`fire_global_update_check` in scheduler.rs) can reuse
/// the exact same mutual-exclusion guard instead of running its own
/// independent, un-coordinated SteamCMD invocation against the same cache dir.
pub async fn update_cache_inner(
    server_id: &str,
    cache_dir: &str,
    steamcmd_path: &str,
    state: &crate::state::AppState,
    app_handle: &tauri::AppHandle,
) -> Result<String, String> {
    {
        let flags = state.abort_flags.lock().unwrap();
        if flags.contains_key(server_id) {
            return Err("An ASA update check is already in progress".into());
        }
    }

    let channel = format!("{}/{}", events::STEAMCMD_OUTPUT, server_id);
    let abort = state.register_abort(server_id);

    let result: Result<String, String> = async {
        emit_line(app_handle, &channel, "stdout", "Updating server cache from Steam…")?;
        tokio::fs::create_dir_all(&cache_dir)
            .await
            .map_err(|e| format!("Failed to create cache directory: {e}"))?;

        steamcmd_app_update(
            app_handle,
            steamcmd_path,
            cache_dir,
            false,
            &channel,
            Some(std::sync::Arc::clone(&abort)),
        )
        .await?;

        let acf_path = Path::new(cache_dir).join(ACF_REL_PATH);
        let build_id = read_acf_build_id(&acf_path).unwrap_or_else(|| "0".to_string());

        emit_line(app_handle, &channel, "stdout", &format!("Cache updated to build {build_id}."))?;

        if build_id != "0" {
            crate::commands::build_version::maybe_fetch_internet(app_handle, &build_id);
        }

        Ok(build_id)
    }
    .await;

    state.clear_abort(server_id);
    result
}

/// Copy the shared cache to a specific server directory without re-running SteamCMD.
/// Preserves ShooterGame/Saved so player data is never overwritten.
/// Streams output to `steamcmd://output/{server_id}`.
/// Abort key: "server_{server_id}" — matches `install_server`/`update_server` so
/// `get_running_ops` and `abort_operation` behave consistently across all three.
#[tauri::command]
pub async fn apply_cache_to_server(
    server_id: String,
    install_path: String,
    cache_dir: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<(), String> {
    let op_key = format!("server_{server_id}");
    let abort = state.register_abort(&op_key);
    let channel = format!("{}/{}", events::STEAMCMD_OUTPUT, server_id);

    let result = async {
        emit_line(&app_handle, &channel, "stdout",
            "Syncing updated files to server (preserving Saved/ data)…")?;

        let cache_path = std::path::PathBuf::from(&cache_dir);
        let server_path = std::path::PathBuf::from(&install_path);
        let app_clone = app_handle.clone();
        let channel_clone = channel.clone();
        let abort_clone = std::sync::Arc::clone(&abort);

        tokio::task::spawn_blocking(move || {
            sync_cache_to_server(&cache_path, &server_path, &app_clone, &channel_clone, &abort_clone)
        })
        .await
        .map_err(|e| format!("Sync task panicked: {e}"))?
        .map_err(|e| format!("Failed to sync server files: {e}"))?;

        // Record updated build ID for version tracking
        let acf = std::path::Path::new(&install_path).join(ACF_REL_PATH);
        if let Some(build_id) = read_acf_build_id(&acf) {
            crate::commands::build_version::record_install(&app_handle, &server_id, &build_id);
        }

        emit_line(&app_handle, &channel, "stdout", "Server update applied.")?;
        Ok(())
    }
    .await;

    state.clear_abort(&op_key);
    result
}

/// Inspect an existing installation folder: checks for the server executable and
/// parses GameUserSettings.ini to pre-fill the import wizard form.
#[tauri::command]
pub async fn detect_server_install(install_path: String) -> Result<DetectedServerConfig, String> {
    let base = Path::new(&install_path);

    let exe_found = base.join("ShooterGame/Binaries/Win64/ArkAscendedServer.exe").exists();
    let build_id = read_acf_build_id(&base.join(ACF_REL_PATH));

    let gus_path = base.join("ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini");
    if !gus_path.exists() {
        return Ok(DetectedServerConfig {
            exe_found,
            session_name: None,
            port: None,
            query_port: None,
            rcon_port: None,
            admin_password: None,
            server_password: None,
            max_players: None,
            build_id,
        });
    }

    let ini = parse_gus_ini(&gus_path);
    let get = |section: &str, key: &str| -> Option<String> {
        ini.get(section)?.get(key).cloned()
    };

    Ok(DetectedServerConfig {
        exe_found,
        session_name:   get("SessionSettings", "SessionName"),
        port:           get("URL", "Port").and_then(|v| v.parse().ok()),
        query_port:     get("SessionSettings", "QueryPort").and_then(|v| v.parse().ok()),
        rcon_port:      get("RCONEnabled", "RCONPort")
                            .or_else(|| get("ServerSettings", "RCONPort"))
                            .and_then(|v| v.parse().ok()),
        admin_password: get("ServerSettings", "ServerAdminPassword"),
        server_password:get("ServerSettings", "ServerPassword"),
        max_players:    get("GameSession", "MaxPlayers")
                            .or_else(|| get("ServerSettings", "MaxPlayers"))
                            .and_then(|v| v.parse().ok()),
        build_id,
    })
}
