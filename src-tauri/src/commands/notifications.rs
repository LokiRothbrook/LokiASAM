use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::db;
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Rust-side notification dispatcher
// ---------------------------------------------------------------------------

/// Dispatch a notification from Rust — works even when the WebKit webview is
/// throttled in the system tray.
///
/// For each enabled channel config:
///  - "desktop": fires an OS desktop notification
///  - "discord": POSTs an embed to the configured webhook
///  - "email":   sends via SMTP (best-effort)
///
/// Always logs the notification to `in_app_notifications` in SQLite so the
/// in-app notification center is complete even if the frontend missed the event.
///
/// Emits two events for the frontend:
///  - `notification://toast`  → frontend shows a Sonner toast (if window visible)
///  - `notification://logged` → frontend updates the bell badge unread count
pub async fn dispatch_notification(
    app: &tauri::AppHandle,
    event_type: &str,
    server_id: Option<&str>,
    server_name: &str,
    title: &str,
    body: &str,
    severity: &str,
) {
    // ── Load DB connection ─────────────────────────────────────────────────
    let db_path = {
        let state = app.state::<AppState>();
        match state.get_db_path() {
            Some(p) => p,
            None => return, // DB not ready yet
        }
    };
    let conn = match db::open(&db_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[notify] Failed to open DB: {e}");
            return;
        }
    };

    // ── Load notification configs ──────────────────────────────────────────
    let configs = db::get_notification_configs(&conn, server_id);

    // Track which channels we've processed (per-server configs take precedence).
    let mut seen_channels = std::collections::HashSet::new();

    // Defaults when no config row exists for a channel: toast + bell on,
    // everything else off (matches the frontend dispatcher and the matrix).
    let mut in_app_enabled = true;
    let mut bell_enabled   = true;

    for cfg in &configs {
        let channel = cfg.channel.as_str();
        if seen_channels.contains(channel) { continue; }
        // Per-server configs "own" the channel; global configs only apply if no per-server row.
        if cfg.server_id.is_some() { seen_channels.insert(channel.to_string()); }

        // A channel is on for this event only when the channel is enabled AND
        // the event is ticked for it. (In-App/Bell used to skip this check for
        // unticked events, leaving them at their "on" default — so backend
        // events like "server online" ignored the matrix toggles.)
        let on = cfg.enabled == 1 && event_enabled(&cfg.events_json, event_type);

        match channel {
            "in_app" => in_app_enabled = on,
            "bell"   => bell_enabled = on,
            "desktop" if on => {
                let app2  = app.clone();
                let title = title.to_string();
                let body  = body.to_string();
                tauri::async_runtime::spawn(async move {
                    use tauri_plugin_notification::NotificationExt;
                    let _ = app2.notification()
                        .builder()
                        .title(&title)
                        .body(&body)
                        .show();
                });
            }
            "discord" if on => {
                let cfg_json: serde_json::Value =
                    serde_json::from_str(&cfg.config_json).unwrap_or_default();
                if let Some(url) = cfg_json.get("webhookUrl").and_then(|u| u.as_str()) {
                    let state = app.state::<AppState>();
                    let payload = build_discord_embed(title, body, severity_color(severity), event_type, server_name);
                    let client = state.http_client.clone();
                    let url = url.to_string();
                    tauri::async_runtime::spawn(async move {
                        let _ = client.post(&url).json(&payload).send().await;
                    });
                }
            }
            "email" if on => {
                let c: serde_json::Value = serde_json::from_str(&cfg.config_json).unwrap_or_default();
                let s = |k: &str| c.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string();
                let (host, to_address) = (s("host"), s("toAddress"));
                if !host.is_empty() && !to_address.is_empty() {
                    let smtp = SmtpConfig {
                        host,
                        port: c.get("port").and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|p| p.parse().ok()))).unwrap_or(587) as u16,
                        username: s("username"),
                        password: s("password"),
                        from_address: Some(s("fromAddress")).filter(|f| !f.is_empty()).unwrap_or_else(|| "noreply@lokiasam".into()),
                        to_address,
                        use_tls: c.get("useTls").and_then(|v| v.as_bool()).unwrap_or(false),
                    };
                    let payload = EmailPayload { subject: title.to_string(), body: body.to_string() };
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = send_email_notification(smtp, payload).await {
                            eprintln!("[notify] email failed: {e}");
                        }
                    });
                }
            }
            _ => {}
        }
    }

    // ── Log to in_app_notifications ────────────────────────────────────────
    // Always archived; unread in the bell exactly when the Bell column is
    // ticked for this event (independent of the toast/desktop columns).
    let show_unread = bell_enabled;

    let id = uuid::Uuid::new_v4().to_string();
    let _ = db::log_notification(&conn, &db::NotifInsert {
        id:         &id,
        server_id,
        event_type,
        title,
        body,
        severity,
        read:       if show_unread { 0 } else { 1 },
    });

    // ── Signal the frontend ────────────────────────────────────────────────
    // Toast: show when window is visible
    if in_app_enabled {
        let _ = app.emit("notification://toast", serde_json::json!({
            "severity": severity,
            "title":    title,
            "body":     body,
        }));
    }
    // Bell badge: always emit so the badge stays accurate even after restore from tray
    let _ = app.emit("notification://logged", serde_json::json!({
        "serverId": server_id,
        "unread":   show_unread,
    }));
}

/// Build the Discord embed JSON body shared by the auto-dispatch "discord"
/// channel and the manual `send_discord_notification` command, so the two
/// can't drift out of sync with each other.
fn build_discord_embed(title: &str, description: &str, color: u32, event_type: &str, server_name: &str) -> serde_json::Value {
    serde_json::json!({
        "embeds": [{
            "title": title,
            "description": description,
            "color": color,
            "fields": [
                { "name": "Event",  "value": event_type,  "inline": true },
                { "name": "Server", "value": server_name, "inline": true }
            ],
            "footer": { "text": "LokiASAM" }
        }]
    })
}

fn severity_color(severity: &str) -> u32 {
    match severity {
        "success" => 0x00ff88,
        "warning" => 0xffaa00,
        "error"   => 0xff0055,
        _         => 0x00ffff,
    }
}

/// The channel row lists exactly the events it's on for — an empty list means
/// none (migration 025 rewrote legacy "[]" rows, which meant "all", into an
/// explicit list). Unparseable JSON falls back to on rather than silencing.
fn event_enabled(events_json: &str, event_type: &str) -> bool {
    match serde_json::from_str::<Vec<String>>(events_json) {
        Ok(events) => events.iter().any(|e| e == event_type),
        Err(_) => true,
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiscordPayload {
    pub title: String,
    pub description: String,
    /// Discord embed color integer (e.g. 0x00ff88 for green).
    pub color: u32,
    pub server_name: String,
    pub event_type: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub from_address: String,
    pub to_address: String,
    pub use_tls: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EmailPayload {
    pub subject: String,
    pub body: String,
}

/// POST a Discord embed message to a webhook URL.
///
/// Uses the shared `reqwest::Client` from AppState to reuse connection pools and TLS sessions.
#[tauri::command]
pub async fn send_discord_notification(
    state: tauri::State<'_, crate::state::AppState>,
    webhook_url: String,
    payload: DiscordPayload,
) -> Result<(), String> {
    let body = build_discord_embed(&payload.title, &payload.description, payload.color, &payload.event_type, &payload.server_name);

    let response = state
        .http_client
        .post(&webhook_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Discord request failed: {e}"))?;

    if response.status().is_success() || response.status().as_u16() == 204 {
        Ok(())
    } else {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        Err(format!("Discord webhook returned {status}: {text}"))
    }
}

/// Send an email via SMTP using the `lettre` crate.
///
/// Supports both TLS (port 465) and STARTTLS/plain (port 587 / 25) via `use_tls`.
/// Credentials are passed directly — no storage on the Rust side.
#[tauri::command]
pub async fn send_email_notification(
    smtp_config: SmtpConfig,
    payload: EmailPayload,
) -> Result<(), String> {
    use lettre::{
        message::header::ContentType, transport::smtp::authentication::Credentials,
        AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    };

    let from: lettre::message::Mailbox = smtp_config
        .from_address
        .parse()
        .map_err(|e| format!("Invalid from address: {e}"))?;
    let to: lettre::message::Mailbox = smtp_config
        .to_address
        .parse()
        .map_err(|e| format!("Invalid to address: {e}"))?;

    let email = Message::builder()
        .from(from)
        .to(to)
        .subject(&payload.subject)
        .header(ContentType::TEXT_PLAIN)
        .body(payload.body)
        .map_err(|e| format!("Failed to build email: {e}"))?;

    let creds = Credentials::new(smtp_config.username, smtp_config.password);

    if smtp_config.use_tls {
        // TLS-wrapped connection (port 465)
        let transport = AsyncSmtpTransport::<Tokio1Executor>::relay(&smtp_config.host)
            .map_err(|e| format!("Failed to build SMTP transport: {e}"))?
            .credentials(creds)
            .port(smtp_config.port)
            .build();
        transport
            .send(email)
            .await
            .map_err(|e| format!("SMTP send failed: {e}"))?;
    } else {
        // STARTTLS or plain (port 587 / 25)
        let transport =
            AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&smtp_config.host)
                .map_err(|e| format!("Failed to build SMTP transport: {e}"))?
                .credentials(creds)
                .port(smtp_config.port)
                .build();
        transport
            .send(email)
            .await
            .map_err(|e| format!("SMTP send failed: {e}"))?;
    }

    Ok(())
}

/// Show an OS desktop toast notification via `tauri-plugin-notification`.
#[tauri::command]
pub async fn send_os_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| e.to_string())
}
