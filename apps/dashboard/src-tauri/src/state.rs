use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectState {
    pub name: String,
    pub path: String,
    #[serde(rename = "defaultBranch")]
    pub default_branch: String,
    pub worktrees: Vec<WorktreeState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeState {
    pub branch: String,
    pub path: String,
    pub head: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppState {
    pub projects: Vec<ProjectState>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            projects: Vec::new(),
        }
    }
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
    fs::create_dir_all(&home).map_err(|e| format!("Failed to create ~/.band: {}", e))?;
    fs::create_dir_all(home.join("status"))
        .map_err(|e| format!("Failed to create ~/.band/status: {}", e))?;
    Ok(())
}

pub fn load_state() -> Result<AppState, String> {
    ensure_dirs()?;
    let path = state_file();
    if !path.exists() {
        return Ok(AppState::default());
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("Failed to read state: {}", e))?;
    serde_json::from_str(&data).map_err(|e| format!("Failed to parse state: {}", e))
}

pub fn save_state(state: &AppState) -> Result<(), String> {
    ensure_dirs()?;
    let path = state_file();
    let data =
        serde_json::to_string_pretty(state).map_err(|e| format!("Failed to serialize: {}", e))?;
    fs::write(&path, data).map_err(|e| format!("Failed to write state: {}", e))
}
