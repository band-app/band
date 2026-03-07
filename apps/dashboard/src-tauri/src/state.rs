use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectState {
    pub name: String,
    pub path: String,
    #[serde(rename = "defaultBranch")]
    pub default_branch: String,
    pub worktrees: Vec<WorktreeState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorktreeState {
    pub branch: String,
    pub path: String,
    pub head: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppState {
    pub projects: Vec<ProjectState>,
}

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
    #[serde(rename = "tunnelSubdomain", skip_serializing_if = "Option::is_none")]
    pub tunnel_subdomain: Option<String>,
    #[serde(rename = "autoStartTunnel", skip_serializing_if = "Option::is_none")]
    pub auto_start_tunnel: Option<bool>,
}

pub fn band_home() -> PathBuf {
    dirs::home_dir()
        .expect("Could not find home directory")
        .join(".band")
}

pub fn status_dir() -> PathBuf {
    band_home().join("status")
}

pub fn state_file() -> PathBuf {
    band_home().join("state.json")
}

pub fn ensure_dirs() -> Result<(), String> {
    let home = band_home();
    fs::create_dir_all(&home).map_err(|e| format!("Failed to create ~/.band: {e}"))?;
    fs::create_dir_all(home.join("status"))
        .map_err(|e| format!("Failed to create ~/.band/status: {e}"))?;
    Ok(())
}

pub fn load_state() -> Result<AppState, String> {
    ensure_dirs()?;
    let path = state_file();
    if !path.exists() {
        return Ok(AppState::default());
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("Failed to read state: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Failed to parse state: {e}"))
}

pub fn save_state(state: &AppState) -> Result<(), String> {
    ensure_dirs()?;
    let path = state_file();
    let data =
        serde_json::to_string_pretty(state).map_err(|e| format!("Failed to serialize: {e}"))?;
    fs::write(&path, data).map_err(|e| format!("Failed to write state: {e}"))
}

pub fn settings_file() -> PathBuf {
    band_home().join("settings.json")
}

pub fn load_settings() -> Result<Settings, String> {
    ensure_dirs()?;
    let path = settings_file();
    if !path.exists() {
        return Ok(Settings::default());
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("Failed to read settings: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Failed to parse settings: {e}"))
}

pub fn save_settings(settings: &Settings) -> Result<(), String> {
    ensure_dirs()?;
    let path = settings_file();
    let data = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize settings: {e}"))?;
    fs::write(&path, data).map_err(|e| format!("Failed to write settings: {e}"))
}

pub fn worktrees_dir() -> PathBuf {
    load_settings()
        .ok()
        .and_then(|s| s.worktrees_dir)
        .map_or_else(|| band_home().join("worktrees"), PathBuf::from)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectConfig {
    pub setup: Option<String>,
    pub teardown: Option<String>,
}

pub fn load_project_config(project_path: &str) -> ProjectConfig {
    let config_path = PathBuf::from(project_path)
        .join(".band")
        .join("config.json");
    if !config_path.exists() {
        return ProjectConfig::default();
    }
    fs::read_to_string(&config_path)
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

pub fn run_script_in_terminal(command: &str, cwd: &str) -> Result<(), String> {
    let safe_cwd = cwd.replace('\'', "'\\''");
    let escaped_cmd = command.replace('\'', "'\\''");

    let apple_script = format!(
        "tell application \"Terminal\"\n\
             activate\n\
             do script \"cd '{safe_cwd}' && {escaped_cmd}\"\n\
         end tell"
    );

    Command::new("osascript")
        .args(["-e", &apple_script])
        .output()
        .map_err(|e| format!("Failed to open terminal: {e}"))?;

    Ok(())
}

pub fn run_script(command: &str, cwd: &str) -> Result<(), String> {
    let output = Command::new("sh")
        .args(["-c", command])
        .current_dir(cwd)
        .env("PATH", crate::commands::webserver::shell_path())
        .output()
        .map_err(|e| format!("Failed to run script: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Script failed: {stderr}"));
    }

    Ok(())
}
