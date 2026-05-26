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
    // navDepth is declared here so the pushState/popstate closures share it.
    var navDepth = 0;

    function init() {{
        updateAddBtn();

        // ── Back button (created inside init so body exists) ──────────────
        var backBtn = document.createElement('button');
        backBtn.id = '__lokiasam_back_btn';
        backBtn.textContent = '←';
        backBtn.style.cssText = [
            'position:fixed;bottom:28px;left:28px;z-index:2147483646',
            'width:36px;height:36px;display:none',
            'align-items:center;justify-content:center',
            'border-radius:8px',
            'font-size:18px;font-weight:700;color:#fff',
            'background:rgba(191,0,255,0.25);border:1px solid rgba(191,0,255,0.5)',
            'box-shadow:0 0 16px rgba(191,0,255,0.4)',
            'cursor:pointer;font-family:system-ui,-apple-system,sans-serif',
            'transition:all 0.18s;line-height:1',
        ].join(';');
        backBtn.addEventListener('click', function() {{ window.history.back(); }});
        document.body.appendChild(backBtn);

        function updateBackBtn() {{
            backBtn.style.display = navDepth > 0 ? 'flex' : 'none';
        }}

        window.addEventListener('popstate', function() {{
            navDepth = Math.max(0, navDepth - 1);
            updateBackBtn();
            setTimeout(updateAddBtn, 600);
        }});
        ['pushState', 'replaceState'].forEach(function(method) {{
            var orig = history[method].bind(history);
            history[method] = function() {{
                if (method === 'pushState') {{ navDepth++; }}
                orig.apply(history, arguments);
                updateBackBtn();
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
        .inner_size(1300.0, 680.0)
        .min_inner_size(1300.0, 600.0)
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
// Mod verification via hidden WebviewWindow (bypasses Cloudflare)
// ---------------------------------------------------------------------------

/// Build the JS initialization script injected into the hidden mod-verify webview.
///
/// The script navigates sequentially through each mod ID's CurseForge project
/// URL, extracts the mod name from the page, and emits results back to the
/// main window via Tauri IPC events.  State is persisted in `sessionStorage`
/// so it survives between page navigations within the same webview.
///
/// Events emitted per mod:
///   `mod://add-to-server`  — mod verified successfully (source: "verify")
///   `mod://verify-skip`    — mod is already in the server's installed list
///   `mod://verify-fail`    — mod could not be verified (wrong game, no name, etc.)
///
/// After all IDs are processed: `mod://verify-complete`
fn build_verify_script(mod_ids: &[String], server_id: &str, added_mod_ids: &[String]) -> String {
    let sid = serde_json::to_string(server_id).unwrap_or_default();
    let ids_json = serde_json::to_string(mod_ids).unwrap_or_else(|_| "[]".to_string());
    let added_json = serde_json::to_string(added_mod_ids).unwrap_or_else(|_| "[]".to_string());

    format!(
        r#"
(function() {{
    var STATE_KEY  = '__lokiasam_verify';
    var SERVER_ID  = {sid};
    var INITIAL_IDS = {ids_json};
    var ADDED_IDS  = new Set({added_json});

    function ipcEmit(event, payload) {{
        try {{
            window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {{
                event: event,
                payload: JSON.stringify(payload),
            }});
        }} catch (e) {{}}
    }}

    function extractModName() {{
        var sel = 'h1.name, h1.project-title, [class*="ProjectDetails"] h1, [class*="project-title"]';
        var el = document.querySelector(sel);
        return (el && el.textContent.trim()) ||
               document.title.split(' | ')[0].split(' - ')[0].trim() ||
               null;
    }}

    var raw   = sessionStorage.getItem(STATE_KEY);
    var state = raw ? JSON.parse(raw) : {{ ids: INITIAL_IDS, index: 0 }};

    function saveState() {{ sessionStorage.setItem(STATE_KEY, JSON.stringify(state)); }}

    function navigateToNext() {{
        if (state.index >= state.ids.length) {{
            sessionStorage.removeItem(STATE_KEY);
            ipcEmit('mod://verify-complete', {{}});
            return;
        }}
        window.location.href = 'https://www.curseforge.com/projects/' + state.ids[state.index];
    }}

    function process() {{
        if (state.ids.length === 0 || state.index >= state.ids.length) {{
            sessionStorage.removeItem(STATE_KEY);
            ipcEmit('mod://verify-complete', {{}});
            return;
        }}

        var href = window.location.href;

        // Still on the initial blank page — trigger first navigation
        if (!href || href === 'about:blank') {{
            navigateToNext();
            return;
        }}

        // Cloudflare challenge — do nothing; CF's own JS will redirect when done
        if (document.title === 'Just a moment...' ||
            !!document.querySelector('#challenge-form, #challenge-running')) {{
            return;
        }}

        var modId = state.ids[state.index];

        if (href.indexOf('/ark-survival-ascended/mods/') !== -1) {{
            var name = extractModName();
            if (!name) {{
                ipcEmit('mod://verify-fail', {{ modId: modId, error: 'Could not extract mod name' }});
            }} else if (ADDED_IDS.has(modId)) {{
                ipcEmit('mod://verify-skip', {{ modId: modId }});
            }} else {{
                ipcEmit('mod://add-to-server', {{
                    serverId: SERVER_ID,
                    modId: modId,
                    modName: name,
                    source: 'verify',
                }});
            }}
        }} else {{
            ipcEmit('mod://verify-fail', {{ modId: modId, error: 'Not an ARK: Survival Ascended mod' }});
        }}

        state.index++;
        saveState();
        navigateToNext();
    }}

    if (document.readyState === 'loading') {{
        document.addEventListener('DOMContentLoaded', process);
    }} else {{
        process();
    }}
}})();
"#,
        sid = sid,
        ids_json = ids_json,
        added_json = added_json,
    )
}

/// Open a hidden WebviewWindow that navigates sequentially through the given
/// mod IDs on CurseForge, extracting names and emitting results as Tauri events.
///
/// The window uses the real browser engine (WebKitGTK / WebView2) which bypasses
/// Cloudflare's bot-detection that blocks plain HTTP clients like reqwest.
///
/// Returns immediately — all results arrive asynchronously via:
///   `mod://add-to-server` (source: "verify"), `mod://verify-fail`,
///   `mod://verify-skip`, and finally `mod://verify-complete`.
#[tauri::command]
pub fn start_mod_verification(
    mod_ids: Vec<String>,
    server_id: String,
    added_mod_ids: Vec<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    if mod_ids.is_empty() {
        return Ok(());
    }

    // Close any previous verify window before opening a fresh one.
    if let Some(existing) = app.get_webview_window("mod-verify") {
        let _ = existing.close();
    }

    let script = build_verify_script(&mod_ids, &server_id, &added_mod_ids);

    let first_url: tauri::Url = format!("https://www.curseforge.com/projects/{}", mod_ids[0])
        .parse()
        .map_err(|e: url::ParseError| e.to_string())?;

    WebviewWindowBuilder::new(&app, "mod-verify", WebviewUrl::External(first_url))
        .title("Mod Verification")
        .inner_size(800.0, 600.0)
        .visible(false)
        .initialization_script(&script)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Close the hidden mod-verify window if it is open.
#[tauri::command]
pub fn close_mod_verify(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("mod-verify") {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
