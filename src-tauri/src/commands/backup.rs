use std::fs::{self, File};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;
use tokio::time::{timeout, sleep, Duration};
use uuid::Uuid;
use sevenz_rust::{SevenZWriter, SevenZArchiveEntry};

use crate::events;
use crate::state::rcon_pool::{RconCmd, RconPool};

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupRecord {
    pub id: String,
    pub server_id: String,
    pub file_path: String,
    pub file_size_bytes: u64,
    pub map_id: String,
    pub triggered_by: String,
    pub created_at: String,
    /// server | player | full | ini
    pub backup_type: String,
    /// Comma-separated tier flags: H, D, W, M — assigned by the frontend after creation.
    pub tiers: String,
    pub player_eosid: Option<String>,
    pub player_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupProgress {
    pub percent: f32,
    pub current_file: String,
    pub label: String,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Build a human-readable timestamp string for file/folder names.
/// Format: YYYY-MM-DD_HH-MM-SS
fn now_timestamp() -> (String, String) {
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (year, month, day, hh, mm, ss) = secs_to_parts(now_secs);
    let ts_file = format!("{year:04}-{month:02}-{day:02}_{hh:02}-{mm:02}-{ss:02}");
    let ts_iso  = format!("{year:04}-{month:02}-{day:02}T{hh:02}:{mm:02}:{ss:02}Z");
    (ts_file, ts_iso)
}

fn secs_to_parts(now_secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    let secs_per_day = 86_400u64;
    let days     = now_secs / secs_per_day;
    let day_secs = now_secs % secs_per_day;
    let (year, month, day) = days_to_ymd(days);
    let hh = day_secs / 3600;
    let mm = (day_secs % 3600) / 60;
    let ss = day_secs % 60;
    (year, month, day, hh, mm, ss)
}

fn days_to_ymd(mut days: u64) -> (u64, u64, u64) {
    days += 719_468;
    let era = days / 146_097;
    let doe = days % 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y   = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp  = (5 * doy + 2) / 153;
    let d   = doy - (153 * mp + 2) / 5 + 1;
    let m   = if mp < 10 { mp + 3 } else { mp - 9 };
    let y   = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

fn fmt_size(bytes: u64) -> String {
    if bytes >= 1_073_741_824 {
        format!("{:.1} GB", bytes as f64 / 1_073_741_824.0)
    } else if bytes >= 1_048_576 {
        format!("{:.1} MB", bytes as f64 / 1_048_576.0)
    } else {
        format!("{:.1} KB", bytes as f64 / 1_024.0)
    }
}

fn sanitize_name(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// Build a filename tier suffix like "-DH" from a tiers string like "D,H" or "H".
/// Tiers are sorted in canonical priority order (M W D H).
fn tier_suffix(tiers: &str) -> String {
    if tiers.is_empty() {
        return String::new();
    }
    const ORDER: &[char] = &['M', 'W', 'D', 'H'];
    let flags: Vec<char> = tiers.split(',')
        .filter_map(|t| t.trim().chars().next())
        .filter(|c| ORDER.contains(c))
        .collect();
    if flags.is_empty() {
        return String::new();
    }
    let mut sorted: Vec<char> = ORDER.iter().copied().filter(|c| flags.contains(c)).collect();
    sorted.dedup();
    format!("-{}", sorted.iter().collect::<String>())
}

/// Find and parse a `YYYY-MM-DD_HH-MM-SS` timestamp embedded in a filename stem.
/// Returns `(ts_iso, tiers_str)` where `tiers_str` may be empty for files without
/// the tier suffix (e.g. manual backups or pre-tier-feature archives).
pub fn parse_backup_filename(stem: &str) -> Option<(String, String)> {
    let bytes = stem.as_bytes();
    let len   = bytes.len();
    if len < 19 { return None; }

    for i in 0..=(len - 19) {
        let candidate = &stem[i..i + 19];
        if is_timestamp(candidate.as_bytes()) {
            let after = &stem[i + 19..];
            // After timestamp: either empty, or "-{MWDH letters}", or something else (no tier)
            let tiers = if let Some(rest) = after.strip_prefix('-') {
                if !rest.is_empty() && rest.chars().all(|c| matches!(c, 'M' | 'W' | 'D' | 'H')) {
                    rest.to_string()
                } else {
                    String::new()
                }
            } else {
                String::new()
            };
            // Convert YYYY-MM-DD_HH-MM-SS → YYYY-MM-DDTHH:MM:SSZ
            let ts_iso = format!(
                "{}T{}:{}:{}Z",
                &candidate[..10],
                &candidate[11..13],
                &candidate[14..16],
                &candidate[17..19],
            );
            return Some((ts_iso, tiers));
        }
    }
    None
}

fn is_timestamp(b: &[u8]) -> bool {
    if b.len() != 19 { return false; }
    b[4]  == b'-' && b[7]  == b'-' && b[10] == b'_' &&
    b[13] == b'-' && b[16] == b'-' &&
    b[..4].iter().all(|c| c.is_ascii_digit())   &&
    b[5..7].iter().all(|c| c.is_ascii_digit())  &&
    b[8..10].iter().all(|c| c.is_ascii_digit()) &&
    b[11..13].iter().all(|c| c.is_ascii_digit())&&
    b[14..16].iter().all(|c| c.is_ascii_digit())&&
    b[17..19].iter().all(|c| c.is_ascii_digit())
}

/// Recursively collect all file paths under `dir`.
fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            collect_files(&path, out)?;
        } else {
            out.push(path);
        }
    }
    Ok(())
}

fn emit_progress(app: &AppHandle, server_id: &str, percent: f32, file: &str, label: &str) {
    let _ = app.emit(
        &format!("{}/{}", events::BACKUP_PROGRESS, server_id),
        BackupProgress {
            percent,
            current_file: file.to_string(),
            label: label.to_string(),
        },
    );
}

/// Send SaveWorld through the managed RCON connection if one is live.
/// Falls back silently if RCON is not connected.
pub async fn rcon_save_world(pool: &RconPool, server_id: &str) -> Result<(), String> {
    let tx = {
        let guard = pool.cmd_channels.lock().await;
        guard.get(server_id).filter(|(tx, _)| !tx.is_closed()).map(|(tx, _)| tx.clone())
    };
    let Some(tx) = tx else { return Ok(()); };

    let (resp_tx, resp_rx) = oneshot::channel();
    tx.send(RconCmd::Execute {
        command:      "SaveWorld".to_string(),
        suppress_cmd: true,
        suppress_resp: true,
        response_tx:  resp_tx,
    })
    .await
    .map_err(|_| "RCON channel closed before SaveWorld".to_string())?;

    match timeout(Duration::from_secs(60), resp_rx).await {
        Ok(Ok(_))  => Ok(()),
        Ok(Err(_)) => Err("SaveWorld response channel dropped".to_string()),
        Err(_)     => Err("SaveWorld timed out after 60s".to_string()),
    }
}

/// Send an RCON ServerChat broadcast (fire-and-forget — never blocks the caller).
pub async fn rcon_broadcast(pool: &RconPool, server_id: &str, message: &str) {
    let tx = {
        let guard = pool.cmd_channels.lock().await;
        guard.get(server_id).filter(|(tx, _)| !tx.is_closed()).map(|(tx, _)| tx.clone())
    };
    let Some(tx) = tx else { return; };
    let (resp_tx, _resp_rx) = oneshot::channel();
    let _ = tx.send(RconCmd::Execute {
        command:      format!("ServerChat {message}"),
        suppress_cmd: false,
        suppress_resp: true,
        response_tx:  resp_tx,
    }).await;
}

/// Write `files` into a 7z archive at `dest_path`.
/// `root` is stripped from each file path to produce the archive entry name.
/// `alt_root` is an alternative root tried if primary root fails (used for mixed-source backups).
/// Emits progress events keyed on `server_id`.
/// Returns Ok(skipped_count) on success.  A non-zero skipped_count means some
/// files disappeared between enumeration and compression — the caller should
/// consider retrying with a fresh file list.
fn compress_to_7z(
    app: &AppHandle,
    server_id: &str,
    files: &[PathBuf],
    root: &Path,
    dest_path: &Path,
    label: &str,
) -> Result<usize, String> {
    compress_to_7z_with_alt_root(app, server_id, files, root, None, dest_path, label)
}

fn compress_to_7z_with_alt_root(
    app: &AppHandle,
    server_id: &str,
    files: &[PathBuf],
    root: &Path,
    alt_root: Option<&Path>,
    dest_path: &Path,
    label: &str,
) -> Result<usize, String> {
    compress_to_7z_with_entries(
        app,
        server_id,
        &files.iter().map(|f| (f.clone(), None)).collect::<Vec<_>>(),
        root,
        alt_root,
        dest_path,
        label,
    )
}

/// Compress files with explicit entry names for archive structure.
/// `entries` is a vec of (file_path, optional_custom_entry_name).
/// If custom entry name is None, it's calculated by stripping the root paths.
fn compress_to_7z_with_entries(
    app: &AppHandle,
    server_id: &str,
    entries: &[(PathBuf, Option<String>)],
    root: &Path,
    alt_root: Option<&Path>,
    dest_path: &Path,
    label: &str,
) -> Result<usize, String> {
    let total = entries.len().max(1) as f32;
    let mut writer = SevenZWriter::create(dest_path).map_err(|e| e.to_string())?;
    let mut skipped = 0usize;

    for (idx, (file_path, custom_entry)) in entries.iter().enumerate() {
        let entry_name = if let Some(custom) = custom_entry {
            custom.clone()
        } else {
            let rel = file_path
                .strip_prefix(root)
                .or_else(|_| {
                    alt_root.ok_or(()).and_then(|alt| file_path.strip_prefix(alt).map_err(|_| ()))
                })
                .map_err(|_| format!(
                    "File {} doesn't match root {} or alt root {:?}",
                    file_path.display(), root.display(), alt_root.map(|r| r.display())
                ))?;
            rel.to_string_lossy().replace('\\', "/")
        };

        let pct = (idx as f32 / total * 99.0).min(99.0);
        emit_progress(app, server_id, pct, &entry_name, label);

        // Skip files that disappeared between enumeration and compression
        let file = match File::open(file_path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                skipped += 1;
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        let mut entry = SevenZArchiveEntry::new();
        entry.name = entry_name;
        entry.size = metadata.len();
        entry.is_directory = false;
        writer
            .push_archive_entry::<BufReader<File>>(entry, Some(BufReader::new(file)))
            .map_err(|e| e.to_string())?;
    }

    writer.finish().map_err(|e| e.to_string())?;
    Ok(skipped)
}

// ---------------------------------------------------------------------------
// Cleanup: delete ARK's own auto-generated backup files
// ---------------------------------------------------------------------------

/// Delete ARK's own auto-generated rolling copies from SavedArks/{mapPath}:
///   - `{mapPath}_*.ark`    — ARK's own timestamped world-save backups
///   - `{mapPath}_*.arkrbf` — ASA rollback files
///   - `*.profilebak`       — ARK player-profile backups
///   - `*.tribebak`         — ARK tribe backups
///
/// Never touches the live `{mapPath}.ark`, `_AntiCorruptionBackup.bak`,
/// `*.arkprofile`, or `*.arktribe` files.
///
/// Returns the number of files deleted.
#[tauri::command]
pub async fn cleanup_ark_own_backups(
    install_path: String,
    map_path: String,
) -> Result<u32, String> {
    let saved_dir = PathBuf::from(&install_path)
        .join("ShooterGame")
        .join("Saved")
        .join("SavedArks")
        .join(&map_path);

    if !saved_dir.exists() {
        return Ok(0);
    }

    let mut deleted = 0u32;
    // ASA uses underscore as separator: Astraeos_WP_11.06.2026_09.37.13.ark
    let prefix = format!("{map_path}_");

    let entries = fs::read_dir(&saved_dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() { continue; }

        let fname = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");

        let is_ark_rolling = fname.starts_with(&prefix)
            && (fname.ends_with(".ark") || fname.ends_with(".arkrbf"));
        let is_profilebak  = fname.ends_with(".profilebak");
        let is_tribebak    = fname.ends_with(".tribebak");

        if is_ark_rolling || is_profilebak || is_tribebak {
            if fs::remove_file(&path).is_ok() {
                deleted += 1;
            }
        }
    }

    Ok(deleted)
}

// ---------------------------------------------------------------------------
// Server backup (SavedArks + SaveGames → .7z)
// ---------------------------------------------------------------------------

/// Inner implementation callable from both the Tauri command and the Rust
/// backup_manager tick handler (which cannot use State<'_> wrappers).
///
/// `skip_world_save`: pass `true` when the caller has already issued SaveWorld.
/// `base_dir`: when non-empty, resolves the canonical save path
///   `{base_dir}/Saves/{server_id}/SavedArks/{map_path}` instead of following
///   the SavedArks symlink inside the install directory.
pub async fn create_server_backup_inner(
    app: &AppHandle,
    server_id: &str,
    server_name: &str,
    install_path: &str,
    map_path: &str,
    map_id: &str,
    backup_dir: &str,
    triggered_by: &str,
    tier: &str,
    pool: &RconPool,
    skip_world_save: bool,
    base_dir: &str,
) -> Result<BackupRecord, String> {
    create_server_backup_impl(app, server_id, server_name, install_path, map_path, map_id, backup_dir, triggered_by, tier, pool, skip_world_save, base_dir).await
}

/// Tauri command: exposed to the frontend for manual/UI-triggered backups.
#[tauri::command]
pub async fn create_server_backup(
    app: AppHandle,
    server_id: String,
    server_name: String,
    install_path: String,
    map_path: String,
    map_id: String,
    backup_dir: String,
    triggered_by: String,
    tier: String,
    base_dir: String,
    pool: State<'_, RconPool>,
) -> Result<BackupRecord, String> {
    let result = create_server_backup_inner(&app, &server_id, &server_name, &install_path, &map_path, &map_id, &backup_dir, &triggered_by, &tier, &pool, false, &base_dir).await;
    if let Ok(ref rec) = result {
        let size = fmt_size(rec.file_size_bytes);
        crate::commands::notifications::dispatch_notification(
            &app, "backup_completed", Some(&server_id), &server_name,
            "Server Backup", &format!("{server_name} — server backup complete ({size})"), "success",
        ).await;
    }
    result
}

async fn create_server_backup_impl(
    app: &AppHandle,
    server_id: &str,
    server_name: &str,
    install_path: &str,
    map_path: &str,
    map_id: &str,
    backup_dir: &str,
    triggered_by: &str,
    tier: &str,
    pool: &RconPool,
    skip_world_save: bool,
    base_dir: &str,
) -> Result<BackupRecord, String> {
    const MAX_ATTEMPTS: u32 = 3;
    const RETRY_DELAY_SECS: u64 = 15;
    const POST_SAVE_WAIT_SECS: u64 = 5;

    if !skip_world_save {
        // SaveWorld (best-effort — server may be stopped)
        emit_progress(&app, &server_id, 0.0, "", "Saving world…");
        let _ = rcon_save_world(&pool, &server_id).await;

        // ASA acknowledges SaveWorld via RCON before finishing all file I/O.
        // Wait briefly so atomic save writes (delete → rename patterns) complete
        // before we enumerate the directory.
        sleep(Duration::from_secs(POST_SAVE_WAIT_SECS)).await;
    }

    // Use canonical path when base_dir is known, otherwise fall back to following the symlink.
    let saved_arks = if !base_dir.is_empty() {
        PathBuf::from(base_dir).join("Saves").join(server_id).join("SavedArks").join(map_path)
    } else {
        PathBuf::from(&install_path).join("ShooterGame").join("Saved").join("SavedArks").join(map_path)
    };
    let save_games = PathBuf::from(&install_path)
        .join("ShooterGame").join("Saved").join("SaveGames");

    // When base_dir is used, files come from two roots: canonical saves and install_path SaveGames.
    // Calculate the primary root based on whether base_dir is used.
    let saved_root = if !base_dir.is_empty() {
        PathBuf::from(base_dir).join("Saves").join(server_id)
    } else {
        PathBuf::from(&install_path).join("ShooterGame").join("Saved")
    };

    // The alternate root is always install_path/ShooterGame/Saved for SaveGames compatibility.
    let alt_root = if !base_dir.is_empty() {
        Some(PathBuf::from(&install_path).join("ShooterGame").join("Saved"))
    } else {
        None
    };

    let out_dir = PathBuf::from(&backup_dir).join(&server_id).join("server");
    fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let safe_name = sanitize_name(&server_name);
    let suffix    = tier_suffix(&tier);
    let mut last_error = String::new();

    for attempt in 0..MAX_ATTEMPTS {
        if attempt > 0 {
            emit_progress(&app, &server_id, 0.0, "",
                &format!("Retrying backup (attempt {}/{MAX_ATTEMPTS})…", attempt + 1));
            sleep(Duration::from_secs(RETRY_DELAY_SECS)).await;
        }

        // Fresh cleanup and enumeration on every attempt so each retry gets a
        // stable snapshot after ASA has finished writing.
        emit_progress(&app, &server_id, 2.0, "", "Cleaning ARK backups…");
        let _ = cleanup_ark_own_backups(install_path.to_string(), map_path.to_string()).await;

        let mut all_files: Vec<PathBuf> = Vec::new();
        if saved_arks.exists() {
            collect_files(&saved_arks, &mut all_files).map_err(|e| e.to_string())?;
        }
        if save_games.exists() {
            collect_files(&save_games, &mut all_files).map_err(|e| e.to_string())?;
        }
        if all_files.is_empty() {
            return Err("No save files found to back up".to_string());
        }

        // Build entries with custom names for SaveGames files to include map path
        let mut entries: Vec<(PathBuf, Option<String>)> = Vec::new();
        for file_path in all_files {
            let custom_name = if file_path.starts_with(&save_games) {
                // For SaveGames files, prepend Mods/{map_path}/SaveGames/
                let rel_path = file_path.strip_prefix(&save_games)
                    .ok()
                    .and_then(|p| p.to_str())
                    .unwrap_or("");
                let rel_clean = rel_path.trim_start_matches(|c| c == '/' || c == '\\');
                Some(format!("Mods/{}/SaveGames/{}", map_path, rel_clean.replace('\\', "/")))
            } else {
                // For SavedArks files, let compress_to_7z_with_entries handle it
                None
            };
            entries.push((file_path, custom_name));
        }

        let (ts_file, ts_iso) = now_timestamp();
        let archive_name = format!("{safe_name}-{ts_file}{suffix}.7z");
        let archive_path = out_dir.join(&archive_name);

        let app_c = app.clone();
        let sid   = server_id.to_string();
        let root  = saved_root.clone();
        let alt   = alt_root.clone();
        let dest  = archive_path.clone();
        let compress_result = tokio::task::spawn_blocking(move || {
            compress_to_7z_with_entries(&app_c, &sid, &entries, &root, alt.as_deref(), &dest, "Creating server backup…")
        })
        .await
        .map_err(|e| format!("Backup task panicked: {e}"))?;

        match compress_result {
            Ok(skipped) => {
                let is_last = attempt == MAX_ATTEMPTS - 1;
                if skipped > 0 && !is_last {
                    // Files disappeared mid-compression — retry with fresh snapshot
                    let _ = tokio::fs::remove_file(&archive_path).await;
                    continue;
                }
                // Clean run, or last attempt — accept the archive
                emit_progress(&app, &server_id, 100.0, &archive_name, "Done");
                let file_size = fs::metadata(&archive_path)
                    .map_err(|e| e.to_string())?
                    .len();
                return Ok(BackupRecord {
                    id: Uuid::new_v4().to_string(),
                    server_id:       server_id.to_string(),
                    file_path:       archive_path.to_string_lossy().to_string(),
                    file_size_bytes: file_size,
                    map_id:          map_id.to_string(),
                    triggered_by:    triggered_by.to_string(),
                    created_at:      ts_iso,
                    backup_type:     "server".to_string(),
                    tiers:           String::new(),
                    player_eosid:    None,
                    player_name:     None,
                });
            }
            Err(e) => {
                let _ = tokio::fs::remove_file(&archive_path).await;
                last_error = e;
                // Will retry if attempts remain
            }
        }
    }

    Err(last_error)
}

// ---------------------------------------------------------------------------
// All-players manual backup
// ---------------------------------------------------------------------------

/// Inner implementation for all-players backup — callable from both the Tauri
/// command and the Rust backup_manager tick handler.
pub async fn backup_all_players_inner(
    app: &AppHandle,
    server_id: &str,
    server_name: &str,
    install_path: &str,
    map_path: &str,
    map_id: &str,
    backup_dir: &str,
    triggered_by: &str,
) -> Result<Vec<BackupRecord>, String> {
    let saved_dir = PathBuf::from(install_path)
        .join("ShooterGame").join("Saved")
        .join("SavedArks").join(map_path);

    if !saved_dir.exists() {
        return Ok(vec![]);
    }

    let profiles: Vec<String> = fs::read_dir(&saved_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("arkprofile"))
        .filter_map(|e| {
            e.path().file_stem()
                .and_then(|s| s.to_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
        })
        .collect();

    let mut records = Vec::new();
    for eos_id in &profiles {
        if let Ok(rec) = create_player_backup_inner(
            app,
            server_id,
            server_name,
            install_path,
            map_path,
            map_id,
            backup_dir,
            eos_id,
            eos_id,
            triggered_by,
            "",
        ).await {
            records.push(rec);
        }
    }
    Ok(records)
}

/// Tauri command: back up every .arkprofile (UI-triggered or scheduled from frontend).
#[tauri::command]
pub async fn backup_all_players(
    app: AppHandle,
    server_id: String,
    server_name: String,
    install_path: String,
    map_path: String,
    map_id: String,
    backup_dir: String,
    triggered_by: String,
) -> Result<Vec<BackupRecord>, String> {
    let result = backup_all_players_inner(&app, &server_id, &server_name, &install_path, &map_path, &map_id, &backup_dir, &triggered_by).await;
    if let Ok(ref recs) = result {
        let count = recs.len();
        if count > 0 {
            crate::commands::notifications::dispatch_notification(
                &app, "backup_completed", Some(&server_id), &server_name,
                "Player Backup", &format!("{server_name} — {count} player backups complete"), "success",
            ).await;
        }
    }
    result
}

// ---------------------------------------------------------------------------
// Player backup (single .arkprofile → .7z)
// ---------------------------------------------------------------------------

/// Inner implementation for single-player backup — callable without Tauri State wrappers.
pub async fn create_player_backup_inner(
    app: &AppHandle,
    server_id: &str,
    server_name: &str,
    install_path: &str,
    map_path: &str,
    map_id: &str,
    backup_dir: &str,
    eos_id: &str,
    player_name: &str,
    triggered_by: &str,
    tier: &str,
) -> Result<BackupRecord, String> {
    let profile_file = PathBuf::from(install_path)
        .join("ShooterGame").join("Saved")
        .join("SavedArks").join(map_path)
        .join(format!("{eos_id}.arkprofile"));

    if !profile_file.exists() {
        return Err(format!("Profile not found: {}", profile_file.display()));
    }

    let out_dir = PathBuf::from(backup_dir)
        .join(server_id).join("player").join(eos_id);
    fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let (ts_file, ts_iso) = now_timestamp();
    let safe_server  = sanitize_name(server_name);
    let safe_player  = sanitize_name(player_name);
    let suffix       = tier_suffix(tier);
    let archive_name = format!("{safe_server}-{safe_player}-{ts_file}{suffix}.7z");
    let archive_path = out_dir.join(&archive_name);

    emit_progress(app, server_id, 0.0, "", &format!("Backing up {player_name}…"));

    let root  = profile_file.parent().unwrap().to_path_buf();
    let files = vec![profile_file.clone()];
    let app_c = app.clone();
    let sid   = server_id.to_string();
    let dest  = archive_path.clone();
    let result = tokio::task::spawn_blocking(move || {
        compress_to_7z(&app_c, &sid, &files, &root, &dest, "Creating player backup…")
    })
    .await
    .map_err(|e| format!("Backup task panicked: {e}"))?;
    if let Err(e) = result {
        let _ = fs::remove_file(&archive_path);
        return Err(e);
    }

    emit_progress(app, server_id, 100.0, &archive_name, "Done");

    let file_size = fs::metadata(&archive_path)
        .map_err(|e| e.to_string())?
        .len();

    Ok(BackupRecord {
        id:              Uuid::new_v4().to_string(),
        server_id:       server_id.to_string(),
        file_path:       archive_path.to_string_lossy().to_string(),
        file_size_bytes: file_size,
        map_id:          map_id.to_string(),
        triggered_by:    triggered_by.to_string(),
        created_at:      ts_iso,
        backup_type:     "player".to_string(),
        tiers:           String::new(),
        player_eosid:    Some(eos_id.to_string()),
        player_name:     Some(player_name.to_string()),
    })
}

/// Tauri command: back up a single player's .arkprofile.
#[tauri::command]
pub async fn create_player_backup(
    app: AppHandle,
    server_id: String,
    server_name: String,
    install_path: String,
    map_path: String,
    map_id: String,
    backup_dir: String,
    eos_id: String,
    player_name: String,
    triggered_by: String,
    tier: String,
) -> Result<BackupRecord, String> {
    let result = create_player_backup_inner(
        &app, &server_id, &server_name, &install_path, &map_path,
        &map_id, &backup_dir, &eos_id, &player_name, &triggered_by, &tier,
    ).await;
    if let Ok(ref rec) = result {
        let size = fmt_size(rec.file_size_bytes);
        let display_name = rec.player_name.as_deref().unwrap_or(&eos_id);
        crate::commands::notifications::dispatch_notification(
            &app, "backup_completed", Some(&server_id), &server_name,
            "Player Backup", &format!("{server_name} — backup for {display_name} complete ({size})"), "success",
        ).await;
    }
    result
}

// ---------------------------------------------------------------------------
// INI backup (loose files in a timestamped folder)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IniBackupRecord {
    pub id: String,
    pub server_id: String,
    pub folder_path: String,
    pub created_at: String,
}

/// Back up GameUserSettings.ini and Game.ini to a timestamped subfolder of
/// {backup_dir}/{server_id}/ini/.  The folder named "current" always holds
/// the latest backup; on each save the previous "current" is renamed to a
/// timestamp folder and a new "current" copy is written.
#[tauri::command]
pub async fn create_ini_backup(
    server_id: String,
    install_path: String,
    backup_dir: String,
) -> Result<IniBackupRecord, String> {
    #[cfg(target_os = "windows")]
    let platform = "WindowsServer";
    #[cfg(not(target_os = "windows"))]
    let platform = "LinuxServer";

    let config_dir = PathBuf::from(&install_path)
        .join("ShooterGame").join("Saved").join("Config").join(platform);

    let ini_files = ["GameUserSettings.ini", "Game.ini"];
    let sources: Vec<PathBuf> = ini_files.iter()
        .map(|f| config_dir.join(f))
        .filter(|p| p.exists())
        .collect();

    if sources.is_empty() {
        return Err("No INI files found to back up".to_string());
    }

    let ini_base = PathBuf::from(&backup_dir).join(&server_id).join("ini");
    let current  = ini_base.join("current");

    // If "current" already exists, rename it to a timestamp folder.
    if current.exists() {
        let (ts_file, _) = now_timestamp();
        let archive_folder = ini_base.join(&ts_file);
        fs::rename(&current, &archive_folder).map_err(|e| e.to_string())?;
    }

    fs::create_dir_all(&current).map_err(|e| e.to_string())?;

    for src in &sources {
        if let Some(fname) = src.file_name() {
            fs::copy(src, current.join(fname)).map_err(|e| e.to_string())?;
        }
    }

    let (_, ts_iso) = now_timestamp();
    Ok(IniBackupRecord {
        id: Uuid::new_v4().to_string(),
        server_id,
        folder_path: current.to_string_lossy().to_string(),
        created_at: ts_iso,
    })
}

/// Create the save directory link for a server.
///
/// Creates:
///   `{base_dir}/Saves/{server_id}/SavedArks/`                ← the real save location
///   `{install_path}/ShooterGame/Saved/SavedArks`  →  symlink  ← replaces the whole SavedArks dir
///
/// On Linux: a symlink. On Windows: an NTFS junction (no admin rights required).
///
/// If `SavedArks` already exists as a regular directory (first-run or leftover from a
/// previous install), it is removed so the symlink/junction can be placed at that path.
/// If the link already points to the correct target, returns success without changes.
#[tauri::command]
pub async fn create_save_link(
    install_path: String,
    server_id: String,
    base_dir: String,
) -> Result<(), String> {
    if server_id.is_empty() {
        return Err("server_id must not be empty".to_string());
    }

    // The canonical save storage directory (real data lives here)
    let save_target = PathBuf::from(&base_dir).join("Saves").join(&server_id).join("SavedArks");
    fs::create_dir_all(&save_target).map_err(|e| format!("Failed to create save target dir: {e}"))?;

    // The path inside the server install where SavedArks should be (will become the link)
    let saved_dir = PathBuf::from(&install_path).join("ShooterGame").join("Saved");
    fs::create_dir_all(&saved_dir).map_err(|e| format!("Failed to create Saved dir: {e}"))?;
    let link_path = saved_dir.join("SavedArks");

    // If something already exists at link_path, check it and remove if wrong
    if link_path.exists() || link_path.is_symlink() {
        if let Ok(existing) = std::fs::read_link(&link_path) {
            if existing == save_target {
                return Ok(());
            }
        }
        // Wrong target, broken link, or plain directory — remove so we can recreate.
        // On Windows, junctions must be removed with remove_dir (not remove_dir_all,
        // which would follow the junction and delete the actual save data).
        if link_path.is_symlink() {
            #[cfg(target_os = "windows")]
            { let _ = fs::remove_dir(&link_path); }
            #[cfg(not(target_os = "windows"))]
            { let _ = fs::remove_file(&link_path); }
        } else if link_path.is_dir() {
            let _ = fs::remove_dir_all(&link_path);
        } else {
            let _ = fs::remove_file(&link_path);
        }
    }

    #[cfg(target_os = "linux")]
    {
        std::os::unix::fs::symlink(&save_target, &link_path)
            .map_err(|e| format!("Failed to create symlink: {e}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        junction::create(&save_target, &link_path)
            .map_err(|e| format!("Failed to create junction point: {e}"))?;
    }

    Ok(())
}

/// Create the mods saves directory link for a server (per-map SaveGames).
///
/// Creates:
///   `{base_dir}/Saves/{server_id}/Mods/{map_path}/SaveGames/`         ← the real mod save location
///   `{install_path}/ShooterGame/Saved/SaveGames`  →  symlink/junction  ← points to current map's mod data
///
/// On Linux: a symlink. On Windows: an NTFS junction (no admin rights required).
///
/// This is called when the server starts or when the map changes to ensure the
/// SaveGames symlink points to the current map's mod save data.
#[tauri::command]
pub async fn create_mods_saves_link(
    install_path: String,
    server_id: String,
    base_dir: String,
    map_path: String,
) -> Result<(), String> {
    if server_id.is_empty() || map_path.is_empty() {
        return Err("server_id and map_path must not be empty".to_string());
    }

    // The canonical mod save storage directory for this map (real data lives here)
    let mods_target = PathBuf::from(&base_dir)
        .join("Saves")
        .join(&server_id)
        .join("Mods")
        .join(&map_path)
        .join("SaveGames");
    fs::create_dir_all(&mods_target).map_err(|e| format!("Failed to create mods target dir: {e}"))?;

    // The path inside the server install where SaveGames should be (will become the link)
    let saved_dir = PathBuf::from(&install_path).join("ShooterGame").join("Saved");
    fs::create_dir_all(&saved_dir).map_err(|e| format!("Failed to create Saved dir: {e}"))?;
    let link_path = saved_dir.join("SaveGames");

    // If something already exists at link_path, check it and remove if it points to wrong target
    if link_path.exists() || link_path.is_symlink() {
        if let Ok(existing) = std::fs::read_link(&link_path) {
            if existing == mods_target {
                return Ok(());
            }
        }
        // Wrong target, broken link, or plain directory — remove so we can recreate.
        if link_path.is_symlink() {
            #[cfg(target_os = "windows")]
            { let _ = fs::remove_dir(&link_path); }
            #[cfg(not(target_os = "windows"))]
            { let _ = fs::remove_file(&link_path); }
        } else if link_path.is_dir() {
            let _ = fs::remove_dir_all(&link_path);
        } else {
            let _ = fs::remove_file(&link_path);
        }
    }

    #[cfg(target_os = "linux")]
    {
        std::os::unix::fs::symlink(&mods_target, &link_path)
            .map_err(|e| format!("Failed to create symlink: {e}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        junction::create(&mods_target, &link_path)
            .map_err(|e| format!("Failed to create junction point: {e}"))?;
    }

    Ok(())
}

/// Wipe server save files at one of three tiers:
///
/// - `"map"`     — delete world `.ark` files only (clears map state, preserves characters).
/// - `"players"` — delete `.arkprofile` and `.arktribe` files only (resets characters/tribes).
/// - `"full"`    — delete all save files (world + characters + tribe + mod saves).
///
/// `SavedArks` is a symlink to the canonical save directory, so all tiers operate
/// on the real data transparently. `map_path` is the map folder name (e.g. `TheIsland_WP`).
///
/// The server MUST NOT be running when this is called (enforced on the frontend).
#[tauri::command]
pub async fn wipe_server_saves(
    install_path: String,
    map_path: String,
    tier: String,
) -> Result<(), String> {
    let saves_root = PathBuf::from(&install_path)
        .join("ShooterGame").join("Saved").join("SavedArks")
        .join(&map_path);

    if !saves_root.exists() {
        return Ok(());
    }

    match tier.as_str() {
        "map" => {
            // Remove world state files: *.ark (but NOT *.arkprofile or *.arktribe)
            for entry in fs::read_dir(&saves_root).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();
                if path.is_file() {
                    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                    if ext == "ark" {
                        fs::remove_file(&path).map_err(|e| format!("Failed to remove {:?}: {e}", path))?;
                    }
                }
            }
        }
        "players" => {
            // Remove character / tribe files: *.arkprofile, *.arktribe
            for entry in fs::read_dir(&saves_root).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();
                if path.is_file() {
                    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                    if ext == "arkprofile" || ext == "arktribe" {
                        fs::remove_file(&path).map_err(|e| format!("Failed to remove {:?}: {e}", path))?;
                    }
                }
            }
        }
        "full" => {
            // Remove everything in the saves directory (but not the directory itself)
            for entry in fs::read_dir(&saves_root).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();
                if path.is_file() || path.is_symlink() {
                    fs::remove_file(&path).map_err(|e| format!("Failed to remove file {:?}: {e}", path))?;
                } else if path.is_dir() {
                    fs::remove_dir_all(&path).map_err(|e| format!("Failed to remove dir {:?}: {e}", path))?;
                }
            }
        }
        _ => return Err(format!("Unknown wipe tier: {tier}")),
    }

    Ok(())
}

/// Copy the save data for a specific map from one server to another.
///
/// Source: `{base_dir}/Saves/{source_server_id}/SavedArks/{map_path}/`
/// Target: `{base_dir}/Saves/{target_server_id}/SavedArks/{map_path}/`
///
/// The target map subfolder is cleared before the copy so the result is an
/// exact mirror of the source. Both servers must be stopped before calling this.
#[tauri::command]
pub async fn import_server_saves(
    source_server_id: String,
    target_server_id: String,
    base_dir: String,
    map_path: String,
) -> Result<(), String> {
    if source_server_id == target_server_id {
        return Err("Source and target server must be different".to_string());
    }

    let source = PathBuf::from(&base_dir)
        .join("Saves").join(&source_server_id).join("SavedArks").join(&map_path);
    let target = PathBuf::from(&base_dir)
        .join("Saves").join(&target_server_id).join("SavedArks").join(&map_path);

    if !source.exists() {
        return Err(format!("Source save directory does not exist: {}", source.display()));
    }

    // Clear the target map subfolder first
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|e| format!("Failed to clear target save dir: {e}"))?;
    }
    fs::create_dir_all(&target).map_err(|e| format!("Failed to create target save dir: {e}"))?;

    // Recursively copy everything from source into target
    fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
        for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let dst_path = dst.join(entry.file_name());
            let src_path = entry.path();
            if src_path.is_dir() {
                fs::create_dir_all(&dst_path).map_err(|e| e.to_string())?;
                copy_dir(&src_path, &dst_path)?;
            } else {
                fs::copy(&src_path, &dst_path)
                    .map_err(|e| format!("Failed to copy {:?}: {e}", src_path))?;
            }
        }
        Ok(())
    }

    copy_dir(&source, &target)?;
    Ok(())
}

/// List timestamped INI snapshot folders for a server (newest first).
#[tauri::command]
pub async fn list_ini_backups(
    server_id: String,
    backup_dir: String,
) -> Result<Vec<String>, String> {
    let ini_base = PathBuf::from(&backup_dir).join(&server_id).join("ini");
    if !ini_base.exists() {
        return Ok(vec![]);
    }

    let mut folders: Vec<String> = fs::read_dir(&ini_base)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path().is_dir()
                && e.file_name().to_string_lossy() != "current"
        })
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();

    // Timestamps sort lexicographically as newest last; reverse for newest first.
    folders.sort();
    folders.reverse();
    Ok(folders)
}

// ---------------------------------------------------------------------------
// Full backup (entire install_path → .7z)
// ---------------------------------------------------------------------------

/// Create a Full backup of the entire server installation directory.
/// This can be very large — warn the user before calling this.
#[tauri::command]
pub async fn create_full_backup(
    app: AppHandle,
    server_id: String,
    server_name: String,
    install_path: String,
    map_id: String,
    backup_dir: String,
    triggered_by: String,
    tier: String,
) -> Result<BackupRecord, String> {
    let install_dir = PathBuf::from(&install_path);
    if !install_dir.exists() {
        return Err(format!("Install path not found: {install_path}"));
    }

    let out_dir = PathBuf::from(&backup_dir).join(&server_id).join("full");
    fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let (ts_file, ts_iso) = now_timestamp();
    let safe_name    = sanitize_name(&server_name);
    let suffix       = tier_suffix(&tier);
    let archive_name = format!("{safe_name}-full-{ts_file}{suffix}.7z");
    let archive_path = out_dir.join(&archive_name);

    emit_progress(&app, &server_id, 0.0, "", "Collecting files for full backup…");

    let mut all_files: Vec<PathBuf> = Vec::new();
    collect_files(&install_dir, &mut all_files).map_err(|e| e.to_string())?;

    let app_c = app.clone();
    let sid   = server_id.clone();
    let dest  = archive_path.clone();
    let root  = install_dir.clone();
    let result = tokio::task::spawn_blocking(move || {
        compress_to_7z(&app_c, &sid, &all_files, &root, &dest, "Creating full backup…")
    })
    .await
    .map_err(|e| format!("Full backup task panicked: {e}"))?;
    if let Err(e) = result {
        let _ = fs::remove_file(&archive_path);
        return Err(e);
    }

    emit_progress(&app, &server_id, 100.0, &archive_name, "Done");

    let file_size = fs::metadata(&archive_path)
        .map_err(|e| e.to_string())?
        .len();

    let rec = BackupRecord {
        id: Uuid::new_v4().to_string(),
        server_id,
        file_path: archive_path.to_string_lossy().to_string(),
        file_size_bytes: file_size,
        map_id,
        triggered_by,
        created_at: ts_iso,
        backup_type: "full".to_string(),
        tiers: String::new(),
        player_eosid: None,
        player_name: None,
    };
    let size = fmt_size(rec.file_size_bytes);
    crate::commands::notifications::dispatch_notification(
        &app, "backup_completed", Some(&rec.server_id), &server_name,
        "Full Backup", &format!("{server_name} — full backup complete ({size})"), "success",
    ).await;
    Ok(rec)
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/// Restore a Server backup: extract 7z to correct canonical locations and recreate symlinks.
/// Archive structure:
///   SavedArks/{map_path}/... → restored to {install_path}/ShooterGame/Saved/SavedArks/{map_path}/
///   Mods/{map_path}/SaveGames/... → restored to {base_dir}/Saves/{server_id}/Mods/{map_path}/SaveGames/
#[tauri::command]
pub async fn restore_server_backup(
    app: AppHandle,
    server_id: String,
    backup_file_path: String,
    install_path: String,
    base_dir: String,
    map_path: String,
) -> Result<(), String> {
    use std::fs;

    // Validate inputs
    if server_id.is_empty() || map_path.is_empty() {
        return Err("server_id and map_path must not be empty".to_string());
    }

    // Step 1: Clear existing save locations
    emit_progress(&app, &server_id, 10.0, "", "Clearing existing saves…");
    let saved_arks_path = PathBuf::from(&base_dir).join("Saves").join(&server_id).join("SavedArks").join(&map_path);
    if saved_arks_path.exists() {
        fs::remove_dir_all(&saved_arks_path).map_err(|e| format!("Failed to clear SavedArks: {e}"))?;
    }

    let mods_saves_path = PathBuf::from(&base_dir).join("Saves").join(&server_id).join("Mods").join(&map_path).join("SaveGames");
    if mods_saves_path.exists() {
        fs::remove_dir_all(&mods_saves_path).map_err(|e| format!("Failed to clear SaveGames: {e}"))?;
    }

    // Step 2: Extract backup to temp directory
    emit_progress(&app, &server_id, 20.0, "", "Extracting backup…");
    let temp_dir = std::env::temp_dir().join(format!("lokiasam-restore-{}", server_id));
    if temp_dir.exists() {
        fs::remove_dir_all(&temp_dir).ok();
    }
    fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;

    sevenz_rust::decompress_file(&backup_file_path, &temp_dir)
        .map_err(|e| e.to_string())?;

    // Step 3: Move extracted files to correct locations
    emit_progress(&app, &server_id, 50.0, "", "Moving files to correct locations…");

    // Process SavedArks files
    let temp_saved_arks = temp_dir.join("SavedArks").join(&map_path);
    if temp_saved_arks.exists() {
        fs::create_dir_all(&saved_arks_path).map_err(|e| e.to_string())?;
        copy_dir_recursive(&temp_saved_arks, &saved_arks_path).map_err(|e| e.to_string())?;
    }

    // Process Mods/SaveGames files
    let temp_mods = temp_dir.join("Mods").join(&map_path).join("SaveGames");
    if temp_mods.exists() {
        fs::create_dir_all(&mods_saves_path).map_err(|e| e.to_string())?;
        copy_dir_recursive(&temp_mods, &mods_saves_path).map_err(|e| e.to_string())?;
    }

    // Step 4: Recreate symlinks
    emit_progress(&app, &server_id, 80.0, "", "Recreating symlinks…");
    create_save_link(install_path.clone(), server_id.clone(), base_dir.clone()).await?;
    create_mods_saves_link(install_path, server_id.clone(), base_dir, map_path).await?;

    // Step 5: Cleanup temp directory
    emit_progress(&app, &server_id, 95.0, "", "Cleaning up…");
    let _ = fs::remove_dir_all(&temp_dir);

    emit_progress(&app, &server_id, 100.0, "", "Restore complete");
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    use std::fs;
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let file_name = entry.file_name();
        let dest_path = dst.join(&file_name);

        if path.is_dir() {
            copy_dir_recursive(&path, &dest_path)?;
        } else {
            fs::copy(&path, &dest_path)?;
        }
    }
    Ok(())
}

/// Restore a Player backup: extract 7z into SavedArks/{mapPath}.
#[tauri::command]
pub async fn restore_player_backup(
    app: AppHandle,
    server_id: String,
    backup_file_path: String,
    install_path: String,
    map_path: String,
) -> Result<(), String> {
    let target = PathBuf::from(&install_path)
        .join("ShooterGame").join("Saved")
        .join("SavedArks").join(&map_path);
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    extract_7z_with_progress(&app, &server_id, &backup_file_path, &target, "Restoring player backup…").await
}

/// Restore an INI backup from a snapshot folder.
#[tauri::command]
pub async fn restore_ini_backup(
    backup_folder_path: String,
    install_path: String,
    platform: String,
) -> Result<(), String> {
    let src_dir = PathBuf::from(&backup_folder_path);
    let dst_dir = PathBuf::from(&install_path)
        .join("ShooterGame").join("Saved").join("Config").join(&platform);

    fs::create_dir_all(&dst_dir).map_err(|e| e.to_string())?;

    for entry in fs::read_dir(&src_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src   = entry.path();
        if src.is_file() {
            if let Some(fname) = src.file_name() {
                fs::copy(&src, dst_dir.join(fname)).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// Restore a Full backup: extract 7z over the entire install_path.
#[tauri::command]
pub async fn restore_full_backup(
    app: AppHandle,
    server_id: String,
    backup_file_path: String,
    install_path: String,
) -> Result<(), String> {
    let target = PathBuf::from(&install_path);
    extract_7z_with_progress(&app, &server_id, &backup_file_path, &target, "Restoring full backup…").await
}

async fn extract_7z_with_progress(
    app: &AppHandle,
    server_id: &str,
    archive_path: &str,
    dest_root: &Path,
    label: &str,
) -> Result<(), String> {
    let archive_path = archive_path.to_string();
    let dest_root    = dest_root.to_path_buf();
    let app_c        = app.clone();
    let sid          = server_id.to_string();
    let lbl          = label.to_string();

    emit_progress(app, server_id, 0.0, "", label);

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        fs::create_dir_all(&dest_root).map_err(|e| e.to_string())?;

        sevenz_rust::decompress_file(&archive_path, &dest_root)
            .map_err(|e| e.to_string())?;

        emit_progress(&app_c, &sid, 100.0, "", &lbl);
        Ok(())
    })
    .await
    .map_err(|e| format!("Restore task panicked: {e}"))?
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/// Delete a backup archive or INI folder from disk.
#[tauri::command]
pub async fn delete_backup(file_path: String) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
    } else {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Estimate the uncompressed size of the install directory (for full backup warning).
#[tauri::command]
pub async fn estimate_dir_size(dir_path: String) -> Result<u64, String> {
    let path = PathBuf::from(&dir_path);
    if !path.exists() {
        return Ok(0);
    }
    let mut total = 0u64;
    let mut stack = vec![path];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = fs::read_dir(&d) {
            for entry in rd.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    stack.push(p);
                } else if let Ok(meta) = fs::metadata(&p) {
                    total += meta.len();
                }
            }
        }
    }
    Ok(total)
}

// ---------------------------------------------------------------------------
// Rename file (used when tier flags change)
// ---------------------------------------------------------------------------

/// Rename a backup file on disk and return the new path.
/// Used by the frontend when tier flags are promoted/stripped.
#[tauri::command]
pub async fn rename_backup_file(old_path: String, new_path: String) -> Result<(), String> {
    fs::rename(&old_path, &new_path).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// File exists check
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn backup_file_exists(file_path: String) -> bool {
    PathBuf::from(&file_path).exists()
}

// ---------------------------------------------------------------------------
// Scan backup directory (Sync from Disk)
// ---------------------------------------------------------------------------

/// Scan a server's backup subdirectory tree and return every .7z found as a
/// BackupRecord.  The caller diffs against the DB and imports what's missing.
#[tauri::command]
pub async fn scan_backup_dir(
    server_id: String,
    backup_dir: String,
    map_id: String,
) -> Result<Vec<BackupRecord>, String> {
    let base = PathBuf::from(&backup_dir).join(&server_id);
    let mut records: Vec<BackupRecord> = Vec::new();

    // server/
    scan_type_dir(&base.join("server"), &server_id, &map_id, "server", None, &mut records);
    // player/{eos_id}/
    let player_root = base.join("player");
    if player_root.exists() {
        if let Ok(rd) = fs::read_dir(&player_root) {
            for entry in rd.flatten() {
                let eos_dir = entry.path();
                if eos_dir.is_dir() {
                    let eos_id = eos_dir.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string();
                    scan_type_dir(&eos_dir, &server_id, &map_id, "player", Some(&eos_id), &mut records);
                }
            }
        }
    }
    // full/
    scan_type_dir(&base.join("full"), &server_id, &map_id, "full", None, &mut records);

    Ok(records)
}

fn scan_type_dir(
    dir: &Path,
    server_id: &str,
    map_id: &str,
    backup_type: &str,
    eos_id: Option<&str>,
    out: &mut Vec<BackupRecord>,
) {
    if !dir.exists() { return; }
    let Ok(rd) = fs::read_dir(dir) else { return };

    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_file() { continue; }
        let fname = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) if n.ends_with(".7z") => n.to_string(),
            _ => continue,
        };

        let stem = fname.trim_end_matches(".7z");
        let (ts_iso, tiers) = parse_backup_filename(stem).unwrap_or_else(|| {
            // Fallback: use file mtime
            let secs = path.metadata().ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let (y, mo, d, h, min, s) = crate::state::log_manager::epoch_to_ymdhms(secs);
            (format!("{y:04}-{mo:02}-{d:02}T{h:02}:{min:02}:{s:02}Z"), String::new())
        });

        let file_size = path.metadata().map(|m| m.len()).unwrap_or(0);
        let eos_str   = eos_id.unwrap_or("").to_string();

        out.push(BackupRecord {
            id:              Uuid::new_v4().to_string(),
            server_id:       server_id.to_string(),
            file_path:       path.to_string_lossy().to_string(),
            file_size_bytes: file_size,
            map_id:          map_id.to_string(),
            triggered_by:    "disk_import".to_string(),
            created_at:      ts_iso,
            backup_type:     backup_type.to_string(),
            tiers,
            player_eosid:    if eos_str.is_empty() { None } else { Some(eos_str.clone()) },
            player_name:     if eos_str.is_empty() { None } else { Some(eos_str) },
        });
    }
}
