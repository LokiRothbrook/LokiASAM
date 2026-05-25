use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::Mutex;

/// Tracks active log-tail tasks keyed by server UUID.
/// Each value is a shared flag; setting it to `true` signals the background
/// task to stop polling the file.
pub struct LogWatcherState {
    pub tokens: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl LogWatcherState {
    pub fn new() -> Self {
        Self {
            tokens: Mutex::new(HashMap::new()),
        }
    }

    /// Create a fresh stop-flag for `server_id`, cancelling the previous one
    /// if it existed.  Returns the new flag for the spawned task to poll.
    pub async fn start(&self, server_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Some(old) = self
            .tokens
            .lock()
            .await
            .insert(server_id.to_string(), flag.clone())
        {
            old.store(true, Ordering::Relaxed);
        }
        flag
    }

    /// Signal the watcher for `server_id` to stop and remove it from the map.
    pub async fn stop(&self, server_id: &str) {
        if let Some(flag) = self.tokens.lock().await.remove(server_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}
