use serde::Serialize;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

fn claude_settings_path() -> PathBuf {
    dirs::home_dir()
        .expect("Could not find home directory")
        .join(".claude")
        .join("settings.json")
}

fn hooks_dir() -> PathBuf {
    dirs::home_dir()
        .expect("Could not find home directory")
        .join(".band")
        .join("hooks")
}

fn is_band_hook(command: &str) -> bool {
    command.contains(".band/hooks/")
}

#[derive(Debug, Clone, Serialize)]
pub struct HooksStatus {
    pub installed: bool,
    pub other_hooks_exist: bool,
}

#[tauri::command]
pub fn hooks_check() -> Result<HooksStatus, String> {
    let settings_path = claude_settings_path();
    let settings: serde_json::Value = if settings_path.exists() {
        let data = fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings: {e}"))?;
        serde_json::from_str(&data).map_err(|e| format!("Failed to parse settings: {e}"))?
    } else {
        serde_json::json!({})
    };

    let hooks = settings.get("hooks").and_then(|h| h.as_object());

    let mut installed = false;
    let mut other_hooks_exist = false;

    // Format: { "EventName": [{ "matcher": "regex", "hooks": [{ "type": "command", "command": "..." }] }] }
    if let Some(hooks_obj) = hooks {
        for (_event, matcher_list) in hooks_obj {
            if let Some(matchers) = matcher_list.as_array() {
                for matcher_entry in matchers {
                    if let Some(hook_arr) = matcher_entry.get("hooks").and_then(|h| h.as_array()) {
                        for hook in hook_arr {
                            let command =
                                hook.get("command").and_then(|c| c.as_str()).unwrap_or("");
                            if is_band_hook(command) {
                                installed = true;
                            } else {
                                other_hooks_exist = true;
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(HooksStatus {
        installed,
        other_hooks_exist,
    })
}

const NOTIFY_SCRIPT: &str = include_str!("../../scripts/notify.sh");

const BAND_HOOK_EVENTS: &[&str] = &[
    "UserPromptSubmit",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "PermissionRequest",
];

#[tauri::command]
pub fn hooks_install() -> Result<(), String> {
    // Create hooks dir and write notify.sh
    let hooks_dir = hooks_dir();
    fs::create_dir_all(&hooks_dir).map_err(|e| format!("Failed to create hooks dir: {e}"))?;

    let script_path = hooks_dir.join("notify.sh");
    fs::write(&script_path, NOTIFY_SCRIPT)
        .map_err(|e| format!("Failed to write notify.sh: {e}"))?;

    fs::set_permissions(&script_path, fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("Failed to chmod notify.sh: {e}"))?;

    // Read existing Claude settings
    let settings_path = claude_settings_path();
    let claude_dir = settings_path.parent().unwrap();
    fs::create_dir_all(claude_dir).map_err(|e| format!("Failed to create ~/.claude: {e}"))?;

    let mut settings: serde_json::Value = if settings_path.exists() {
        let data = fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings: {e}"))?;
        serde_json::from_str(&data).map_err(|e| format!("Failed to parse settings: {e}"))?
    } else {
        serde_json::json!({})
    };

    // Ensure hooks object exists
    if settings.get("hooks").is_none() {
        settings["hooks"] = serde_json::json!({});
    }

    let hooks = settings["hooks"].as_object_mut().unwrap();
    let script_path_str = script_path.to_string_lossy().to_string();

    // Format: { "EventName": [{ "hooks": [{ "type": "command", "command": "..." }] }] }
    // matcher is a regex string; omit it to match all occurrences
    for &event in BAND_HOOK_EVENTS {
        let matcher_list = hooks.entry(event).or_insert_with(|| serde_json::json!([]));

        if let Some(arr) = matcher_list.as_array_mut() {
            // Remove matcher entries that contain Band hooks
            arr.retain(|entry| {
                if let Some(hook_arr) = entry.get("hooks").and_then(|h| h.as_array()) {
                    // Keep if it has any non-Band hooks
                    hook_arr.iter().any(|h| {
                        let cmd = h.get("command").and_then(|c| c.as_str()).unwrap_or("");
                        !is_band_hook(cmd)
                    })
                } else {
                    true
                }
            });

            // Add fresh Band hook entry (no matcher = match all)
            arr.push(serde_json::json!({
                "hooks": [{
                    "type": "command",
                    "command": script_path_str,
                }]
            }));
        }
    }

    let output = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {e}"))?;

    fs::write(&settings_path, output).map_err(|e| format!("Failed to write settings: {e}"))?;

    Ok(())
}
