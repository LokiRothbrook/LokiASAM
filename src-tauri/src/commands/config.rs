use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
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

/// Returns the path to the server INI config directory.
///
/// ASA ships only a Windows dedicated server binary. On Linux the binary is
/// run through Proton/Wine, which maps the working directory to the real
/// filesystem via the Z:\ drive. The server binary therefore always writes
/// and reads config from the WindowsServer subfolder regardless of the host OS.
fn config_dir(install_path: &Path) -> PathBuf {
    install_path
        .join("ShooterGame")
        .join("Saved")
        .join("Config")
        .join("WindowsServer")
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

/// Parse the `GameUserSettings.ini` / `Game.ini` pair stored in an arbitrary
/// folder — used to preview an INI backup snapshot before restoring it.
#[tauri::command]
pub async fn read_ini_folder(folder_path: String) -> Result<ServerConfigJson, String> {
    let base = PathBuf::from(&folder_path);
    Ok(ServerConfigJson {
        game_user_settings: parse_ini_file(&base.join("GameUserSettings.ini"))?,
        game_ini: parse_ini_file(&base.join("Game.ini"))?,
        launch_args: Value::Object(Map::new()),
    })
}

/// A single key edit applied in place by `patch_server_ini`.
/// `value: None` removes the key from the section.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IniPatchOp {
    /// "gus" (GameUserSettings.ini) or "game" (Game.ini)
    pub file: String,
    pub section: String,
    pub key: String,
    pub value: Option<String>,
}

/// Apply `ops` to INI text line by line. Everything the ops don't touch —
/// comments, ordering, and repeated keys (Game.ini relies on those for
/// entries like OverrideNamedEngramEntries) — is left exactly as it was,
/// which a full parse → serialize round-trip can't guarantee.
fn patch_ini_text(content: &str, ops: &[&IniPatchOp]) -> String {
    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();

    let section_of = |line: &str| -> Option<String> {
        let t = line.trim();
        (t.starts_with('[') && t.ends_with(']')).then(|| t[1..t.len() - 1].to_string())
    };
    let key_of = |line: &str| -> Option<String> {
        let t = line.trim();
        if t.starts_with(';') || t.starts_with('#') { return None; }
        t.find('=').map(|i| t[..i].trim().to_string())
    };

    for op in ops {
        // Locate every line of the target key inside the target section, and
        // the last line belonging to that section (insertion point).
        let mut current: Option<String> = None;
        let mut hits: Vec<usize> = Vec::new();
        let mut section_end: Option<usize> = None;
        for (i, line) in lines.iter().enumerate() {
            if let Some(s) = section_of(line) {
                current = Some(s);
                continue;
            }
            let in_target = current
                .as_deref()
                .map(|s| s.eq_ignore_ascii_case(&op.section))
                .unwrap_or(false);
            if !in_target { continue; }
            if !line.trim().is_empty() { section_end = Some(i); }
            if key_of(line).map(|k| k.eq_ignore_ascii_case(&op.key)).unwrap_or(false) {
                hits.push(i);
            }
        }
        let section_header = lines.iter().position(|l| {
            section_of(l).map(|s| s.eq_ignore_ascii_case(&op.section)).unwrap_or(false)
        });

        match &op.value {
            Some(v) => {
                let new_line = format!("{}={}", op.key, v);
                if let Some(&first) = hits.first() {
                    lines[first] = new_line;
                    // Single-valued key: drop any later duplicates in the section.
                    for &i in hits.iter().skip(1).rev() { lines.remove(i); }
                } else if let Some(header) = section_header {
                    let at = section_end.unwrap_or(header) + 1;
                    lines.insert(at, new_line);
                } else {
                    if lines.last().map(|l| !l.trim().is_empty()).unwrap_or(false) {
                        lines.push(String::new());
                    }
                    lines.push(format!("[{}]", op.section));
                    lines.push(new_line);
                }
            }
            None => {
                for &i in hits.iter().rev() { lines.remove(i); }
            }
        }
    }

    let mut out = lines.join("\n");
    out.push('\n');
    out
}

/// Set or remove individual INI keys on disk without rewriting the rest of
/// the file. Used for targeted edits (identity changes, migrations that move
/// a key between sections/files) where a full rewrite could lose content.
#[tauri::command]
pub async fn patch_server_ini(install_path: String, ops: Vec<IniPatchOp>) -> Result<(), String> {
    let base = config_dir(Path::new(&install_path));
    tokio::fs::create_dir_all(&base)
        .await
        .map_err(|e| format!("Failed to create config directory: {e}"))?;

    for (file_id, file_name) in [("gus", "GameUserSettings.ini"), ("game", "Game.ini")] {
        let file_ops: Vec<&IniPatchOp> = ops.iter().filter(|o| o.file == file_id).collect();
        if file_ops.is_empty() { continue; }
        let path = base.join(file_name);
        let content = tokio::fs::read_to_string(&path).await.unwrap_or_default();
        let patched = patch_ini_text(&content, &file_ops);
        if patched != content {
            tokio::fs::write(&path, patched)
                .await
                .map_err(|e| format!("Failed to write {file_name}: {e}"))?;
        }
    }
    Ok(())
}

/// Player access-list files ASA reads, keyed by the id the frontend passes.
/// Only these paths can be read or written through the commands below.
fn access_list_path(install_path: &Path, list: &str) -> Result<PathBuf, String> {
    let rel: &[&str] = match list {
        // EOS IDs granted admin without entering the admin password.
        "admins" => &["ShooterGame", "Saved", "AllowedCheaterAccountIDs.txt"],
        // Whitelist used by -exclusivejoin / UseExclusiveList.
        "exclusive_join" => &["ShooterGame", "Binaries", "Win64", "PlayersExclusiveJoinList.txt"],
        // Players allowed to bypass the server's join checks (e.g. when full).
        "join_no_check" => &["ShooterGame", "Binaries", "Win64", "PlayersJoinNoCheckList.txt"],
        other => return Err(format!("Unknown access list: {other}")),
    };
    Ok(rel.iter().fold(install_path.to_path_buf(), |p, part| p.join(part)))
}

/// Read one of the player access-list files. A missing file reads as empty.
#[tauri::command]
pub async fn read_server_text_file(install_path: String, list: String) -> Result<String, String> {
    let path = access_list_path(Path::new(&install_path), &list)?;
    match tokio::fs::read_to_string(&path).await {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("Failed to read {}: {e}", path.display())),
    }
}

/// Overwrite one of the player access-list files, creating parent folders.
#[tauri::command]
pub async fn write_server_text_file(install_path: String, list: String, content: String) -> Result<(), String> {
    let path = access_list_path(Path::new(&install_path), &list)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    tokio::fs::write(&path, content)
        .await
        .map_err(|e| format!("Failed to write {}: {e}", path.display()))
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


#[cfg(test)]
mod tests {
    use super::*;

    fn op(file: &str, section: &str, key: &str, value: Option<&str>) -> IniPatchOp {
        IniPatchOp { file: file.into(), section: section.into(), key: key.into(), value: value.map(Into::into) }
    }

    #[test]
    fn replaces_existing_key_and_keeps_everything_else() {
        let src = "; comment\n[ServerSettings]\nXPMultiplier=1.0\nServerPassword=old\n\n[Other]\nA=1\n";
        let o = op("gus", "serversettings", "ServerPassword", Some("new"));
        let out = patch_ini_text(src, &[&o]);
        assert_eq!(out, "; comment\n[ServerSettings]\nXPMultiplier=1.0\nServerPassword=new\n\n[Other]\nA=1\n");
    }

    #[test]
    fn inserts_into_existing_section_and_creates_missing_section() {
        let src = "[ServerSettings]\nXPMultiplier=1.0\n\n[Other]\nA=1\n";
        let a = op("gus", "ServerSettings", "ServerPVE", Some("True"));
        let b = op("gus", "MessageOfTheDay", "Message", Some("hi"));
        let out = patch_ini_text(src, &[&a, &b]);
        assert_eq!(out, "[ServerSettings]\nXPMultiplier=1.0\nServerPVE=True\n\n[Other]\nA=1\n\n[MessageOfTheDay]\nMessage=hi\n");
    }

    #[test]
    fn removes_key_only_from_target_section() {
        let src = "[SessionSettings]\nSessionName=X\nServerPassword=p\n[ServerSettings]\nServerPassword=p\n";
        let o = op("gus", "SessionSettings", "ServerPassword", None);
        let out = patch_ini_text(src, &[&o]);
        assert_eq!(out, "[SessionSettings]\nSessionName=X\n[ServerSettings]\nServerPassword=p\n");
    }

    #[test]
    fn leaves_repeated_keys_in_other_sections_untouched() {
        let src = "[/script/shootergame.shootergamemode]\nOverrideNamedEngramEntries=(a)\nOverrideNamedEngramEntries=(b)\n";
        let o = op("game", "/script/shootergame.shootergamemode", "BabyMatureSpeedMultiplier", Some("5.0"));
        let out = patch_ini_text(src, &[&o]);
        assert_eq!(out, "[/script/shootergame.shootergamemode]\nOverrideNamedEngramEntries=(a)\nOverrideNamedEngramEntries=(b)\nBabyMatureSpeedMultiplier=5.0\n");
    }
}
