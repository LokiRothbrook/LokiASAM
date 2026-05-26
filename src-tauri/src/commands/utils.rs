use std::path::Path;
use std::process::Stdio;
use tauri::Emitter;
use tokio::io::BufReader;
use tokio::process::Command;

// ---------------------------------------------------------------------------
// SteamCMD helpers
// ---------------------------------------------------------------------------

/// Build a `tokio::process::Command` for SteamCMD with piped stdout/stderr
/// and, on Windows, the CREATE_NO_WINDOW flag so no console flashes.
pub fn build_steamcmd_cmd(path: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new(path);
    cmd.args(args);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    cmd
}

/// Payload emitted per output line on a SteamCMD event channel.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct SteamCmdLine {
    pub line: String,
    pub stream: String,
}

/// Emit a single text line as a SteamCMD output event.
pub fn emit_line(
    app: &tauri::AppHandle,
    channel: &str,
    stream: &str,
    line: &str,
) -> Result<(), String> {
    app.emit(channel, SteamCmdLine {
        line: line.to_string(),
        stream: stream.to_string(),
    })
    .map_err(|e| e.to_string())
}

/// Stream stdout + stderr from a child process to a Tauri event channel.
/// Returns the raw process exit code.
pub async fn stream_process(
    app: &tauri::AppHandle,
    child: &mut tokio::process::Child,
    channel: &str,
) -> Result<i32, String> {
    use tokio::io::AsyncBufReadExt;

    let stdout = child.stdout.take().ok_or("failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("failed to capture stderr")?;

    let mut out_lines = BufReader::new(stdout).lines();
    let mut err_lines = BufReader::new(stderr).lines();

    let app_out = app.clone();
    let ch_out = channel.to_string();
    let stdout_task = tauri::async_runtime::spawn(async move {
        while let Ok(Some(l)) = out_lines.next_line().await {
            let _ = emit_line(&app_out, &ch_out, "stdout", &l);
        }
    });

    let app_err = app.clone();
    let ch_err = channel.to_string();
    let stderr_task = tauri::async_runtime::spawn(async move {
        while let Ok(Some(l)) = err_lines.next_line().await {
            let _ = emit_line(&app_err, &ch_err, "stderr", &l);
        }
    });

    let _ = tokio::join!(stdout_task, stderr_task);
    let status = child.wait().await.map_err(|e| e.to_string())?;
    Ok(status.code().unwrap_or(-1))
}

// ---------------------------------------------------------------------------
// File system helpers
// ---------------------------------------------------------------------------

/// Recursively copy `src` into `dst`, skipping any top-level entry whose name
/// case-insensitively matches a name in `skip_rel`.
/// Creates `dst` if it doesn't exist; existing files in `dst` are overwritten.
pub fn copy_dir_recursive(src: &Path, dst: &Path, skip_rel: &[&str]) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let name_str = file_name.to_string_lossy();

        if skip_rel.iter().any(|s| name_str.eq_ignore_ascii_case(s)) {
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

/// Async version of `copy_dir_recursive` — all I/O runs on the async executor.
/// Runs in an infinite-depth recursion via `Box::pin`; suitable for smaller
/// trees (mod directories).  For very large trees (server installs) prefer
/// `spawn_blocking` + `copy_dir_recursive`.
pub async fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    tokio::fs::create_dir_all(dst)
        .await
        .map_err(|e| format!("create_dir {}: {e}", dst.display()))?;

    let mut entries = tokio::fs::read_dir(src)
        .await
        .map_err(|e| format!("read_dir {}: {e}", src.display()))?;

    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let ft = entry.file_type().await.map_err(|e| e.to_string())?;
        let src_p = entry.path();
        let dst_p = dst.join(entry.file_name());
        if ft.is_dir() {
            Box::pin(copy_dir_all(&src_p, &dst_p)).await?;
        } else {
            tokio::fs::copy(&src_p, &dst_p)
                .await
                .map_err(|e| format!("copy {} → {}: {e}", src_p.display(), dst_p.display()))?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Process tree helpers
// ---------------------------------------------------------------------------

/// BFS walk of the sysinfo process table starting at `root`.
/// Returns every PID in the subtree (including `root` itself).
/// A visited-set prevents infinite loops from circular parent links.
pub fn collect_subtree(sys: &sysinfo::System, root: sysinfo::Pid) -> Vec<sysinfo::Pid> {
    use std::collections::HashSet;
    let mut all = vec![root];
    let mut queue = vec![root];
    let mut visited: HashSet<sysinfo::Pid> = std::iter::once(root).collect();

    while let Some(parent) = queue.pop() {
        for (pid, proc) in sys.processes() {
            if proc.parent() == Some(parent) && visited.insert(*pid) {
                all.push(*pid);
                queue.push(*pid);
            }
        }
    }
    all
}
