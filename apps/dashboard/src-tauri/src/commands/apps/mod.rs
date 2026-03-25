use std::collections::HashMap;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use crate::commands::ax_windows;

const DASHBOARD_WIDTH: i32 = 400;

#[derive(Debug, Clone)]
pub struct ScreenRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

pub trait AppHandler: Send + Sync {
    fn bundle_id(&self) -> &str;
    fn display_name(&self) -> &str;
    fn app_type(&self) -> &str;

    /// Launch the app / create a new window. Called only when no existing window was found.
    fn launch(
        &self,
        worktree_path: &str,
        folder_name: &str,
        config: &serde_json::Value,
    ) -> Result<(), String>;

    /// Post-launch setup (e.g. iTerm splits/commands). Called only for newly launched windows,
    /// after the window has been positioned.
    fn setup(
        &self,
        _worktree_path: &str,
        _folder_name: &str,
        _config: &serde_json::Value,
    ) -> Result<(), String> {
        Ok(())
    }

    /// Title substring to search for in existing windows.
    /// Return `None` to skip title-based discovery (e.g. Chrome --app).
    fn window_title_hint(&self, folder_name: &str) -> Option<String> {
        Some(folder_name.to_string())
    }

    /// Title hint passed to the `AXObserver` watcher for new window matching.
    /// Defaults to same as `window_title_hint`.
    fn watcher_title_hint(&self, folder_name: &str) -> Option<String> {
        self.window_title_hint(folder_name)
    }

    /// Check if a window title belongs to this workspace.
    fn matches_window_title(&self, title: &str, folder_name: &str) -> bool {
        self.window_title_hint(folder_name)
            .is_some_and(|hint| title.contains(&hint))
    }

    /// How long (ms) to wait for the window to appear after launch. Default: 5000.
    fn wait_timeout(&self) -> u64 {
        5000
    }
}

// --- Data-driven app definition ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDef {
    #[serde(rename = "type")]
    pub app_type: String,
    pub bundle_id: String,
    pub display_name: String,
    pub launch_command: String,
    /// Command to create a new window when the app is already running.
    /// If set and the app has existing windows, this is used instead of `launch_command`.
    #[serde(default)]
    pub new_window_command: Option<String>,
    #[serde(default)]
    pub setup_command: Option<String>,
    /// Window title pattern. Use `{{folder}}` for folder name substitution.
    /// Set to null to disable title-based window discovery.
    #[serde(default)]
    pub title_hint: Option<String>,
    /// `AXObserver` watcher hint. Defaults to same as `title_hint`.
    /// Set to explicit null to disable watching.
    #[serde(default)]
    pub watcher_hint: Option<String>,
    /// How long (ms) to wait for the window to appear after launch.
    /// Defaults to 5000. Slow-starting apps (e.g. JetBrains IDEs) should use a higher value.
    #[serde(default)]
    pub wait_timeout: Option<u64>,
}

impl AppHandler for AppDef {
    fn bundle_id(&self) -> &str {
        &self.bundle_id
    }

    fn display_name(&self) -> &str {
        &self.display_name
    }

    fn app_type(&self) -> &str {
        &self.app_type
    }

    fn launch(
        &self,
        worktree_path: &str,
        folder_name: &str,
        config: &serde_json::Value,
    ) -> Result<(), String> {
        // If the app is already running and has a new_window_command, use that
        // instead of launch_command (which may just focus the existing window).
        if let Some(ref new_window_cmd) = self.new_window_command {
            let has_windows = !ax_windows::list_windows_for_bundle(&self.bundle_id).is_empty();
            if has_windows {
                let cmd = new_window_cmd
                    .replace("{{path}}", worktree_path)
                    .replace("{{folder}}", folder_name);
                return run_shell(&cmd, config);
            }
        }

        let cmd = self
            .launch_command
            .replace("{{path}}", worktree_path)
            .replace("{{folder}}", folder_name);

        run_shell(&cmd, config)?;
        Ok(())
    }

    fn setup(
        &self,
        worktree_path: &str,
        folder_name: &str,
        config: &serde_json::Value,
    ) -> Result<(), String> {
        let Some(ref setup_cmd) = self.setup_command else {
            return Ok(());
        };

        let cmd = setup_cmd
            .replace("{{path}}", worktree_path)
            .replace("{{folder}}", folder_name);

        run_shell(&cmd, config)?;
        Ok(())
    }

    fn window_title_hint(&self, folder_name: &str) -> Option<String> {
        self.title_hint
            .as_ref()
            .map(|hint| hint.replace("{{folder}}", folder_name))
    }

    fn watcher_title_hint(&self, folder_name: &str) -> Option<String> {
        if self.watcher_hint.is_some() {
            self.watcher_hint
                .as_ref()
                .map(|hint| hint.replace("{{folder}}", folder_name))
        } else {
            self.window_title_hint(folder_name)
        }
    }

    fn wait_timeout(&self) -> u64 {
        self.wait_timeout.unwrap_or(5000)
    }
}

// --- Built-in app definitions (loaded from app-presets.json at compile time) ---

const APP_PRESETS_JSON: &str = include_str!("../../../app-presets.json");
include!(concat!(env!("OUT_DIR"), "/bundled_scripts.rs"));

fn builtin_app_defs() -> Vec<AppDef> {
    serde_json::from_str(APP_PRESETS_JSON).expect("app-presets.json must be valid")
}

// --- App registry ---

pub struct AppRegistry {
    defs: HashMap<String, AppDef>,
}

impl AppRegistry {
    fn load() -> Self {
        ensure_bundled_scripts();
        let mut defs = HashMap::new();

        // Load builtins
        for def in builtin_app_defs() {
            defs.insert(def.app_type.clone(), def);
        }

        // Load user overrides from settings.json
        if let Ok(settings) = crate::state::load_settings() {
            if let Some(apps_val) = settings.extra.get("apps") {
                if let Some(definitions) = apps_val.get("definitions").and_then(|d| d.as_array()) {
                    for def_val in definitions {
                        if let Ok(def) = serde_json::from_value::<AppDef>(def_val.clone()) {
                            defs.insert(def.app_type.clone(), def);
                        }
                    }
                }
            }
        }

        Self { defs }
    }

    pub fn get(&self, app_type: &str) -> Option<&AppDef> {
        self.defs.get(app_type)
    }

    #[allow(dead_code)]
    pub fn all_bundle_ids(&self) -> Vec<(&str, &str)> {
        self.defs
            .values()
            .map(|d| (d.app_type.as_str(), d.bundle_id.as_str()))
            .collect()
    }
}

static REGISTRY: LazyLock<AppRegistry> = LazyLock::new(AppRegistry::load);

pub fn registry() -> &'static AppRegistry {
    &REGISTRY
}

pub fn get_handler(app_type: &str) -> Option<&'static AppDef> {
    registry().get(app_type)
}

pub fn all_known_bundle_ids() -> Vec<(&'static str, &'static str)> {
    registry()
        .defs
        .values()
        .map(|d| {
            // SAFETY: registry is 'static (LazyLock), so the str references are 'static
            let app_type: &'static str =
                unsafe { &*std::ptr::from_ref::<str>(d.app_type.as_str()) };
            let bundle_id: &'static str =
                unsafe { &*std::ptr::from_ref::<str>(d.bundle_id.as_str()) };
            (app_type, bundle_id)
        })
        .collect()
}

// --- Config types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(rename = "type")]
    pub app_type: String,
    #[serde(default)]
    pub size: Option<f64>,
    /// Split direction: "vertical" (side-by-side columns, default) or "horizontal" (stacked rows)
    #[serde(default)]
    pub split: Option<String>,
    /// Terminal configs (for VS Code, Cursor, and similar editors)
    #[serde(default)]
    pub terminals: Option<Vec<serde_json::Value>>,
    /// Command configs (for iTerm and similar terminals)
    #[serde(default)]
    pub commands: Option<Vec<serde_json::Value>>,
    /// URL (for Chrome and similar browsers)
    #[serde(default)]
    pub url: Option<String>,
}

impl AppConfig {
    pub fn app_type(&self) -> &str {
        &self.app_type
    }

    pub fn size(&self) -> f64 {
        self.size.unwrap_or(1.0)
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct BandAppsConfig {
    pub apps: Option<Vec<AppConfig>>,
}

// --- Layout engine ---

pub fn compute_layout(
    apps: &[AppConfig],
    screen_width: i32,
    screen_height: i32,
) -> Vec<ScreenRect> {
    if apps.is_empty() {
        return Vec::new();
    }

    let available_width = screen_width - DASHBOARD_WIDTH;

    // Group apps into columns.
    // `split: "horizontal"` → join the previous column (stack vertically).
    // Anything else (no split, or `split: "vertical"`) → start a new column.
    // Each column tracks its app indices and uses the first app's size as width weight.
    let mut columns: Vec<(f64, Vec<usize>)> = Vec::new();

    for (i, app) in apps.iter().enumerate() {
        if i == 0 || app.split.as_deref() != Some("horizontal") {
            columns.push((app.size(), vec![i]));
        } else {
            columns
                .last_mut()
                .expect("at least one column exists")
                .1
                .push(i);
        }
    }

    // Compute column widths proportionally
    let total_w: f64 = columns.iter().map(|(w, _)| w).sum();
    let total_w = if total_w <= 0.0 { 1.0 } else { total_w };

    let mut rects = vec![
        ScreenRect {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        };
        apps.len()
    ];
    let mut x = DASHBOARD_WIDTH;

    for (col_idx, (col_weight, col_apps)) in columns.iter().enumerate() {
        let col_width = if col_idx == columns.len() - 1 {
            screen_width - x
        } else {
            ((col_weight / total_w) * available_width as f64).round() as i32
        };

        // Within this column, stack apps proportionally by height
        let total_h: f64 = col_apps.iter().map(|&i| apps[i].size()).sum();
        let total_h = if total_h <= 0.0 { 1.0 } else { total_h };

        let mut y = 0;
        for (row_idx, &app_idx) in col_apps.iter().enumerate() {
            let row_height = if row_idx == col_apps.len() - 1 {
                screen_height - y
            } else {
                ((apps[app_idx].size() / total_h) * screen_height as f64).round() as i32
            };

            rects[app_idx] = ScreenRect {
                x,
                y,
                width: col_width,
                height: row_height,
            };
            y += row_height;
        }

        x += col_width;
    }

    rects
}

// --- Config loading ---

pub fn load_apps_config(worktree_path: &str, project_path: &str) -> Vec<AppConfig> {
    // Try .band/config.json — worktree first, then project root (fallback for
    // .gitignored configs that don't appear in new worktrees).
    for base in [worktree_path, project_path] {
        let config_path = std::path::PathBuf::from(base)
            .join(".band")
            .join("config.json");

        if let Ok(data) = std::fs::read_to_string(&config_path) {
            if let Ok(config) = serde_json::from_str::<BandAppsConfig>(&data) {
                if let Some(apps) = config.apps {
                    if !apps.is_empty() {
                        return apps;
                    }
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

// --- Shell / AppleScript helpers ---

fn run_shell(cmd: &str, config: &serde_json::Value) -> Result<(), String> {
    let config_json = serde_json::to_string(config).unwrap_or_default();

    let output = std::process::Command::new("sh")
        .args(["-c", cmd])
        .env("BAND_CONFIG", &config_json)
        .output()
        .map_err(|e| format!("Failed to run command: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.is_empty() {
            return Err(format!("Command failed: {stderr}"));
        }
    }

    Ok(())
}

fn ensure_bundled_scripts() {
    let Ok(home) = std::env::var("HOME") else {
        return;
    };
    let scripts_dir = std::path::PathBuf::from(&home)
        .join(".band")
        .join("scripts");
    let _ = std::fs::create_dir_all(&scripts_dir);
    for (name, content) in BUNDLED_SCRIPTS {
        let path = scripts_dir.join(name);
        let _ = std::fs::write(&path, content);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
        }
    }
}
