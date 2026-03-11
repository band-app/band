use super::AppHandler;

pub const BUNDLE_ID: &str = "com.google.Chrome";

pub struct ChromeDriver;

impl AppHandler for ChromeDriver {
    fn bundle_id(&self) -> &str {
        BUNDLE_ID
    }

    fn display_name(&self) -> &'static str {
        "Google Chrome"
    }

    fn app_type(&self) -> &'static str {
        "chrome"
    }

    fn window_title_hint(&self, _folder_name: &str) -> Option<String> {
        None
    }

    fn launch(
        &self,
        _worktree_path: &str,
        _folder_name: &str,
        config: &serde_json::Value,
    ) -> Result<(), String> {
        let url = config
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("about:blank");

        std::process::Command::new("open")
            .args(["-na", "Google Chrome", "--args", &format!("--app={url}")])
            .output()
            .map_err(|e| format!("Failed to open Chrome: {e}"))?;
        Ok(())
    }
}
