use super::{
    find_and_focus_window, position_window_by_bundle_id, raise_window_by_bundle_id, AppDriver,
    ScreenRect,
};

pub const BUNDLE_ID: &str = "com.microsoft.VSCode";

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
        let found = find_and_focus_window(BUNDLE_ID, folder_name)?;

        if !found {
            std::process::Command::new("open")
                .args(["-a", "Visual Studio Code", worktree_path])
                .output()
                .map_err(|e| format!("Failed to open VS Code: {e}"))?;
        }

        Ok(())
    }

    fn position_window(&self, folder_name: &str, rect: &ScreenRect) -> Result<(), String> {
        position_window_by_bundle_id(BUNDLE_ID, folder_name, rect)
    }

    fn raise_window(&self, folder_name: &str) {
        raise_window_by_bundle_id(BUNDLE_ID, folder_name);
    }

    fn matches_window_title(&self, title: &str, folder_name: &str) -> bool {
        title.contains(folder_name)
    }
}
