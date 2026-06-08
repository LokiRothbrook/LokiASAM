use std::sync::Mutex;

/// Holds a direct rusqlite connection used exclusively by the background stats recorder task.
/// The connection is opened once `init_stats_recorder` is called from the frontend
/// (after the JS-side `initDb` has already run migrations on the same file).
///
/// All public methods lock the connection internally and silently swallow errors so
/// that a DB hiccup never disrupts the main stats polling loop.
pub struct StatsRecorderState {
    conn: Mutex<Option<rusqlite::Connection>>,
}

// rusqlite::Connection is Send but not Sync. Wrapping in Mutex<Option<...>> provides
// the Sync bound that Tauri's managed-state system requires.
// Safety: access is always serialised through the Mutex.
unsafe impl Sync for StatsRecorderState {}

impl StatsRecorderState {
    pub fn new() -> Self {
        Self {
            conn: Mutex::new(None),
        }
    }

    /// Open (or re-open) a connection to the SQLite file at `db_path`.
    /// Must be called after the frontend has already applied all migrations.
    pub fn init(&self, db_path: &str) -> Result<(), String> {
        let conn = rusqlite::Connection::open(db_path)
            .map_err(|e| format!("StatsRecorder: failed to open DB: {e}"))?;
        // Match the WAL + synchronous settings the frontend uses.
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
            .map_err(|e| format!("StatsRecorder: PRAGMA failed: {e}"))?;
        *self.conn.lock().unwrap() = Some(conn);
        Ok(())
    }

    pub fn is_ready(&self) -> bool {
        self.conn.lock().unwrap().is_some()
    }

    pub fn insert_stat_sample(
        &self,
        server_id: &str,
        sampled_at: i64,
        cpu_pct: Option<f32>,
        mem_mb: Option<f32>,
        players: Option<i32>,
    ) {
        let guard = self.conn.lock().unwrap();
        if let Some(c) = guard.as_ref() {
            let _ = c.execute(
                "INSERT INTO server_stats_history \
                 (server_id, sampled_at, cpu_pct, mem_mb, players) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![server_id, sampled_at, cpu_pct, mem_mb, players],
            );
        }
    }

    pub fn open_uptime_session(&self, server_id: &str, session_id: &str, started_at: i64) {
        let guard = self.conn.lock().unwrap();
        if let Some(c) = guard.as_ref() {
            let _ = c.execute(
                "INSERT OR IGNORE INTO server_uptime_sessions \
                 (id, server_id, started_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![session_id, server_id, started_at],
            );
        }
    }

    pub fn close_uptime_session(&self, session_id: &str, ended_at: i64) {
        let guard = self.conn.lock().unwrap();
        if let Some(c) = guard.as_ref() {
            let _ = c.execute(
                "UPDATE server_uptime_sessions \
                 SET ended_at = ?1 \
                 WHERE id = ?2 AND ended_at IS NULL",
                rusqlite::params![ended_at, session_id],
            );
        }
    }

    /// Roll up raw samples older than 30 days into daily aggregates,
    /// then delete daily rows older than 1 year.
    pub fn run_rollup(&self, now_ms: i64) {
        let guard = self.conn.lock().unwrap();
        if let Some(c) = guard.as_ref() {
            let cutoff_30d: i64 = now_ms - 30 * 24 * 60 * 60_000;
            let cutoff_1y: i64 = now_ms - 365 * 24 * 60 * 60_000;
            let day_ms: i64 = 86_400_000;

            // Aggregate raw rows into daily buckets (INSERT OR REPLACE merges with existing).
            let _ = c.execute(
                "INSERT OR REPLACE INTO server_stats_daily \
                 (server_id, day_ts, avg_cpu, max_cpu, avg_mem, max_mem, avg_players, max_players) \
                 SELECT server_id, \
                        (sampled_at / ?1) * ?1 AS day_ts, \
                        AVG(cpu_pct), MAX(cpu_pct), \
                        AVG(mem_mb),  MAX(mem_mb), \
                        AVG(players), MAX(players) \
                 FROM server_stats_history \
                 WHERE sampled_at < ?2 \
                 GROUP BY server_id, day_ts",
                rusqlite::params![day_ms, cutoff_30d],
            );

            // Remove the raw rows that were just rolled up.
            let _ = c.execute(
                "DELETE FROM server_stats_history WHERE sampled_at < ?1",
                rusqlite::params![cutoff_30d],
            );

            // Prune daily rows beyond 1 year.
            let _ = c.execute(
                "DELETE FROM server_stats_daily WHERE day_ts < ?1",
                rusqlite::params![cutoff_1y],
            );
        }
    }
}
