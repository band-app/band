use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::path::PathBuf;

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
    #[serde(rename = "tunnelSubdomain", skip_serializing_if = "Option::is_none")]
    pub tunnel_subdomain: Option<String>,
    #[serde(rename = "autoStartTunnel", skip_serializing_if = "Option::is_none")]
    pub auto_start_tunnel: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectConfig {
    pub setup: Option<String>,
    pub teardown: Option<String>,
}

pub fn band_home() -> PathBuf {
    if let Ok(home) = std::env::var("BAND_HOME") {
        return PathBuf::from(home);
    }
    dirs::home_dir()
        .expect("Could not find home directory")
        .join(".band")
}

pub fn state_file() -> PathBuf {
    band_home().join("state.json")
}

pub fn settings_file() -> PathBuf {
    band_home().join("settings.json")
}

pub fn status_dir() -> PathBuf {
    band_home().join("status")
}

pub fn ensure_dirs() -> Result<(), String> {
    let home = band_home();
    fs::create_dir_all(&home).map_err(|e| format!("Failed to create ~/.band: {e}"))?;
    fs::create_dir_all(home.join("status"))
        .map_err(|e| format!("Failed to create ~/.band/status: {e}"))?;
    Ok(())
}

pub fn worktrees_dir() -> PathBuf {
    load_settings()
        .ok()
        .and_then(|s| s.worktrees_dir)
        .map_or_else(|| band_home().join("worktrees"), PathBuf::from)
}

/// Lock state.json for exclusive access, load, mutate via callback, and save.
/// The closure can return arbitrary data alongside the mutation.
pub fn with_locked_state<F, R>(mutate: F) -> Result<R, String>
where
    F: FnOnce(&mut AppState) -> Result<R, String>,
{
    ensure_dirs()?;
    let lock_path = band_home().join("state.json.lock");
    let lock_file =
        File::create(&lock_path).map_err(|e| format!("Failed to create lock file: {e}"))?;
    lock_file
        .lock_exclusive()
        .map_err(|e| format!("Failed to acquire lock: {e}"))?;

    let result = (|| {
        let mut state = load_state_inner()?;
        let ret = mutate(&mut state)?;
        save_state_inner(&state)?;
        Ok(ret)
    })();

    let _ = lock_file.unlock();
    result
}

/// Lock state.json for shared (read) access and load.
pub fn with_locked_state_read<F, R>(read_fn: F) -> Result<R, String>
where
    F: FnOnce(&AppState) -> Result<R, String>,
{
    ensure_dirs()?;
    let lock_path = band_home().join("state.json.lock");
    let lock_file =
        File::create(&lock_path).map_err(|e| format!("Failed to create lock file: {e}"))?;
    lock_file
        .lock_shared()
        .map_err(|e| format!("Failed to acquire lock: {e}"))?;

    let result = (|| {
        let state = load_state_inner()?;
        read_fn(&state)
    })();

    let _ = lock_file.unlock();
    result
}

fn load_state_inner() -> Result<AppState, String> {
    let path = state_file();
    if !path.exists() {
        return Ok(AppState::default());
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("Failed to read state: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Failed to parse state: {e}"))
}

fn save_state_inner(state: &AppState) -> Result<(), String> {
    let path = state_file();
    let data =
        serde_json::to_string_pretty(state).map_err(|e| format!("Failed to serialize: {e}"))?;
    fs::write(&path, data).map_err(|e| format!("Failed to write state: {e}"))
}

pub fn load_settings() -> Result<Settings, String> {
    let path = settings_file();
    if !path.exists() {
        return Ok(Settings::default());
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("Failed to read settings: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Failed to parse settings: {e}"))
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
