use serde::{Deserialize, Serialize};

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
    let body = serde_json::json!({
        "embeds": [{
            "title": payload.title,
            "description": payload.description,
            "color": payload.color,
            "fields": [
                { "name": "Event",  "value": payload.event_type,  "inline": true },
                { "name": "Server", "value": payload.server_name, "inline": true }
            ],
            "footer": { "text": "LokiASAM" }
        }]
    });

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
