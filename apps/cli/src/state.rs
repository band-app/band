use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Settings {
    #[serde(rename = "worktreesDir", skip_serializing_if = "Option::is_none")]
    pub worktrees_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub defaults: Option<serde_json::Value>,
    #[serde(rename = "codingAgent", skip_serializing_if = "Option::is_none")]
    pub coding_agent: Option<serde_json::Value>,
    #[serde(rename = "webServerPort", skip_serializing_if = "Option::is_none")]
    pub web_server_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notifications: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<serde_json::Value>,
    #[serde(rename = "tokenSecret", skip_serializing_if = "Option::is_none")]
    pub token_secret: Option<String>,
    #[serde(rename = "autoStartTunnel", skip_serializing_if = "Option::is_none")]
    pub auto_start_tunnel: Option<bool>,
    /// CLI-specific preferences. Today the only field is `defaultVia`,
    /// which is the user-level fallback for `band workspaces create
    /// --prompt` dispatch (issue #551). Stored as a free-form JSON value
    /// so future per-CLI keys can be added without churning this struct.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cli: Option<serde_json::Value>,
}

pub fn band_home() -> PathBuf {
    if let Ok(home) = std::env::var("BAND_HOME") {
        return PathBuf::from(home);
    }
    dirs::home_dir()
        .expect("Could not find home directory")
        .join(".band")
}

pub fn load_settings() -> Result<Settings, String> {
    let settings_path = band_home().join("settings.json");
    if !settings_path.exists() {
        return Ok(Settings::default());
    }

    let data = std::fs::read_to_string(&settings_path)
        .map_err(|e| format!("Failed to read settings: {e}"))?;

    serde_json::from_str(&data).map_err(|e| format!("Failed to parse settings: {e}"))
}
