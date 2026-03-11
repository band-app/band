use super::AppHandler;

pub const BUNDLE_ID: &str = "com.microsoft.VSCode";

pub struct VsCodeDriver;

impl AppHandler for VsCodeDriver {
    fn bundle_id(&self) -> &str {
        BUNDLE_ID
    }

    fn display_name(&self) -> &'static str {
        "Visual Studio Code"
    }

    fn app_type(&self) -> &'static str {
        "vscode"
    }

    fn launch(
        &self,
        worktree_path: &str,
        _folder_name: &str,
        _config: &serde_json::Value,
    ) -> Result<(), String> {
        std::process::Command::new("open")
            .args(["-a", "Visual Studio Code", worktree_path])
            .output()
            .map_err(|e| format!("Failed to open VS Code: {e}"))?;
        Ok(())
    }
}
