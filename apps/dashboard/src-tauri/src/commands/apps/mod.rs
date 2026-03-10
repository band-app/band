pub mod chrome;
pub mod iterm;
pub mod vscode;
pub mod zed;

use serde::{Deserialize, Serialize};

const DASHBOARD_WIDTH: i32 = 400;

#[derive(Debug, Clone)]
pub struct ScreenRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[allow(dead_code)]
pub trait AppDriver: Send + Sync {
    fn bundle_id(&self) -> &str;
    fn display_name(&self) -> &'static str;

    /// Open app with workspace content, or focus existing window.
    fn open_or_focus(
        &self,
        worktree_path: &str,
        folder_name: &str,
        config: &serde_json::Value,
    ) -> Result<(), String>;

    /// Position the app's window matching this workspace to the given rect.
    fn position_window(&self, folder_name: &str, rect: &ScreenRect) -> Result<(), String>;

    /// Raise window without stealing focus (`AXRaise`).
    fn raise_window(&self, folder_name: &str);

    /// Check if a window title belongs to this workspace.
    fn matches_window_title(&self, title: &str, folder_name: &str) -> bool;
}

// --- Config types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AppConfig {
    #[serde(rename = "vscode")]
    VsCode(VsCodeAppConfig),
    #[serde(rename = "zed")]
    Zed(ZedAppConfig),
    #[serde(rename = "iterm")]
    ITerm(ITermAppConfig),
    #[serde(rename = "chrome")]
    Chrome(ChromeAppConfig),
}

impl AppConfig {
    pub fn app_type(&self) -> &str {
        match self {
            AppConfig::VsCode(_) => "vscode",
            AppConfig::Zed(_) => "zed",
            AppConfig::ITerm(_) => "iterm",
            AppConfig::Chrome(_) => "chrome",
        }
    }

    pub fn size(&self) -> f64 {
        match self {
            AppConfig::VsCode(c) => c.size.unwrap_or(1.0),
            AppConfig::Zed(c) => c.size.unwrap_or(1.0),
            AppConfig::ITerm(c) => c.size.unwrap_or(1.0),
            AppConfig::Chrome(c) => c.size.unwrap_or(1.0),
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }

    #[allow(dead_code)]
    pub fn is_editor(&self) -> bool {
        matches!(self, AppConfig::VsCode(_) | AppConfig::Zed(_))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VsCodeAppConfig {
    pub size: Option<f64>,
    pub terminals: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZedAppConfig {
    pub size: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ITermAppConfig {
    pub size: Option<f64>,
    pub commands: Option<Vec<ITermCommand>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ITermCommand {
    pub name: Option<String>,
    pub command: String,
    pub split: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChromeAppConfig {
    pub size: Option<f64>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct BandAppsConfig {
    pub apps: Option<Vec<AppConfig>>,
}

// --- Layout engine ---

pub fn compute_layout(app_sizes: &[f64], screen_width: i32, screen_height: i32) -> Vec<ScreenRect> {
    if app_sizes.is_empty() {
        return Vec::new();
    }

    let available = screen_width - DASHBOARD_WIDTH;
    let total: f64 = app_sizes.iter().sum();

    if total <= 0.0 {
        return app_sizes
            .iter()
            .map(|_| ScreenRect {
                x: DASHBOARD_WIDTH,
                y: 0,
                width: available,
                height: screen_height,
            })
            .collect();
    }

    let mut rects = Vec::with_capacity(app_sizes.len());
    let mut x = DASHBOARD_WIDTH;

    for (i, &size) in app_sizes.iter().enumerate() {
        let width = if i == app_sizes.len() - 1 {
            screen_width - x
        } else {
            ((size / total) * available as f64).round() as i32
        };

        rects.push(ScreenRect {
            x,
            y: 0,
            width,
            height: screen_height,
        });
        x += width;
    }

    rects
}

// --- Config loading ---

pub fn load_apps_config(worktree_path: &str) -> Vec<AppConfig> {
    // Try project .band/config.json first
    let project_config_path = std::path::PathBuf::from(worktree_path)
        .join(".band")
        .join("config.json");

    if let Ok(data) = std::fs::read_to_string(&project_config_path) {
        if let Ok(config) = serde_json::from_str::<BandAppsConfig>(&data) {
            if let Some(apps) = config.apps {
                if !apps.is_empty() {
                    return apps;
                }
            }
        }
    }

    // Fall back to settings.json defaults
    let settings = crate::state::load_settings().unwrap_or_default();
    if let Some(defaults) = settings.defaults {
        if let Ok(config) = serde_json::from_value::<BandAppsConfig>(defaults) {
            if let Some(apps) = config.apps {
                return apps;
            }
        }
    }

    Vec::new()
}

// --- Driver registry ---

pub fn get_driver(app_type: &str) -> Option<Box<dyn AppDriver>> {
    match app_type {
        "vscode" => Some(Box::new(vscode::VsCodeDriver)),
        "zed" => Some(Box::new(zed::ZedDriver)),
        "iterm" => Some(Box::new(iterm::ITermDriver)),
        "chrome" => Some(Box::new(chrome::ChromeDriver)),
        _ => None,
    }
}

/// Get all registered drivers with their bundle IDs.
pub fn all_known_bundle_ids() -> Vec<(&'static str, &'static str)> {
    vec![
        ("vscode", vscode::BUNDLE_ID),
        ("zed", zed::BUNDLE_ID),
        ("iterm", iterm::BUNDLE_ID),
        ("chrome", chrome::BUNDLE_ID),
    ]
}
