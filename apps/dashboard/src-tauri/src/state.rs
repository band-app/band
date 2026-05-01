use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
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

/// Ensure first-run defaults exist in settings.json.
/// If `appMode` is not set, writes `"full-editor"` as the default.
/// Called before reading settings on Tauri startup so the window opens
/// in the correct mode on first launch.
pub fn ensure_first_run_defaults() {
    let path = settings_file();

    // Load existing settings (or start with an empty JSON object)
    let mut value: serde_json::Value = if path.exists() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|data| serde_json::from_str(&data).ok())
            .unwrap_or_else(|| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // Ensure the top-level value is an object
    if !value.is_object() {
        value = serde_json::json!({});
    }

    let obj = value.as_object_mut().expect("value is an object");

    // Only set appMode if it's not already present
    if obj.contains_key("appMode") {
        return;
    }

    obj.insert(
        "appMode".to_string(),
        serde_json::Value::String("full-editor".to_string()),
    );

    // Write back
    if let Ok(data) = serde_json::to_string_pretty(&value) {
        let dir = band_home();
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(&path, format!("{data}\n"));
    }
}

// --- Window state persistence ---

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WindowState {
    #[serde(rename = "sidebarWidth", skip_serializing_if = "Option::is_none")]
    pub sidebar_width: Option<f64>,
}

fn window_state_file() -> PathBuf {
    band_home().join("window-state.json")
}

pub fn load_window_state() -> WindowState {
    let path = window_state_file();
    if !path.exists() {
        return WindowState::default();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

pub fn save_window_state(state: &WindowState) {
    if let Ok(data) = serde_json::to_string_pretty(state) {
        let _ = fs::write(window_state_file(), data);
    }
}

// --- Focus management state (shared flag for runtime mode toggling) ---

/// Tracks whether focus management (polling, window raising) is enabled.
/// Set to `false` in full-editor mode so the Tauri app does not interfere
/// with the user's window arrangement.
pub struct FocusManagementState(pub Arc<AtomicBool>);

impl FocusManagementState {
    pub fn new(enabled: bool) -> Self {
        Self(Arc::new(AtomicBool::new(enabled)))
    }
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
