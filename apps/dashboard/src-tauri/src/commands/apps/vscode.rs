use super::{AppDriver, ScreenRect};
use crate::commands::ax_windows;

pub const BUNDLE_ID: &str = "com.microsoft.VSCode";
const APP_TYPE: &str = "vscode";

pub struct VsCodeDriver;

impl AppDriver for VsCodeDriver {
    fn bundle_id(&self) -> &str {
        BUNDLE_ID
    }

    fn display_name(&self) -> &'static str {
        "Visual Studio Code"
    }

    fn open_or_focus(
        &self,
        worktree_path: &str,
        folder_name: &str,
        _config: &serde_json::Value,
    ) -> Result<(), String> {
        // 1. Check WindowRegistry for a known window
        if let Some(entry) = ax_windows::get_window(APP_TYPE, folder_name) {
            if ax_windows::is_window_valid(APP_TYPE, folder_name, BUNDLE_ID) {
                ax_windows::focus_window(entry.pid, entry.cg_window_id);
                return Ok(());
            }
            ax_windows::unregister_window(APP_TYPE, folder_name);
        }

        // 2. Try to find an existing window by title
        if let Some(win) = ax_windows::find_window_by_title(BUNDLE_ID, folder_name) {
            ax_windows::register_window(APP_TYPE, folder_name, win.pid, win.cg_window_id);
            ax_windows::focus_window(win.pid, win.cg_window_id);
            return Ok(());
        }

        // 3. Snapshot existing windows, launch app, discover new window
        let existing = ax_windows::snapshot_window_ids(BUNDLE_ID);

        std::process::Command::new("open")
            .args(["-a", "Visual Studio Code", worktree_path])
            .output()
            .map_err(|e| format!("Failed to open VS Code: {e}"))?;

        if let Some(win) =
            ax_windows::await_new_window(BUNDLE_ID, Some(folder_name), &existing, 5000)
        {
            ax_windows::register_window(APP_TYPE, folder_name, win.pid, win.cg_window_id);
        }

        Ok(())
    }

    fn position_window(&self, folder_name: &str, rect: &ScreenRect) -> Result<(), String> {
        let entry = ax_windows::get_window(APP_TYPE, folder_name)
            .ok_or_else(|| "No VS Code window registered".to_string())?;
        if !ax_windows::position_window(
            entry.pid,
            entry.cg_window_id,
            rect.x,
            rect.y,
            rect.width,
            rect.height,
        ) {
            ax_windows::unregister_window(APP_TYPE, folder_name);
            return Err("Failed to position VS Code window (stale reference)".to_string());
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

    fn matches_window_title(&self, title: &str, folder_name: &str) -> bool {
        title.contains(folder_name)
    }
}
