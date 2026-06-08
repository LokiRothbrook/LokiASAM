use crate::state::stats_recorder::StatsRecorderState;

/// Called by the frontend once the JS-side `initDb(dbPath)` has run all migrations.
/// Opens a separate rusqlite connection for the background recorder task and
/// immediately runs the first rollup (pruning old raw samples and old daily rows).
#[tauri::command]
pub async fn init_stats_recorder(
    db_path: String,
    recorder: tauri::State<'_, StatsRecorderState>,
) -> Result<(), String> {
    recorder.init(&db_path)?;

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    recorder.run_rollup(now_ms);

    Ok(())
}
