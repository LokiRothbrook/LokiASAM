use crate::state::stats_recorder::StatsRecorderState;
use crate::state::AppState;

/// Called by the frontend once the JS-side `initDb(dbPath)` has run all migrations.
/// Opens a separate rusqlite connection for the background recorder task, runs the
/// first rollup, and stores the db_path in AppState for Rust-side business logic.
#[tauri::command]
pub async fn init_stats_recorder(
    db_path: String,
    recorder: tauri::State<'_, StatsRecorderState>,
    app_state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    app_state.set_db_path(&db_path);
    recorder.init(&db_path)?;

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    recorder.run_rollup(now_ms);

    Ok(())
}
