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

    let mut in_app_enabled = true;  // default: show toast
    let mut bell_enabled   = true;  // default: show unread badge
    let mut desktop_active = false;

    for cfg in &configs {
        let channel = cfg.channel.as_str();
        if seen_channels.contains(channel) { continue; }
        // Per-server configs "own" the channel; global configs only apply if no per-server row.
        if cfg.server_id.is_some() { seen_channels.insert(channel.to_string()); }

        if !event_enabled(&cfg.events_json, event_type) { continue; }

        match channel {
            "in_app" => {
                in_app_enabled = cfg.enabled == 1;
            }
            "bell" => {
                bell_enabled = cfg.enabled == 1;
            }
            "desktop" if cfg.enabled == 1 => {
                desktop_active = true;
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
            "discord" if cfg.enabled == 1 => {
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
            _ => {}
        }
    }

    // ── Log to in_app_notifications ────────────────────────────────────────
    let visible_channel_active = in_app_enabled || desktop_active;
    let show_unread = bell_enabled && visible_channel_active;

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

fn event_enabled(events_json: &str, event_type: &str) -> bool {
    let events: Vec<String> = serde_json::from_str(events_json).unwrap_or_default();
    events.is_empty() || events.iter().any(|e| e == event_type)
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
