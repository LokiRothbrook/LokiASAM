//! Invisible X display for servers with "Hide server window" on (Linux).
//!
//! ASA under Wine needs a real display to start — Wine's null graphics driver
//! leaves it hung early in startup. So hidden servers get a real X display
//! that just isn't on any screen: one shared Xvfb (preferred, lightweight) or,
//! if only gamescope is installed, one headless gamescope session. Hidden
//! servers run in their own Wine prefix pointed at that display (a prefix is
//! tied to the display its first process used).

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Xvfb,
    Gamescope,
}

/// What the frontend shows on the Hide Server Window toggle.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HiddenWindowSupport {
    /// "native" on Windows (no-console flag), "xvfb"/"gamescope" on Linux, or
    /// null when nothing usable is installed.
    pub backend: Option<String>,
    /// Distro name for the install hint, e.g. "CachyOS".
    pub distro: Option<String>,
    /// Shell command to install Xvfb, shown with a Copy button.
    pub install_command: Option<String>,
    /// True when the Install button can run the command via pkexec.
    pub can_auto_install: bool,
    /// Why installing isn't offered (immutable OS, unknown distro).
    pub install_note: Option<String>,
}

/// Search PATH (the pre-AppImage PATH when running as an AppImage).
fn which(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("APPIMAGE_ORIGINAL_PATH").or_else(|| std::env::var_os("PATH"))?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(bin))
        .find(|p| p.is_file())
}

/// The backend to use: Xvfb when installed (lighter), else gamescope.
pub fn detect_backend() -> Option<Backend> {
    if which("Xvfb").is_some() {
        Some(Backend::Xvfb)
    } else if which("gamescope").is_some() {
        Some(Backend::Gamescope)
    } else {
        None
    }
}

// ── Install help ─────────────────────────────────────────────────────────────

struct Distro {
    name: String,
    /// Package-manager argv (run as root) to install Xvfb.
    install: Option<Vec<&'static str>>,
    note: Option<String>,
}

fn detect_distro() -> Distro {
    let text = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
    let field = |key: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(&format!("{key}=")))
            .map(|v| v.trim_matches('"').to_string())
            .unwrap_or_default()
    };
    let id = field("ID").to_lowercase();
    let like = field("ID_LIKE").to_lowercase();
    let name = Some(field("PRETTY_NAME")).filter(|n| !n.is_empty()).unwrap_or_else(|| id.clone());
    let is = |family: &str| id == family || like.split_whitespace().any(|l| l == family);

    // Image-based systems: packages can't simply be installed.
    if Path::new("/run/ostree-booted").exists() || id == "steamos" {
        return Distro {
            name,
            install: None,
            note: Some("This system is image-based, so packages can't be installed the usual way. Most such systems already include gamescope.".into()),
        };
    }

    let install = if is("arch") {
        Some(vec!["pacman", "-S", "--needed", "--noconfirm", "xorg-server-xvfb"])
    } else if is("debian") || is("ubuntu") {
        Some(vec!["apt-get", "install", "-y", "xvfb"])
    } else if is("fedora") || is("rhel") {
        Some(vec!["dnf", "install", "-y", "xorg-x11-server-Xvfb"])
    } else if is("suse") || id.starts_with("opensuse") {
        Some(vec!["zypper", "--non-interactive", "install", "xorg-x11-server-Xvfb"])
    } else {
        None
    };
    let note = install.is_none().then(|| "Install your distribution's Xvfb package (often named xvfb or xorg-server-xvfb).".to_string());
    Distro { name, install, note }
}

#[tauri::command]
pub fn get_hidden_window_support() -> HiddenWindowSupport {
    if cfg!(target_os = "windows") {
        return HiddenWindowSupport {
            backend: Some("native".into()),
            distro: None,
            install_command: None,
            can_auto_install: false,
            install_note: None,
        };
    }
    let backend = detect_backend().map(|b| match b {
        Backend::Xvfb => "xvfb".to_string(),
        Backend::Gamescope => "gamescope".to_string(),
    });
    let distro = detect_distro();
    HiddenWindowSupport {
        backend,
        install_command: distro.install.as_ref().map(|argv| format!("sudo {}", argv.join(" "))),
        can_auto_install: distro.install.is_some() && which("pkexec").is_some(),
        install_note: distro.note,
        distro: Some(distro.name),
    }
}

/// Install Xvfb with the system's package manager, via pkexec (graphical
/// password prompt).
#[tauri::command]
pub async fn install_xvfb() -> Result<(), String> {
    let argv = detect_distro().install.ok_or("No supported package manager found for this system.")?;
    let pkexec = which("pkexec").ok_or("pkexec is not available — run the install command in a terminal instead.")?;
    let out = tokio::process::Command::new(pkexec)
        .args(&argv)
        .output()
        .await
        .map_err(|e| format!("Failed to run the installer: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    // 126/127: the password prompt was dismissed or authorization failed.
    if matches!(out.status.code(), Some(126) | Some(127)) {
        return Err("Installation was cancelled.".into());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let tail: String = stderr.trim().lines().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
    Err(format!("Installer failed: {tail}"))
}

// ── The shared invisible display ─────────────────────────────────────────────

#[cfg(unix)]
/// Serializes display startup so concurrent hidden-server starts share one.
static DISPLAY_LOCK: Mutex<()> = Mutex::new(());

#[cfg(unix)]
/// Records the running display so it's reused across app restarts (hidden
/// servers keep running when the app closes, and so must their display).
fn state_file() -> PathBuf {
    std::env::temp_dir().join("lokiasam-hidden-display")
}

#[cfg(unix)]
fn x_socket(display: &str) -> PathBuf {
    PathBuf::from(format!("/tmp/.X11-unix/X{}", display.trim_start_matches(':')))
}

#[cfg(unix)]
fn pid_is(pid: u32, bin: &str) -> bool {
    std::fs::read(format!("/proc/{pid}/cmdline"))
        .map(|c| String::from_utf8_lossy(&c).contains(bin))
        .unwrap_or(false)
}

#[cfg(unix)]
/// The recorded display, if its process is still alive and serving it.
fn existing_display() -> Option<String> {
    let text = std::fs::read_to_string(state_file()).ok()?;
    let mut parts = text.split_whitespace();
    let (bin, pid, display) = (parts.next()?, parts.next()?.parse::<u32>().ok()?, parts.next()?);
    (pid_is(pid, bin) && x_socket(display).exists()).then(|| display.to_string())
}

#[cfg(unix)]
/// Spawn detached in its own process group, with the AppImage environment
/// undone (same reasoning as the server launch in server.rs).
fn spawn_detached(mut cmd: std::process::Command) -> Result<std::process::Child, String> {
    use std::os::unix::process::CommandExt;
    if std::env::var_os("APPIMAGE").is_some() {
        match std::env::var("APPIMAGE_ORIGINAL_LD_LIBRARY_PATH") {
            Ok(orig) => { cmd.env("LD_LIBRARY_PATH", orig); }
            Err(_) => { cmd.env_remove("LD_LIBRARY_PATH"); }
        }
        if let Ok(orig_path) = std::env::var("APPIMAGE_ORIGINAL_PATH") {
            cmd.env("PATH", orig_path);
        }
        cmd.env_remove("PYTHONHOME");
        cmd.env_remove("PYTHONPATH");
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("Failed to start the virtual display: {e}"))
}

#[cfg(unix)]
fn wait_for(cond: impl Fn() -> bool, secs: u64) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    while std::time::Instant::now() < deadline {
        if cond() { return true; }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    cond()
}

#[cfg(unix)]
fn start_xvfb() -> Result<(u32, String), String> {
    let n = (90..120)
        .find(|n| !Path::new(&format!("/tmp/.X{n}-lock")).exists() && !x_socket(&format!(":{n}")).exists())
        .ok_or("No free X display number for the virtual display.")?;
    let display = format!(":{n}");
    let mut cmd = std::process::Command::new(which("Xvfb").ok_or("Xvfb is not installed.")?);
    // Local socket only (-nolisten tcp); no auth needed for local clients.
    cmd.args([display.as_str(), "-screen", "0", "1280x720x24", "-nolisten", "tcp", "-ac"]);
    let child = spawn_detached(cmd)?;
    if !wait_for(|| x_socket(&display).exists(), 10) {
        return Err("The virtual display (Xvfb) didn't start.".into());
    }
    Ok((child.id(), display))
}

#[cfg(unix)]
fn start_gamescope() -> Result<(u32, String), String> {
    // gamescope runs one app; a placeholder that reports gamescope's X
    // display and then idles keeps the session alive for all hidden servers.
    let out = std::env::temp_dir().join("lokiasam-gamescope-display");
    let _ = std::fs::remove_file(&out);
    let mut cmd = std::process::Command::new(which("gamescope").ok_or("gamescope is not installed.")?);
    cmd.args(["--backend", "headless", "-w", "1280", "-h", "720", "--", "sh", "-c"])
        .arg(format!("printf '%s' \"$DISPLAY\" > '{}'; exec sleep infinity", out.display()));
    let child = spawn_detached(cmd)?;
    if !wait_for(|| std::fs::read_to_string(&out).map(|s| !s.trim().is_empty()).unwrap_or(false), 20) {
        return Err("The virtual display (gamescope) didn't start.".into());
    }
    let display = std::fs::read_to_string(&out).unwrap_or_default().trim().to_string();
    if !wait_for(|| x_socket(&display).exists(), 10) {
        return Err("The virtual display (gamescope) didn't start.".into());
    }
    Ok((child.id(), display))
}

#[cfg(unix)]
/// The DISPLAY value for hidden servers, starting the shared virtual display
/// if it isn't already running. Errors when no backend is installed.
pub fn ensure_display() -> Result<(Backend, String), String> {
    let _guard = DISPLAY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let backend = detect_backend().ok_or("Neither Xvfb nor gamescope is installed.")?;
    let bin = match backend { Backend::Xvfb => "Xvfb", Backend::Gamescope => "gamescope" };
    if let Some(display) = existing_display() {
        return Ok((backend, display));
    }
    let (pid, display) = match backend {
        Backend::Xvfb => start_xvfb()?,
        Backend::Gamescope => start_gamescope()?,
    };
    let _ = std::fs::write(state_file(), format!("{bin} {pid} {display}"));
    Ok((backend, display))
}
