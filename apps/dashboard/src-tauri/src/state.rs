use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NotificationSettings {
    #[serde(
        rename = "soundOnNeedsAttention",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub sound_on_needs_attention: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sound: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LabelDefinition {
    pub id: String,
    pub name: String,
    pub color: String,
}

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
    pub notifications: Option<NotificationSettings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<LabelDefinition>>,
    #[serde(rename = "tokenSecret", skip_serializing_if = "Option::is_none")]
    pub token_secret: Option<String>,
    #[serde(rename = "autoStartTunnel", skip_serializing_if = "Option::is_none")]
    pub auto_start_tunnel: Option<bool>,
    /// Extra fields not explicitly modeled (e.g. user-defined app definitions).
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

// --- File system helpers (only for reading settings) ---

pub fn band_home() -> PathBuf {
    dirs::home_dir()
        .expect("Could not find home directory")
        .join(".band")
}

fn settings_file() -> PathBuf {
    band_home().join("settings.json")
}

pub fn load_settings() -> Result<Settings, String> {
    let path = settings_file();
    if !path.exists() {
        return Ok(Settings::default());
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("Failed to read settings: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Failed to parse settings: {e}"))
}
