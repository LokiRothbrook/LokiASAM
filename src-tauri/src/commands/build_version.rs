// build_version.rs — ASA build ID → human-readable game version (e.g. "49.23")
//
// Two sources, in priority order:
//   "internet" – Steam News API title parse, fetched once per build_id right
//                after SteamCMD downloads it (so the latest news matches the
//                latest build).
//   "server"   – A2S_INFO Source Query against localhost once the server
//                confirms running. Always overwrites "internet".

use crate::{db, state::AppState};
use tauri::Manager;

// ── Version sources ───────────────────────────────────────────────────────────

const OFFICIAL_SERVER_LIST_URL: &str =
    "https://cdn2.arkdedicated.com/servers/asa/officialserverlist.json";

const PATCH_NOTES_URL: &str =
    "https://survivetheark.com/index.php?/forums/topic/708761-asa-pc-patch-notes-client";

/// Fetch the current ASA version from the official Wildcard server list.
/// This is the same JSON the game client uses for the server browser, so it
/// reflects the live version exactly. Returns e.g. "88.23".
async fn fetch_version_from_official_list() -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Entry {
        #[serde(rename = "BuildId")]
        build_id: u32,
        #[serde(rename = "MinorBuildId")]
        minor_build_id: u32,
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("LokiASAM/1.0")
        .build()
        .ok()?;

    let entries: Vec<Entry> = client
        .get(OFFICIAL_SERVER_LIST_URL)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;

    let first = entries.into_iter().next()?;
    Some(format!("{}.{}", first.build_id, first.minor_build_id))
}

/// Extract "88.3" from text like "v88.3 - Major version for Servers…"
/// Requires at least a 2-digit major so single-digit noise is skipped.
fn extract_version_from_patch_notes(text: &str) -> Option<String> {
    let s = text.as_bytes();
    let mut i = 0;
    while i < s.len() {
        // Require explicit 'v' / 'V' prefix so bare numbers are ignored
        if (s[i] != b'v' && s[i] != b'V') || i + 1 >= s.len() || !s[i + 1].is_ascii_digit() {
            i += 1;
            continue;
        }
        let num_start = i + 1;
        let mut j = num_start;
        while j < s.len() && s[j].is_ascii_digit() { j += 1; }
        let major_len = j - num_start;
        if major_len < 2 || j >= s.len() || s[j] != b'.' {
            i += 1;
            continue;
        }
        j += 1; // skip dot
        let minor_start = j;
        while j < s.len() && s[j].is_ascii_digit() { j += 1; }
        if j == minor_start {
            i += 1;
            continue;
        }
        // Return "MAJOR.MINOR" (drop any trailing .patch suffix)
        return Some(text[num_start..j].to_string());
    }
    None
}

/// Fetch the most recent ASA version string from the survivetheark.com patch
/// notes thread. The forum meta description always leads with the newest entry
/// so we only need to parse those first few hundred characters.
async fn fetch_version_from_patch_notes() -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 \
                     (KHTML, like Gecko) Chrome/125.0 Safari/537.36")
        .build()
        .ok()?;

    let html = client.get(PATCH_NOTES_URL).send().await.ok()?.text().await.ok()?;

    // The forum renders the first ~300 chars of post body as the meta description,
    // which always starts with the most recently prepended version entry.
    let meta_start = html.find("<meta name=\"description\" content=\"")?
        + "<meta name=\"description\" content=\"".len();
    let meta_end = meta_start + html[meta_start..].find('"')?;
    let description = &html[meta_start..meta_end];

    extract_version_from_patch_notes(description)
}

// ── A2S_INFO Source Query ─────────────────────────────────────────────────────

/// Query localhost Source Query port for the game version string.
/// Handles both plain responses and the challenge-response handshake.
pub async fn source_query_version(port: u16) -> Option<String> {
    use tokio::net::UdpSocket;
    use tokio::time::{timeout, Duration};

    let sock = UdpSocket::bind("0.0.0.0:0").await.ok()?;
    sock.connect(format!("127.0.0.1:{port}")).await.ok()?;

    let base_req: &[u8] = b"\xFF\xFF\xFF\xFF\x54Source Engine Query\x00";
    let mut req = base_req.to_vec();

    sock.send(&req).await.ok()?;

    let mut buf = [0u8; 1400];

    // Up to two rounds: initial send + one challenge re-send
    for _ in 0..2u8 {
        let n = timeout(Duration::from_secs(5), sock.recv(&mut buf))
            .await
            .ok()?.ok()?;

        if n < 5 || buf[0..4] != [0xFF, 0xFF, 0xFF, 0xFF] {
            return None;
        }

        match buf[4] {
            0x41 => {
                // Challenge response — resend query with 4-byte challenge appended
                if n < 9 {
                    return None;
                }
                let mut new_req = base_req.to_vec();
                new_req.extend_from_slice(&buf[5..9]);
                req = new_req;
                sock.send(&req).await.ok()?;
            }
            0x49 => {
                // A2S_INFO response — parse for version string
                return parse_a2s_version(&buf[5..n]);
            }
            _ => return None,
        }
    }
    None
}

/// Parse an A2S_INFO response body (after the 0xFF×4 0x49 header) for the
/// version string. Layout: protocol(1), name, map, folder, game (null-term
/// strings), app_id(2), players(1), max_players(1), bots(1), server_type(1),
/// environment(1), visibility(1), vac(1), version (null-term string).
fn parse_a2s_version(data: &[u8]) -> Option<String> {
    use super::utils::read_cstring;

    let mut pos = 1; // skip protocol byte

    // Skip four null-terminated strings: name, map, folder, game
    for _ in 0..4 {
        read_cstring(data, &mut pos).ok()?;
    }

    // Skip: app_id(2) + players(1) + max_players(1) + bots(1) +
    //        server_type(1) + environment(1) + visibility(1) + vac(1) = 9 bytes
    pos += 9;

    if pos >= data.len() {
        return None;
    }

    let version = read_cstring(data, &mut pos).ok()?;
    if version.is_empty() {
        return None;
    }

    // Normalise to "MAJOR.MINOR" (e.g. "49.23.0" → "49.23")
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() >= 2 {
        Some(format!("{}.{}", parts[0], parts[1]))
    } else {
        Some(version)
    }
}

// ── Public helpers called by steamcmd.rs and server.rs ───────────────────────

/// After SteamCMD downloads a new build: store the build_id against the server
/// row and fetch the internet version if this build_id isn't cached yet.
/// Runs the internet fetch in a background task (fire and forget).
pub fn record_install(app: &tauri::AppHandle, server_id: &str, build_id: &str) {
    let Some(db_path) = app.state::<AppState>().get_db_path() else { return };
    if let Ok(conn) = db::open(&db_path) {
        let _ = db::set_server_installed_build(&conn, server_id, build_id);
    }
    maybe_fetch_internet(app, build_id);
}

/// Trigger an internet version fetch for a build_id unless already
/// server-confirmed. Spawns a background task — does not block.
/// Re-fetches on every call when source is "internet" so a failed parse
/// (game_version = null) is retried on each update check.
pub fn maybe_fetch_internet(app: &tauri::AppHandle, build_id: &str) {
    let Some(db_path) = app.state::<AppState>().get_db_path() else { return };

    // Skip only if server-confirmed — internet entries may lack a version and
    // should be retried until we get one (or the server query overwrites them)
    if let Ok(conn) = db::open(&db_path) {
        if let Some((_, src)) = db::get_build_game_version(&conn, build_id) {
            if src == "server" {
                return;
            }
        }
    } else {
        return;
    }

    let build_id = build_id.to_string();
    tauri::async_runtime::spawn(async move {
        // Try the official Wildcard server list first (real-time, structured JSON).
        // Fall back to the survivetheark.com forum post if that fails.
        let version = match fetch_version_from_official_list().await {
            Some(v) => Some(v),
            None => fetch_version_from_patch_notes().await,
        };
        if let Ok(conn) = db::open(&db_path) {
            let _ = db::upsert_build_game_version(
                &conn,
                &build_id,
                version.as_deref(),
                "internet",
            );
        }
    });
}

/// After a server confirms running: try A2S to get the server-confirmed version
/// and store it (overwrites "internet" source). Fire and forget.
pub fn maybe_capture_server_version(app: &tauri::AppHandle, server_id: &str, query_port: u16) {
    let Some(db_path) = app.state::<AppState>().get_db_path() else { return };

    // Read the installed_build_id for this server
    let build_id = {
        let Ok(conn) = db::open(&db_path) else { return };
        match conn.query_row(
            "SELECT installed_build_id FROM servers WHERE id = ?1",
            [server_id],
            |row| row.get::<_, Option<String>>(0),
        ) {
            Ok(Some(b)) => b,
            _ => return,
        }
    };

    // Skip if already server-confirmed
    {
        let Ok(conn) = db::open(&db_path) else { return };
        if let Some((_, src)) = db::get_build_game_version(&conn, &build_id) {
            if src == "server" {
                return;
            }
        }
    }

    tauri::async_runtime::spawn(async move {
        if let Some(version) = source_query_version(query_port).await {
            if let Ok(conn) = db::open(&db_path) {
                let _ = db::upsert_build_game_version(
                    &conn,
                    &build_id,
                    Some(&version),
                    "server",
                );
            }
        }
    });
}

// ── Tauri command ─────────────────────────────────────────────────────────────

/// Manually trigger an internet version fetch for a build_id. Returns the
/// game_version if now available, or None if the fetch failed / build unknown.
#[tauri::command]
pub async fn fetch_build_version(
    build_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    let db_path = state.get_db_path().ok_or("DB path not set")?;

    // Always re-fetch (user triggered) — official list first, forum scrape fallback
    let version = match fetch_version_from_official_list().await {
        Some(v) => Some(v),
        None => fetch_version_from_patch_notes().await,
    };
    let conn = db::open(&db_path)?;
    db::upsert_build_game_version(&conn, &build_id, version.as_deref(), "internet")?;
    Ok(version)
}
