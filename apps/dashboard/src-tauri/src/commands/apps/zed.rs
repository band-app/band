use super::AppHandler;

pub const BUNDLE_ID: &str = "dev.zed.Zed";

pub struct ZedDriver;

impl AppHandler for ZedDriver {
    fn bundle_id(&self) -> &str {
        BUNDLE_ID
    }

    fn display_name(&self) -> &'static str {
        "Zed"
    }

    fn app_type(&self) -> &'static str {
        "zed"
    }

    fn launch(
        &self,
        worktree_path: &str,
        _folder_name: &str,
        _config: &serde_json::Value,
    ) -> Result<(), String> {
        std::process::Command::new("open")
            .args(["-a", "Zed", worktree_path])
            .output()
            .map_err(|e| format!("Failed to open Zed: {e}"))?;
        Ok(())
    }
}
