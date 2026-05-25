use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiscordPayload {
    pub title: String,
    pub description: String,
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

/// POST a Discord embed message to a webhook URL using `reqwest`.
#[tauri::command]
pub async fn send_discord_notification(
    _webhook_url: String,
    _payload: DiscordPayload,
) -> Result<(), String> {
    Err("Not implemented".into())
}

/// Send an email notification via SMTP using the `lettre` crate.
#[tauri::command]
pub async fn send_email_notification(
    _smtp_config: SmtpConfig,
    _payload: EmailPayload,
) -> Result<(), String> {
    Err("Not implemented".into())
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
