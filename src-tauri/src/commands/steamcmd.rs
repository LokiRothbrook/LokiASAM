use crate::events;
use std::path::Path;

use super::utils::{build_steamcmd_cmd, copy_dir_recursive, emit_line, stream_process};

/// ASA Dedicated Server Steam App ID.
const ASA_SERVER_APP_ID: &str = "2430930";

/// Relative path to the appmanifest ACF inside a Steam install directory.
const ACF_REL_PATH: &str = "steamapps/appmanifest_2430930.acf";

// ---------------------------------------------------------------------------
// ACF / INI helpers
// ---------------------------------------------------------------------------

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
    up_to_date: bool,
    #[serde(default)]
    required_version: Option<u64>,
}

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

/// Compare the cached build ID against the Steam UpToDateCheck API.
/// Does NOT run SteamCMD — this is a lightweight read-only check.
#[tauri::command]
pub async fn check_asa_update(cache_dir: String) -> Result<UpdateCheckResult, String> {
    let acf_path = Path::new(&cache_dir).join(ACF_REL_PATH);
    let cached_build_id = read_acf_build_id(&acf_path).unwrap_or_else(|| "0".to_string());

    let url = format!(
        "https://api.steampowered.com/ISteamApps/UpToDateCheck/v1/?appid={}&version={}&format=json",
        ASA_SERVER_APP_ID, cached_build_id
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

/// Run SteamCMD to update the shared cache only. Returns the new build ID.
/// Streams output to `steamcmd://output/{server_id}`.
#[tauri::command]
pub async fn update_cache(
    server_id: String,
    cache_dir: String,
    steamcmd_path: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let channel = format!("{}/{}", events::STEAMCMD_OUTPUT, server_id);

    emit_line(&app_handle, &channel, "stdout", "Updating server cache from Steam…")?;
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| format!("Failed to create cache directory: {e}"))?;

    steamcmd_app_update(&app_handle, &steamcmd_path, &cache_dir, false, &channel).await?;

    let acf_path = Path::new(&cache_dir).join(ACF_REL_PATH);
    let build_id = read_acf_build_id(&acf_path).unwrap_or_else(|| "0".to_string());

    emit_line(&app_handle, &channel, "stdout", &format!("Cache updated to build {build_id}."))?;
    Ok(build_id)
}

/// Copy the shared cache to a specific server directory without re-running SteamCMD.
/// Preserves ShooterGame/Saved so player data is never overwritten.
/// Streams output to `steamcmd://output/{server_id}`.
#[tauri::command]
pub async fn apply_cache_to_server(
    server_id: String,
    install_path: String,
    cache_dir: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let channel = format!("{}/{}", events::STEAMCMD_OUTPUT, server_id);

    emit_line(&app_handle, &channel, "stdout",
        "Syncing updated files to server (preserving Saved/ data)…")?;

    let cache_path = std::path::PathBuf::from(&cache_dir);
    let server_path = std::path::PathBuf::from(&install_path);

    tokio::task::spawn_blocking(move || sync_cache_to_server(&cache_path, &server_path))
        .await
        .map_err(|e| format!("Sync task panicked: {e}"))?
        .map_err(|e| format!("Failed to sync server files: {e}"))?;

    emit_line(&app_handle, &channel, "stdout", "Server update applied.")?;
    Ok(())
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
