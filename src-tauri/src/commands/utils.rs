use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
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

/// Like `stream_process` but kills the child and returns an "Aborted" error if
/// `abort` is set to true before the process exits.
pub async fn stream_process_abortable(
    app: &tauri::AppHandle,
    child: &mut tokio::process::Child,
    channel: &str,
    abort: Arc<std::sync::atomic::AtomicBool>,
) -> Result<i32, String> {
    use tokio::io::AsyncBufReadExt;
    use std::sync::atomic::Ordering;

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

    loop {
        if abort.load(Ordering::Relaxed) {
            // Kill the full process tree so SteamCMD child processes don't
            // continue running after the parent is killed.
            if let Some(raw_pid) = child.id() {
                use sysinfo::{Pid, ProcessesToUpdate, System};
                let mut sys = System::new();
                sys.refresh_processes(ProcessesToUpdate::All, false);
                let root = Pid::from_u32(raw_pid);
                for pid in collect_subtree(&sys, root) {
                    if let Some(proc) = sys.process(pid) {
                        proc.kill();
                    }
                }
            }
            stdout_task.abort();
            stderr_task.abort();
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err("Aborted".into());
        }
        // Poll for exit with a short sleep so we don't busy-wait.
        match tokio::time::timeout(
            std::time::Duration::from_millis(250),
            child.wait(),
        ).await {
            Ok(Ok(status)) => {
                let _ = tokio::join!(stdout_task, stderr_task);
                return Ok(status.code().unwrap_or(-1));
            }
            Ok(Err(e)) => return Err(e.to_string()),
            Err(_) => { /* still running, loop */ }
        }
    }
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

// ---------------------------------------------------------------------------
// Linux process helpers — powered by the procfs crate
// ---------------------------------------------------------------------------
//
// The procfs crate reads /proc directly with proper kernel-version handling and
// correct type conversions — replacing hand-rolled string parsing.
//
// Wine-preloader replaces its cmdline via prctl(PR_SET_MM_ARG_*) and reports
// the Windows exe path in Z:\ form.  sysinfo may not discover these processes
// reliably (re-parented to PID 1 by the Steam Runtime container); procfs reads
// /proc directly and always finds them.

/// Return true if `pid` is the main thread (process leader) of its process.
///
/// On Linux, every thread has its own TID in /proc with the same virtual address
/// space as the process leader.  Summing smaps_rollup across all TIDs would
/// multiply-count the same memory (e.g. 50 Wine threads × 7 GB = 350 GB).
/// We only count process leaders (Tgid == Pid).
#[cfg(target_os = "linux")]
pub fn is_process_leader(pid: u32) -> bool {
    procfs::process::Process::new(pid as i32)
        .and_then(|p| p.status())
        .map(|s| s.pid == s.tgid)
        .unwrap_or(true) // assume leader if /proc is unreadable
}

/// Find the PID of the ArkAscendedServer.exe wine process for `install_path`.
///
/// Returns the wine-preloader process leader — the process btop shows as
/// "ArkAscendedServ" or "GameThread".  By scanning cmdline we find it even
/// when it has been re-parented to PID 1 by the Steam Runtime container.
///
/// Returns None if the game hasn't launched yet.
#[cfg(target_os = "linux")]
pub fn find_game_process_pid(install_path: &str) -> Option<u32> {
    let base         = install_path.trim_end_matches('/').to_lowercase();
    let needle_linux = format!("{}/", base);
    let needle_wine  = format!("z:{}\\" , base.replace('/', "\\"));
    let needle_exe   = "arkascendedserver.exe";

    for proc_result in procfs::process::all_processes().ok()? {
        let Ok(proc) = proc_result else { continue };
        // cmdline args are NUL-separated; join them for a single search string.
        let Ok(cmd) = proc.cmdline() else { continue };
        let flat = cmd.join("\0").to_lowercase();

        if !flat.contains(needle_exe) { continue; }
        if !flat.contains(&needle_linux) && !flat.contains(&needle_wine) { continue; }

        // Process leader only — skip wine thread TIDs that share the same cmdline.
        let Ok(status) = proc.status() else { continue };
        if status.pid == status.tgid {
            return Some(proc.pid as u32);
        }
    }
    None
}

/// Collect every process-leader PID whose cmdline references `install_path`.
///
/// Matches both the Linux path form (`/home/…/server/`) and the Wine Z:\ form.
/// Non-main threads are excluded so smaps_rollup is summed once per process.
#[cfg(target_os = "linux")]
pub fn find_pids_by_install_path(install_path: &str) -> Vec<u32> {
    if install_path.is_empty() {
        return Vec::new();
    }
    let base         = install_path.trim_end_matches('/').to_lowercase();
    let needle_linux = format!("{}/", base);
    let needle_wine  = format!("z:{}\\" , base.replace('/', "\\"));

    let Ok(procs) = procfs::process::all_processes() else { return Vec::new(); };
    let mut out = Vec::new();

    for proc_result in procs {
        let Ok(proc) = proc_result else { continue };
        let Ok(cmd)  = proc.cmdline() else { continue };
        let flat = cmd.join("\0").to_lowercase();

        if !flat.contains(&needle_linux) && !flat.contains(&needle_wine) { continue; }

        let Ok(status) = proc.status() else { continue };
        if status.pid == status.tgid {
            out.push(proc.pid as u32);
        }
    }
    out
}

/// Read PSS (Proportional Set Size) in bytes for `pid` via procfs.
///
/// PSS divides each shared page by the number of processes that map it, giving
/// the true unique footprint without double-counting shared Wine/game mappings.
/// Falls back to RSS if smaps_rollup is unavailable (kernel < 4.14).
///
/// In procfs 0.17, SmapsRollup wraps a MemoryMaps (Vec<MemoryMap>).
/// The rollup has one entry whose extension.map holds the aggregated stats
/// in bytes (the parser converts the kernel's "kB" values automatically).
#[cfg(target_os = "linux")]
pub fn read_proc_pss_bytes(pid: u32) -> u64 {
    let Ok(proc) = procfs::process::Process::new(pid as i32) else { return 0; };

    if let Ok(rollup) = proc.smaps_rollup() {
        if let Some(first) = rollup.memory_map_rollup.0.first() {
            if let Some(&pss) = first.extension.map.get("Pss") {
                return pss; // already in bytes — parser applied the kB multiplier
            }
        }
    }

    // Fallback: VmRSS from /proc/{pid}/status (vmrss is in kB).
    proc.status()
        .ok()
        .and_then(|s| s.vmrss)
        .unwrap_or(0)
        * 1024
}

/// Send SIGTERM (graceful=true) or SIGKILL (graceful=false) to `pid`
/// via a direct libc call — works even for processes sysinfo hasn't indexed.
#[cfg(target_os = "linux")]
pub fn signal_pid(pid: u32, graceful: bool) {
    extern "C" { fn kill(pid: i32, sig: i32) -> i32; }
    let sig = if graceful { 15 } else { 9 }; // SIGTERM / SIGKILL
    unsafe { kill(pid as i32, sig); }
}

/// Wrapper kept for callers in server.rs / system.rs that already pass `sys`.
/// Delegates to the procfs-based /proc reader — sysinfo is not used.
#[cfg(target_os = "linux")]
pub fn collect_by_install_path(_sys: &sysinfo::System, install_path: &str) -> Vec<sysinfo::Pid> {
    find_pids_by_install_path(install_path)
        .into_iter()
        .map(sysinfo::Pid::from_u32)
        .collect()
}
