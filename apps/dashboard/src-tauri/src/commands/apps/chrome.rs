use super::{AppDriver, ScreenRect};
use crate::commands::ax_windows;

pub const BUNDLE_ID: &str = "com.google.Chrome";
const APP_TYPE: &str = "chrome";

pub struct ChromeDriver;

impl AppDriver for ChromeDriver {
    fn bundle_id(&self) -> &str {
        BUNDLE_ID
    }

    fn display_name(&self) -> &'static str {
        "Google Chrome"
    }

    fn open_or_focus(
        &self,
        _worktree_path: &str,
        folder_name: &str,
        config: &serde_json::Value,
    ) -> Result<(), String> {
        // 1. Check WindowRegistry for a known window
        if let Some(entry) = ax_windows::get_window(APP_TYPE, folder_name) {
            if ax_windows::is_window_valid(APP_TYPE, folder_name, BUNDLE_ID) {
                ax_windows::focus_window(entry.pid, entry.cg_window_id);
                return Ok(());
            }
            ax_windows::unregister_window(APP_TYPE, folder_name);
        }

        // 2. Snapshot existing windows, launch Chrome --app, discover new window via diff
        let existing = ax_windows::snapshot_window_ids(BUNDLE_ID);

        let url = config
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("about:blank");

        std::process::Command::new("open")
            .args(["-na", "Google Chrome", "--args", &format!("--app={url}")])
            .output()
            .map_err(|e| format!("Failed to open Chrome: {e}"))?;

        // Chrome --app page title is unknown, so use snapshot-diff only (no title match)
        if let Some(win) = ax_windows::await_new_window(BUNDLE_ID, None, &existing, 5000) {
            ax_windows::register_window(APP_TYPE, folder_name, win.pid, win.cg_window_id);
        }

        Ok(())
    }

    fn position_window(&self, folder_name: &str, rect: &ScreenRect) -> Result<(), String> {
        let entry = ax_windows::get_window(APP_TYPE, folder_name)
            .ok_or_else(|| "No Chrome window registered".to_string())?;
        if !ax_windows::position_window(
            entry.pid,
            entry.cg_window_id,
            rect.x,
            rect.y,
            rect.width,
            rect.height,
        ) {
            ax_windows::unregister_window(APP_TYPE, folder_name);
            return Err("Failed to position Chrome window (stale reference)".to_string());
        }
        Ok(())
    }

    fn raise_window(&self, folder_name: &str) {
        if let Some(entry) = ax_windows::get_window(APP_TYPE, folder_name) {
            if !ax_windows::raise_window(entry.pid, entry.cg_window_id) {
                ax_windows::unregister_window(APP_TYPE, folder_name);
            }
        }
    }

    fn matches_window_title(&self, _title: &str, _folder_name: &str) -> bool {
        // Chrome --app mode uses the page title, which won't contain the folder name.
        false
    }
}
