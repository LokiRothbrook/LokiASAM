use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Serialized representation of a server's full INI configuration.
/// Each top-level key is an INI section name, e.g. "SessionSettings" or "ServerSettings".
/// Each section value is a map of key → value strings.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfigJson {
    pub game_user_settings: Value,
    pub game_ini: Value,
    pub launch_args: Value,
}

/// Returns the platform-specific path to the server INI config directory.
///
/// ASA uses different subdirectories on each platform:
/// - Windows: ShooterGame/Saved/Config/WindowsServer/
/// - Linux:   ShooterGame/Saved/Config/LinuxServer/
fn config_dir(install_path: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    let platform = "WindowsServer";
    #[cfg(not(target_os = "windows"))]
    let platform = "LinuxServer";

    install_path
        .join("ShooterGame")
        .join("Saved")
        .join("Config")
        .join(platform)
}

/// Parse an INI file at `path` into a JSON object of section → { key → value }.
/// Uses a hand-rolled parser to preserve exact case of section names and keys,
/// which is required for ASA INI files.
fn parse_ini_file(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(Value::Object(Map::new()));
    }

    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;

    let mut sections: Map<String, Value> = Map::new();
    let mut current_section = String::new();

    for raw_line in content.lines() {
        let line = raw_line.trim();

        // Skip comments and blank lines
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }

        if line.starts_with('[') && line.ends_with(']') {
            current_section = line[1..line.len() - 1].to_string();
            sections
                .entry(current_section.clone())
                .or_insert_with(|| Value::Object(Map::new()));
        } else if let Some(eq_pos) = line.find('=') {
            let key = line[..eq_pos].trim().to_string();
            let value = line[eq_pos + 1..].to_string();

            if !current_section.is_empty() && !key.is_empty() {
                if let Some(Value::Object(section_map)) = sections.get_mut(&current_section) {
                    section_map.insert(key, Value::String(value));
                }
            }
        }
    }

    Ok(Value::Object(sections))
}

/// Serialize a JSON section map back to INI file content.
/// Preserves the section → key=value structure.
fn serialize_ini(data: &Value) -> String {
    let mut output = String::new();

    if let Some(sections) = data.as_object() {
        for (section, keys) in sections {
            output.push('[');
            output.push_str(section);
            output.push_str("]\n");

            if let Some(kv_map) = keys.as_object() {
                for (key, value) in kv_map {
                    let v = match value {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    output.push_str(key);
                    output.push('=');
                    output.push_str(&v);
                    output.push('\n');
                }
            }
            output.push('\n');
        }
    }

    output
}

/// Read `GameUserSettings.ini` and `Game.ini` from the server's install path.
/// Returns a `ServerConfigJson` with the parsed section maps.
#[tauri::command]
pub async fn read_server_config(install_path: String) -> Result<ServerConfigJson, String> {
    let base = config_dir(Path::new(&install_path));

    let game_user_settings = parse_ini_file(&base.join("GameUserSettings.ini"))?;
    let game_ini = parse_ini_file(&base.join("Game.ini"))?;

    Ok(ServerConfigJson {
        game_user_settings,
        game_ini,
        launch_args: Value::Object(Map::new()),
    })
}

/// Serialize `config` back to `GameUserSettings.ini` and `Game.ini` and write them
/// to the server's config directory. Creates the directory if it does not exist.
#[tauri::command]
pub async fn write_server_config(
    install_path: String,
    config: ServerConfigJson,
) -> Result<(), String> {
    let base = config_dir(Path::new(&install_path));

    tokio::fs::create_dir_all(&base)
        .await
        .map_err(|e| format!("Failed to create config directory: {e}"))?;

    let gus_content = serialize_ini(&config.game_user_settings);
    tokio::fs::write(base.join("GameUserSettings.ini"), gus_content)
        .await
        .map_err(|e| format!("Failed to write GameUserSettings.ini: {e}"))?;

    let game_ini_content = serialize_ini(&config.game_ini);
    tokio::fs::write(base.join("Game.ini"), game_ini_content)
        .await
        .map_err(|e| format!("Failed to write Game.ini: {e}"))?;

    Ok(())
}

/// Parse existing `GameUserSettings.ini` and `Game.ini` files provided by the user
/// (e.g., imported from an existing ASA install) and return the structured JSON.
/// Used in the "Import from existing config files" preset option in the creation wizard.
#[tauri::command]
pub async fn import_ini_files(
    gus_path: String,
    game_ini_path: String,
) -> Result<ServerConfigJson, String> {
    let game_user_settings = parse_ini_file(Path::new(&gus_path))?;
    let game_ini = parse_ini_file(Path::new(&game_ini_path))?;

    Ok(ServerConfigJson {
        game_user_settings,
        game_ini,
        launch_args: Value::Object(Map::new()),
    })
}

/// Build a default `ServerConfigJson` from a flat config map.
/// Used during server creation to pre-populate INI values from a preset
/// and from the wizard's form fields.
///
/// `gus_fields` maps `"Section.Key"` → value string.
/// `game_ini_fields` maps `"Section.Key"` → value string.
pub fn build_config_from_flat(
    gus_fields: &HashMap<String, String>,
    game_ini_fields: &HashMap<String, String>,
) -> ServerConfigJson {
    fn build_section_map(fields: &HashMap<String, String>) -> Value {
        let mut sections: Map<String, Value> = Map::new();
        for (dotted_key, value) in fields {
            if let Some(dot) = dotted_key.find('.') {
                let section = dotted_key[..dot].to_string();
                let key = dotted_key[dot + 1..].to_string();
                let section_entry = sections
                    .entry(section)
                    .or_insert_with(|| Value::Object(Map::new()));
                if let Value::Object(m) = section_entry {
                    m.insert(key, Value::String(value.clone()));
                }
            }
        }
        Value::Object(sections)
    }

    ServerConfigJson {
        game_user_settings: build_section_map(gus_fields),
        game_ini: build_section_map(game_ini_fields),
        launch_args: Value::Object(Map::new()),
    }
}
