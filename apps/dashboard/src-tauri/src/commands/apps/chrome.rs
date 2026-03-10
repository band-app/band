use super::{position_window_by_bundle_id, raise_window_by_bundle_id, AppDriver, ScreenRect};

pub const BUNDLE_ID: &str = "com.google.Chrome";

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
        _folder_name: &str,
        config: &serde_json::Value,
    ) -> Result<(), String> {
        let url = config
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("about:blank");

        // Open in app mode for clean, matchable windows
        std::process::Command::new("open")
            .args(["-na", "Google Chrome", "--args", &format!("--app={url}")])
            .output()
            .map_err(|e| format!("Failed to open Chrome: {e}"))?;

        Ok(())
    }

    fn position_window(&self, folder_name: &str, rect: &ScreenRect) -> Result<(), String> {
        // Chrome --app mode uses the page title as window title
        // We position by matching the most recent Chrome window
        // since --app mode just opened it
        position_window_by_bundle_id(BUNDLE_ID, folder_name, rect)
    }

    fn raise_window(&self, folder_name: &str) {
        raise_window_by_bundle_id(BUNDLE_ID, folder_name);
    }

    fn matches_window_title(&self, _title: &str, _folder_name: &str) -> bool {
        // Chrome --app mode uses the page title, which won't contain the folder name.
        // Chrome windows are matched by CWD detection (not title), so return false.
        false
    }
}
