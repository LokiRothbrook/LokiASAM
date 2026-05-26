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
/// `show_header` — inject a neon header bar (for the frameless overlay window).
///               Pass `false` for the decorated pop-out window (OS chrome is sufficient).
///
/// Key correctness rule: ALL DOM work is deferred inside a `DOMContentLoaded`
/// listener so that `document.body` is guaranteed to exist when the script runs.
/// Attaching a MutationObserver at injection time (before `<body>` is parsed)
/// caused `document.body.appendChild()` to throw, crashing CurseForge's React
/// bootstrap and leaving the page white below the static header.
fn build_browser_script(server_id: &str, server_name: &str, show_header: bool) -> String {
    let sid = serde_json::to_string(server_id).unwrap_or_default();
    let sname = serde_json::to_string(server_name).unwrap_or_default();
    let show_hdr = if show_header { "true" } else { "false" };

    format!(
        r#"
(function() {{
    var SERVER_ID   = {sid};
    var SERVER_NAME = {sname};
    var SHOW_HEADER = {show_hdr};

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

    // ── Overlay header bar ─────────────────────────────────────────────────
    function injectHeader() {{
        if (!SHOW_HEADER || document.getElementById('__lokiasam_hdr')) return;

        var hdr = document.createElement('div');
        hdr.id = '__lokiasam_hdr';
        hdr.style.cssText = [
            'position:fixed;top:0;left:0;right:0;z-index:2147483647;height:38px',
            'background:rgba(8,5,22,0.97)',
            'border-bottom:1px solid rgba(191,0,255,0.4)',
            'display:flex;align-items:center;gap:8px;padding:0 12px',
            'font-family:system-ui,-apple-system,sans-serif',
        ].join(';');

        var title = document.createElement('span');
        title.textContent = 'Mod Browser — ' + SERVER_NAME;
        title.style.cssText = 'flex:1;font-size:13px;font-weight:600;color:#d4b0f0;user-select:none';

        function makeBtn(label, color) {{
            var b = document.createElement('button');
            b.textContent = label;
            b.style.cssText = [
                'padding:3px 10px;border-radius:6px;font-size:11px;font-weight:600',
                'cursor:pointer;border:1px solid;background:rgba(0,0,0,0.35)',
                'color:' + color + ';border-color:' + color + '88',
                'transition:opacity 0.15s;font-family:inherit',
            ].join(';');
            b.addEventListener('mouseenter', function() {{ b.style.opacity = '0.7'; }});
            b.addEventListener('mouseleave', function() {{ b.style.opacity = '1'; }});
            return b;
        }}

        var popBtn   = makeBtn('Pop Out', '#bf00ff');
        var closeBtn = makeBtn('Close',   '#ff5555');

        popBtn.addEventListener('click', function() {{
            ipcEmit('mod://popout-browser', {{ serverId: SERVER_ID, currentUrl: window.location.href }});
        }});
        closeBtn.addEventListener('click', function() {{
            ipcEmit('mod://close-browser', {{ serverId: SERVER_ID }});
        }});

        hdr.appendChild(title);
        hdr.appendChild(popBtn);
        hdr.appendChild(closeBtn);
        document.body.insertBefore(hdr, document.body.firstChild);
        document.documentElement.style.paddingTop = '38px';
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
                'padding:12px 22px;background:#bf00ff;color:#fff',
                'border:1px solid rgba(191,0,255,0.6);border-radius:10px',
                'font-size:14px;font-weight:700',
                'font-family:system-ui,-apple-system,sans-serif',
                'cursor:pointer;box-shadow:0 0 24px rgba(191,0,255,0.7)',
                'transition:all 0.18s;line-height:1.2',
            ].join(';');

            btn.addEventListener('mouseenter', function() {{
                btn.style.background  = '#d400ff';
                btn.style.boxShadow   = '0 0 36px rgba(191,0,255,1)';
            }});
            btn.addEventListener('mouseleave', function() {{
                btn.style.background  = '#bf00ff';
                btn.style.boxShadow   = '0 0 24px rgba(191,0,255,0.7)';
            }});
            btn.addEventListener('click', function() {{
                var modId   = btn.getAttribute('data-mod-id')   || '';
                var modName = btn.getAttribute('data-mod-name') || 'Unknown Mod';
                if (!modId) {{
                    btn.textContent = 'Mod ID not found';
                    setTimeout(function() {{ btn.textContent = '+ Add to ' + SERVER_NAME; }}, 2000);
                    return;
                }}
                ipcEmit('mod://add-to-server', {{ serverId: SERVER_ID, modId: modId, modName: modName }});
                btn.textContent       = 'Added to ' + SERVER_NAME + '!';
                btn.style.background  = '#00b060';
                btn.style.boxShadow   = '0 0 24px rgba(0,200,100,0.7)';
                setTimeout(function() {{
                    btn.textContent      = '+ Add to ' + SERVER_NAME;
                    btn.style.background = '#bf00ff';
                    btn.style.boxShadow  = '0 0 24px rgba(191,0,255,0.7)';
                }}, 2200);
            }});
            document.body.appendChild(btn);
        }}

        btn.setAttribute('data-mod-id',   extractModId()   || '');
        btn.setAttribute('data-mod-name', extractModName() || 'Unknown Mod');
        btn.textContent   = '+ Add to ' + SERVER_NAME;
        btn.style.display = 'block';
    }}

    // ── Bootstrap — deferred to DOMContentLoaded ───────────────────────────
    function init() {{
        injectHeader();
        updateAddBtn();

        // Wire SPA navigation hooks after page has loaded.
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
        show_hdr = show_hdr,
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

        // SteamCMD places files at: {steamcmd_dir}/steamapps/workshop/content/2399830/{mod_id}
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

        // Copy to shared cache: {base_dir}/.cache/mods/{mod_id}
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

        // Copy from cache to server: {install_path}/ShooterGame/Content/Mods/{mod_id}
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

/// Open the CurseForge mod browser as a frameless overlay window positioned
/// exactly over the main window's inner content area.
///
/// The overlay injects a neon header bar (Close / Pop Out buttons) and a
/// floating "+ Add to [Server]" button on mod detail pages.
///
/// All DOM work in the init script is deferred to `DOMContentLoaded` so that
/// `document.body` is guaranteed to exist — avoiding the TypeError that
/// previously crashed CurseForge's React bootstrap and left the page white.
#[tauri::command]
pub fn open_mod_browser(
    server_id: String,
    server_name: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let url: tauri::Url = "https://www.curseforge.com/ark-survival-ascended"
        .parse()
        .map_err(|e: url::ParseError| e.to_string())?;

    // Close any previously-opened mod browser before opening a new one.
    if let Some(existing) = app.get_webview_window("mod-browser") {
        let _ = existing.close();
    }

    // Position the frameless overlay to exactly cover the main window's webview.
    let main_win = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;
    let pos   = main_win.inner_position().map_err(|e| e.to_string())?;
    let size  = main_win.inner_size().map_err(|e| e.to_string())?;
    let scale = main_win.scale_factor().map_err(|e| e.to_string())?;

    let x = pos.x as f64 / scale;
    let y = pos.y as f64 / scale;
    let w = size.width  as f64 / scale;
    let h = size.height as f64 / scale;

    let script = build_browser_script(&server_id, &server_name, true);

    WebviewWindowBuilder::new(&app, "mod-browser", WebviewUrl::External(url))
        .title(format!("Mod Browser — {}", server_name))
        .inner_size(w, h)
        .position(x, y)
        .decorations(false)
        .always_on_top(true)
        .initialization_script(&script)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Close the mod browser window (overlay or popped-out decorated).
/// Emits `mod://browser-closed` so the frontend can update its open/close state.
#[tauri::command]
pub fn close_mod_browser(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("mod-browser") {
        w.close().map_err(|e| e.to_string())?;
    }
    let _ = app.emit("mod://browser-closed", ());
    Ok(())
}

/// Convert the frameless overlay into a standard decorated window.
///
/// Closes the overlay and opens a new decorated window at `current_url`
/// (passed by the overlay's "Pop Out" button via `mod://popout-browser` event).
/// Registers a `Destroyed` handler on the new window so `mod://browser-closed`
/// fires when the user closes it via the OS title-bar button.
#[tauri::command]
pub fn popout_mod_browser(
    server_id: String,
    server_name: String,
    current_url: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    // Close the overlay without emitting browser-closed (we're reopening it).
    if let Some(w) = app.get_webview_window("mod-browser") {
        let _ = w.close();
    }

    let url: tauri::Url = current_url
        .parse()
        .unwrap_or_else(|_| {
            "https://www.curseforge.com/ark-survival-ascended"
                .parse()
                .unwrap()
        });

    let script = build_browser_script(&server_id, &server_name, false);

    let browser = WebviewWindowBuilder::new(&app, "mod-browser", WebviewUrl::External(url))
        .title(format!("Mod Browser — {}", server_name))
        .inner_size(1360.0, 920.0)
        .resizable(true)
        .decorations(true)
        .always_on_top(false)
        .initialization_script(&script)
        .build()
        .map_err(|e| e.to_string())?;

    // Emit mod://browser-closed when the OS-chrome window is closed by the user.
    let app_clone = app.clone();
    browser.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            let _ = app_clone.emit("mod://browser-closed", ());
        }
    });

    Ok(())
}
