use std::path::PathBuf;
use tokio::process::Command;

const AMAZON_ROOT_CA1_URL: &str =
    "https://www.amazontrust.com/repository/AmazonRootCA1.cer";

const CERT_MARKER_FILENAME: &str = ".amazon_root_ca_installed";

// ── Download ─────────────────────────────────────────────────────────────────

/// Downloads the Amazon Root CA 1 certificate to `{temp_dir}/AmazonRootCA1.cer`
/// and returns the full path to the saved file.
#[tauri::command]
pub async fn download_amazon_root_ca(temp_dir: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("LokiASAM/0.1")
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let bytes = client
        .get(AMAZON_ROOT_CA1_URL)
        .send()
        .await
        .map_err(|e| format!("Failed to download certificate: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Certificate download returned error: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("Failed to read certificate bytes: {e}"))?;

    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| format!("Failed to create temp directory: {e}"))?;

    let cert_path = PathBuf::from(&temp_dir).join("AmazonRootCA1.cer");
    tokio::fs::write(&cert_path, &bytes)
        .await
        .map_err(|e| format!("Failed to write certificate file: {e}"))?;

    cert_path
        .to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Certificate path contains invalid characters".to_string())
}

// ── Install ───────────────────────────────────────────────────────────────────

/// Installs the downloaded certificate into the system/Wine certificate store.
///
/// - Windows: installs into `CurrentUser\Root` via `certutil`. Windows will
///   show its standard trust-confirmation dialog; no elevation is needed.
/// - Linux: initialises the Proton Wine prefix if required, then installs via
///   the `wine64` binary bundled with Proton-GE.
///
/// On success, writes a marker file so `check_amazon_root_ca_installed` can
/// detect the installation without repeating the cert-store query.
#[tauri::command]
pub async fn install_amazon_root_ca(
    cert_path: String,
    proton_path: Option<String>,
    prefix_path: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        install_windows(&cert_path).await?;
    }

    #[cfg(target_os = "linux")]
    {
        let proton = proton_path
            .as_deref()
            .filter(|s| !s.is_empty())
            .ok_or("Proton-GE path is required on Linux")?;
        let prefix = prefix_path
            .as_deref()
            .filter(|s| !s.is_empty())
            .ok_or("Wine prefix path is required on Linux")?;
        install_linux(&cert_path, proton, prefix).await?;
    }

    // Suppress "unused variable" warnings on each platform.
    let _ = (&cert_path, &proton_path, &prefix_path);

    Ok(())
}

#[cfg(target_os = "windows")]
async fn install_windows(cert_path: &str) -> Result<(), String> {
    let status = Command::new("certutil")
        .args(["-addstore", "-user", "Root", cert_path])
        .status()
        .await
        .map_err(|e| format!("Failed to run certutil: {e}"))?;

    if !status.success() {
        return Err(format!(
            "certutil exited with code {}",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
async fn install_linux(cert_path: &str, proton_path: &str, prefix_path: &str) -> Result<(), String> {
    let proton_script = format!("{proton_path}/proton");
    let wine_bin      = format!("{proton_path}/files/bin/wine64");
    let wine_pfx      = format!("{prefix_path}/pfx");
    let marker        = PathBuf::from(prefix_path).join(CERT_MARKER_FILENAME);

    // Initialise the Wine prefix if it has not been set up yet.
    // Use the Proton run script (same mechanism as server start) rather than
    // wine64 directly — Proton-GE's wine64 is compiled for the Steam Linux
    // Runtime and may fail outside it. `proton run` handles environment setup.
    // Setting STEAM_COMPAT_CLIENT_INSTALL_PATH to a dummy value prevents
    // Proton from trying to use the Steam Runtime daemon when Steam is installed.
    let system_reg = format!("{wine_pfx}/system.reg");
    if !tokio::fs::try_exists(&system_reg).await.unwrap_or(false) {
        // Create parent directories so Proton can create the pfx inside.
        tokio::fs::create_dir_all(&wine_pfx)
            .await
            .map_err(|e| format!("Failed to create prefix directory: {e}"))?;

        let status = Command::new(&proton_script)
            .arg("run")
            .arg("C:\\windows\\system32\\wineboot.exe")
            .env("STEAM_COMPAT_DATA_PATH", prefix_path)
            .env("STEAM_COMPAT_CLIENT_INSTALL_PATH", "/")
            .env("WINEDLLOVERRIDES", "mscoree,mshtml=")
            .env("WINEDEBUG", "-all")
            .env("PROTON_LOG", "0")
            .status()
            .await
            .map_err(|e| format!("Failed to run proton wineboot: {e}"))?;

        // Proton may exit non-zero even on success (wineboot is a short-lived
        // process). Check that the prefix was actually created instead.
        if !tokio::fs::try_exists(&system_reg).await.unwrap_or(false) {
            return Err(format!(
                "Wine prefix initialisation failed (proton exited {}); try starting a server once first.",
                status.code().unwrap_or(-1)
            ));
        }
    }

    // Install the certificate into Wine's CurrentUser\Root store.
    // At this point the prefix exists, so wine64 can run standalone.
    let status = Command::new(&wine_bin)
        .args(["certutil", "-addstore", "Root", cert_path])
        .env("WINEPREFIX", &wine_pfx)
        .env("WINEDEBUG", "-all")
        .status()
        .await
        .map_err(|e| format!("Failed to run wine certutil: {e}"))?;

    if !status.success() {
        return Err(format!(
            "wine certutil exited with code {}",
            status.code().unwrap_or(-1)
        ));
    }

    // Write marker so future checks are instant.
    let _ = tokio::fs::write(&marker, b"1").await;

    Ok(())
}

// ── Check ─────────────────────────────────────────────────────────────────────

/// Returns `true` if the Amazon Root CA 1 certificate is already installed.
///
/// - Windows: queries the `CurrentUser\Root` store for the cert subject.
/// - Linux: checks for the marker file written by a previous successful install.
#[tauri::command]
pub async fn check_amazon_root_ca_installed(
    proton_path: Option<String>,
    prefix_path: Option<String>,
) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let _ = (&proton_path, &prefix_path);
        return check_windows().await;
    }

    #[cfg(target_os = "linux")]
    {
        let prefix = prefix_path.as_deref().filter(|s| !s.is_empty());
        let _ = &proton_path;
        return check_linux(prefix).await;
    }

    #[allow(unreachable_code)]
    Ok(false)
}

#[cfg(target_os = "windows")]
async fn check_windows() -> Result<bool, String> {
    // List CurrentUser\Root store and search for Amazon Root CA 1 subject.
    let output = Command::new("certutil")
        .args(["-store", "-user", "Root"])
        .output()
        .await
        .map_err(|e| format!("Failed to run certutil: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.contains("Amazon Root CA 1"))
}

#[cfg(target_os = "linux")]
async fn check_linux(prefix_path: Option<&str>) -> Result<bool, String> {
    let Some(prefix) = prefix_path else {
        return Ok(false);
    };
    let marker = PathBuf::from(prefix).join(CERT_MARKER_FILENAME);
    Ok(tokio::fs::try_exists(&marker).await.unwrap_or(false))
}
