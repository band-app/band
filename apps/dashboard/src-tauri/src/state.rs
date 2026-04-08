use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

// --- Data types for API responses ---

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
    #[serde(rename = "autoStartTunnel", skip_serializing_if = "Option::is_none")]
    pub auto_start_tunnel: Option<bool>,
    #[serde(rename = "appMode", skip_serializing_if = "Option::is_none")]
    pub app_mode: Option<String>,
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

// --- In-memory active workspace state ---

pub struct ActiveWorkspaceState(pub Arc<Mutex<Option<String>>>);

impl ActiveWorkspaceState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}

// --- Cached project state (refreshed from web server API) ---

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct CachedState {
    pub app_state: AppState,
}

#[derive(Clone)]
pub struct ProjectCache(Arc<Mutex<Option<CachedState>>>);

impl ProjectCache {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }

    /// Get a copy of the current cached state, if available.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn get(&self) -> Option<AppState> {
        self.0.lock().ok()?.as_ref().map(|c| c.app_state.clone())
    }

    /// Update the cached state. Used by macOS focus polling (ide.rs).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn set(&self, state: AppState) {
        if let Ok(mut guard) = self.0.lock() {
            *guard = Some(CachedState { app_state: state });
        }
    }
}
