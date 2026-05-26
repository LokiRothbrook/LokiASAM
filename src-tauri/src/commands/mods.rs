use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use tauri::{Emitter, Manager};
use tokio::io::BufReader;
use tokio::process::Command;

/// ASA Client App ID — used for workshop mod downloads (not the server App ID).
const ASA_CLIENT_APP_ID: &str = "2399830";

/// Progress event payload emitted on `mods://progress/{server_id}` per output line.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModProgressLine {
    pub line: String,
    /// "stdout" or "stderr"
    pub stream: String,
    /// Which mod ID this line belongs to, or None for global messages.
    pub mod_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Internal helpers — install_mods pipeline
// ---------------------------------------------------------------------------

fn build_steamcmd_cmd(path: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new(path);
    cmd.args(args);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd
}

fn emit_mod_line(
    app: &tauri::AppHandle,
    channel: &str,
    stream: &str,
    line: &str,
    mod_id: Option<&str>,
) {
    let _ = app.emit(
        channel,
        ModProgressLine {
            line: line.to_string(),
            stream: stream.to_string(),
            mod_id: mod_id.map(str::to_string),
        },
    );
}

/// Stream stdout + stderr from a child process to a Tauri event channel.
/// Returns the process exit code.
async fn stream_process(
    app: &tauri::AppHandle,
    child: &mut tokio::process::Child,
    channel: &str,
    mod_id: Option<&str>,
) -> Result<i32, String> {
    use tokio::io::AsyncBufReadExt;

    let stdout = child.stdout.take().ok_or("failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("failed to capture stderr")?;

    let mut out_lines = BufReader::new(stdout).lines();
    let mut err_lines = BufReader::new(stderr).lines();

    let app_out = app.clone();
    let ch_out = channel.to_string();
    let mid_out = mod_id.map(str::to_string);
    let stdout_task = tauri::async_runtime::spawn(async move {
        while let Ok(Some(l)) = out_lines.next_line().await {
            emit_mod_line(&app_out, &ch_out, "stdout", &l, mid_out.as_deref());
        }
    });

    let app_err = app.clone();
    let ch_err = channel.to_string();
    let mid_err = mod_id.map(str::to_string);
    let stderr_task = tauri::async_runtime::spawn(async move {
        while let Ok(Some(l)) = err_lines.next_line().await {
            emit_mod_line(&app_err, &ch_err, "stderr", &l, mid_err.as_deref());
        }
    });

    let _ = tokio::join!(stdout_task, stderr_task);
    let status = child.wait().await.map_err(|e| e.to_string())?;
    Ok(status.code().unwrap_or(-1))
}

/// Recursively copy a directory tree from `src` to `dst`.
/// Always copies (no hardlinks) so it works across filesystem boundaries.
async fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
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
                .map_err(|e| format!("copy {} -> {}: {e}", src_p.display(), dst_p.display()))?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Mod browser initialization script
// ---------------------------------------------------------------------------

/// Build the JS initialization script injected into the mod-browser webview.
///
/// `added_mod_ids` — mod IDs already in the server's list. The injected button
/// shows "✓ Already Added" (green, non-clickable) for these instead of the
/// purple "+ Add" button, even before the user has interacted with anything.
///
/// All DOM work is deferred to `DOMContentLoaded` so that `document.body` is
/// guaranteed to exist when the script runs. Attaching DOM mutations before
/// `<body>` is parsed caused `appendChild` to throw and crash CurseForge's
/// React bootstrap, leaving the page white.
fn build_browser_script(server_id: &str, server_name: &str, added_mod_ids: &[String]) -> String {
    let sid = serde_json::to_string(server_id).unwrap_or_default();
    let sname = serde_json::to_string(server_name).unwrap_or_default();
    let added_ids_json =
        serde_json::to_string(added_mod_ids).unwrap_or_else(|_| "[]".to_string());

    format!(
        r#"
(function() {{
    var SERVER_ID   = {sid};
    var SERVER_NAME = {sname};
    var addedIds    = new Set({added_ids_json});

    // Emit a Tauri event from this external-URL webview.
    function ipcEmit(event, payload) {{
        try {{
            window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {{
                event: event,
                payload: JSON.stringify(payload),
            }});
        }} catch (e) {{
            console.error('[LokiASAM] ipcEmit error:', e);
        }}
    }}

    // ── Mod ID / name extraction from CurseForge page ─────────────────────
    function extractModId() {{
        var el = document.querySelector('[data-project-id]');
        if (el) return String(el.getAttribute('data-project-id'));
        var scripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (var i = 0; i < scripts.length; i++) {{
            try {{
                var d = JSON.parse(scripts[i].textContent || '');
                if (d.identifier) return String(d.identifier);
                if (d['@graph']) {{
                    for (var j = 0; j < d['@graph'].length; j++) {{
                        if (d['@graph'][j].identifier) return String(d['@graph'][j].identifier);
                    }}
                }}
            }} catch (e) {{}}
        }}
        var m = window.location.pathname.match(/\/mods\/([^/?#]+)/);
        return m ? m[1] : null;
    }}

    function extractModName() {{
        var sel = 'h1.name, h1.project-title, [class*="ProjectDetails"] h1, [class*="project-title"]';
        var el = document.querySelector(sel);
        return (el && el.textContent.trim())
            || document.title.split(' - ')[0].trim()
            || 'Unknown Mod';
    }}

    // ── Apply visual state to the floating button ─────────────────────────
    function renderBtn(btn, modId) {{
        var already = addedIds.has(modId);
        if (already) {{
            btn.textContent      = '✓ Installed';
            btn.style.background = '#00b060';
            btn.style.border     = '1px solid rgba(0,200,100,0.6)';
            btn.style.boxShadow  = '0 0 24px rgba(0,200,100,0.7)';
            btn.style.cursor     = 'default';
        }} else {{
            btn.textContent      = '+ Add Mod';
            btn.style.background = '#bf00ff';
            btn.style.border     = '1px solid rgba(191,0,255,0.6)';
            btn.style.boxShadow  = '0 0 24px rgba(191,0,255,0.7)';
            btn.style.cursor     = 'pointer';
        }}
    }}

    // ── Floating "Add to server" button ────────────────────────────────────
    function updateAddBtn() {{
        var isModPage = /\/mods\/[^/?#]+/.test(window.location.pathname);
        var btn = document.getElementById('__lokiasam_add_btn');

        if (!isModPage) {{
            if (btn) btn.style.display = 'none';
            return;
        }}

        if (!btn) {{
            btn = document.createElement('button');
            btn.id = '__lokiasam_add_btn';
            btn.style.cssText = [
                'position:fixed;bottom:28px;right:28px;z-index:2147483646',
                'padding:12px 22px;color:#fff',
                'border-radius:10px',
                'font-size:14px;font-weight:700',
                'font-family:system-ui,-apple-system,sans-serif',
                'transition:all 0.18s;line-height:1.2',
            ].join(';');

            btn.addEventListener('click', function() {{
                var modId   = btn.getAttribute('data-mod-id')   || '';
                var modName = btn.getAttribute('data-mod-name') || 'Unknown Mod';
                if (!modId || addedIds.has(modId)) return;
                ipcEmit('mod://add-to-server', {{ serverId: SERVER_ID, modId: modId, modName: modName }});
                addedIds.add(modId);
                renderBtn(btn, modId);
            }});
            document.body.appendChild(btn);
        }}

        var modId = extractModId() || '';
        btn.setAttribute('data-mod-id',   modId);
        btn.setAttribute('data-mod-name', extractModName() || 'Unknown Mod');
        btn.style.display = 'block';
        renderBtn(btn, modId);
    }}

    // ── Bootstrap — deferred to DOMContentLoaded ───────────────────────────
    function init() {{
        updateAddBtn();

        window.addEventListener('popstate', function() {{ setTimeout(updateAddBtn, 600); }});
        ['pushState', 'replaceState'].forEach(function(method) {{
            var orig = history[method].bind(history);
            history[method] = function() {{
                orig.apply(history, arguments);
                setTimeout(updateAddBtn, 600);
            }};
        }});
    }}

    if (document.readyState === 'loading') {{
        document.addEventListener('DOMContentLoaded', init);
    }} else {{
        init();
    }}
}})();
"#,
        sid = sid,
        sname = sname,
        added_ids_json = added_ids_json,
    )
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Download all specified mods via SteamCMD workshop_download_item, cache them,
/// then copy into the server's mod directory.
///
/// SteamCMD places workshop content at:
///   `{steamcmd_dir}/steamapps/workshop/content/2399830/{mod_id}/`
///
/// We then copy to:
///   `{base_dir}/.cache/mods/{mod_id}/`            (shared cache)
///   `{install_path}/ShooterGame/Content/Mods/{mod_id}/`  (server-local)
///
/// Progress is streamed line-by-line to the `mods://progress/{server_id}` event.
#[tauri::command]
pub async fn install_mods(
    server_id: String,
    steamcmd_path: String,
    base_dir: String,
    install_path: String,
    mod_ids: Vec<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let channel = format!("mods://progress/{}", server_id);

    if mod_ids.is_empty() {
        emit_mod_line(&app, &channel, "stdout", "No mods to install.", None);
        return Ok(());
    }

    let steamcmd_dir = Path::new(&steamcmd_path)
        .parent()
        .ok_or("Cannot determine SteamCMD directory from path")?
        .to_path_buf();

    emit_mod_line(
        &app,
        &channel,
        "stdout",
        &format!("Installing {} mod(s)...", mod_ids.len()),
        None,
    );

    for mod_id in &mod_ids {
        emit_mod_line(
            &app,
            &channel,
            "stdout",
            &format!("=== Downloading mod {} ===", mod_id),
            Some(mod_id),
        );

        let mut child = build_steamcmd_cmd(
            &steamcmd_path,
            &[
                "+login",
                "anonymous",
                "+workshop_download_item",
                ASA_CLIENT_APP_ID,
                mod_id,
                "+quit",
            ],
        )
        .spawn()
        .map_err(|e| format!("Failed to launch SteamCMD: {e}"))?;

        let exit_code = stream_process(&app, &mut child, &channel, Some(mod_id)).await?;

        if exit_code != 0 {
            let msg = format!(
                "SteamCMD exited with code {exit_code} for mod {mod_id}. Download failed."
            );
            emit_mod_line(&app, &channel, "stderr", &msg, Some(mod_id));
            return Err(msg);
        }

        let src = steamcmd_dir
            .join("steamapps")
            .join("workshop")
            .join("content")
            .join(ASA_CLIENT_APP_ID)
            .join(mod_id);

        if !src.exists() {
            let msg = format!(
                "Mod files not found after download at: {}",
                src.display()
            );
            emit_mod_line(&app, &channel, "stderr", &msg, Some(mod_id));
            return Err(msg);
        }

        let cache_dest = Path::new(&base_dir)
            .join(".cache")
            .join("mods")
            .join(mod_id);
        emit_mod_line(
            &app,
            &channel,
            "stdout",
            &format!("Caching {} → {}", mod_id, cache_dest.display()),
            Some(mod_id),
        );
        copy_dir_all(&src, &cache_dest).await?;

        let server_dest = Path::new(&install_path)
            .join("ShooterGame")
            .join("Content")
            .join("Mods")
            .join(mod_id);
        emit_mod_line(
            &app,
            &channel,
            "stdout",
            &format!("Installing {} → server", mod_id),
            Some(mod_id),
        );
        copy_dir_all(&cache_dest, &server_dest).await?;

        emit_mod_line(
            &app,
            &channel,
            "stdout",
            &format!("Mod {} installed successfully.", mod_id),
            Some(mod_id),
        );
    }

    emit_mod_line(
        &app,
        &channel,
        "stdout",
        "All mods installed successfully.",
        None,
    );
    Ok(())
}

/// Stub — mod list additions are handled directly via frontend SQLite helpers.
#[tauri::command]
pub async fn add_mod(
    _server_id: String,
    _mod_id: String,
    _mod_name: String,
) -> Result<(), String> {
    Ok(())
}

/// Stub — mod removal is handled directly via frontend SQLite helpers.
#[tauri::command]
pub async fn remove_mod(_server_id: String, _mod_id: String) -> Result<(), String> {
    Ok(())
}

/// Stub — reordering is handled directly via frontend SQLite helpers.
#[tauri::command]
pub async fn reorder_mods(
    _server_id: String,
    _ordered_mod_ids: Vec<String>,
) -> Result<(), String> {
    Ok(())
}

/// Open the CurseForge mod browser as a separate decorated `WebviewWindow`.
///
/// A `WebviewWindow` (stable API) is used instead of the unstable `add_child`
/// approach.  The window is decorated and appears in the taskbar so the user
/// can manage it independently.  The initialization script is still injected
/// so the floating "Add" button works exactly as before.
///
/// If a mod-browser window is already open it is closed and a fresh one is
/// created so the `added_mod_ids` list is always up-to-date.
#[tauri::command]
pub fn open_mod_browser(
    server_id: String,
    server_name: String,
    added_mod_ids: Vec<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let url: tauri::Url = "https://www.curseforge.com/ark-survival-ascended"
        .parse()
        .map_err(|e: url::ParseError| e.to_string())?;

    // Close any existing browser window before opening a fresh one.
    if let Some(existing) = app.get_webview_window("mod-browser") {
        let _ = existing.close();
    }

    let script = build_browser_script(&server_id, &server_name, &added_mod_ids);

    let title = format!("Mod Browser — {server_name}");

    let window = WebviewWindowBuilder::new(&app, "mod-browser", WebviewUrl::External(url))
        .title(&title)
        .inner_size(1100.0, 680.0)
        .min_inner_size(900.0, 600.0)
        .resizable(true)
        .initialization_script(&script)
        .build()
        .map_err(|e| e.to_string())?;

    // Emit browser-closed when the user closes the window via the OS button
    // so the frontend can update its open/closed state.
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            let _ = app_handle.emit("mod://browser-closed", ());
        }
    });

    Ok(())
}

/// Close the mod browser window.
/// Emits `mod://browser-closed` so the frontend can update its open/close state.
#[tauri::command]
pub fn close_mod_browser(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("mod-browser") {
        w.close().map_err(|e| e.to_string())?;
    }
    // Emit immediately — the Destroyed handler above also fires, but emitting
    // here ensures the frontend updates even if the window was already gone.
    let _ = app.emit("mod://browser-closed", ());
    Ok(())
}

// ---------------------------------------------------------------------------
// Mod verification via CurseForge page scraping
// ---------------------------------------------------------------------------

/// Result of verifying a single mod ID against the CurseForge website.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModVerifyResult {
    pub mod_id: String,
    pub name: Option<String>,
    pub verified: bool,
    pub error: Option<String>,
}

/// Extract the mod name from a CurseForge HTML page.
///
/// Tries `<meta property="og:title" content="...">` first (most stable — it's
/// an SEO tag CurseForge will never remove), then falls back to `<title>`.
/// Strips the trailing " | CurseForge" / " - CurseForge" suffix.
fn extract_mod_name(html: &str) -> Option<String> {
    let html_lower = html.to_lowercase();

    // og:title — handles both attribute orderings CurseForge uses
    if let Some(og_pos) = html_lower.find("og:title") {
        let lo = og_pos.saturating_sub(300);
        let hi = (og_pos + 400).min(html.len());
        let snippet = &html[lo..hi];
        let snippet_lower = snippet.to_lowercase();

        for prefix in &[r#"content=""#, r#"content='"#] {
            if let Some(p) = snippet_lower.find(prefix) {
                let start = p + prefix.len();
                let quote = prefix.chars().last().unwrap();
                let rest = &snippet[start..];
                if let Some(end) = rest.find(quote) {
                    let v = rest[..end].trim();
                    if !v.is_empty() {
                        return Some(clean_cf_title(v));
                    }
                }
            }
        }
    }

    // <title> fallback
    if let (Some(s), Some(e)) = (html_lower.find("<title>"), html_lower.find("</title>")) {
        if s < e {
            let t = html[s + 7..e].trim();
            if !t.is_empty() {
                return Some(clean_cf_title(t));
            }
        }
    }

    None
}

fn clean_cf_title(raw: &str) -> String {
    for sep in &[" | CurseForge", " - CurseForge", " | curseforge", " - curseforge"] {
        if let Some(pos) = raw.to_lowercase().find(&sep.to_lowercase()) {
            return raw[..pos].trim().to_string();
        }
    }
    raw.trim().to_string()
}

/// Verify a list of mod IDs by fetching their CurseForge project pages.
///
/// For each ID we GET `https://www.curseforge.com/projects/{id}` (which
/// CurseForge redirects to the canonical slug URL) and check:
///   1. The redirect target contains `/ark-survival-ascended/mods/` — ensures
///      the mod belongs to the correct game.
///   2. The page HTML contains a parseable mod name via og:title or <title>.
///
/// Successfully verified mods come back with `verified: true` and a `name`.
/// Failures come back with `verified: false` and an `error` message.
#[tauri::command]
pub async fn verify_mods(mod_ids: Vec<String>) -> Result<Vec<ModVerifyResult>, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent(
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        )
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();

    for mod_id in mod_ids {
        if mod_id.is_empty() {
            continue;
        }

        if !mod_id.chars().all(|c| c.is_ascii_digit()) {
            results.push(ModVerifyResult {
                mod_id,
                name: None,
                verified: false,
                error: Some("Mod ID must be numeric".to_string()),
            });
            continue;
        }

        let url = format!("https://www.curseforge.com/projects/{}", mod_id);

        match client.get(&url).send().await {
            Ok(response) => {
                let final_url = response.url().to_string();

                if !final_url.contains("/ark-survival-ascended/mods/") {
                    results.push(ModVerifyResult {
                        mod_id,
                        name: None,
                        verified: false,
                        error: Some("Not an ARK: Survival Ascended mod".to_string()),
                    });
                    continue;
                }

                match response.text().await {
                    Ok(html) => match extract_mod_name(&html) {
                        Some(name) => results.push(ModVerifyResult {
                            mod_id,
                            name: Some(name),
                            verified: true,
                            error: None,
                        }),
                        None => results.push(ModVerifyResult {
                            mod_id,
                            name: None,
                            verified: false,
                            error: Some("Could not extract mod name from page".to_string()),
                        }),
                    },
                    Err(e) => results.push(ModVerifyResult {
                        mod_id,
                        name: None,
                        verified: false,
                        error: Some(format!("Failed to read page: {e}")),
                    }),
                }
            }
            Err(e) => {
                let msg = if e.is_timeout() {
                    "Request timed out".to_string()
                } else if e.status().map_or(false, |s| s.as_u16() == 404) {
                    "Mod not found".to_string()
                } else {
                    format!("Network error: {e}")
                };
                results.push(ModVerifyResult {
                    mod_id,
                    name: None,
                    verified: false,
                    error: Some(msg),
                });
            }
        }
    }

    Ok(results)
}
