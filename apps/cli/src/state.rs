use rusqlite::Connection;
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
    let db_path = band_home().join("band.db");
    if !db_path.exists() {
        return Ok(Settings::default());
    }

    let conn = Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Failed to open database: {e}"))?;

    // The settings table may not exist yet if migrations haven't run
    let data: Option<String> = conn
        .query_row("SELECT data FROM settings WHERE id = 1", [], |row| {
            row.get(0)
        })
        .ok();

    match data {
        Some(json) => {
            serde_json::from_str(&json).map_err(|e| format!("Failed to parse settings: {e}"))
        }
        None => Ok(Settings::default()),
    }
}
