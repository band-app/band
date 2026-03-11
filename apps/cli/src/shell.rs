use std::process::{Command, Stdio};
use std::sync::OnceLock;

/// Resolve the user's full shell PATH once (includes nvm/volta/homebrew paths).
#[allow(dead_code)]
pub fn shell_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        if let Ok(output) = Command::new(&shell)
            .args(["-li", "-c", "echo $PATH"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
        {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return path;
            }
        }
        format!(
            "/opt/homebrew/bin:/usr/local/bin:{}",
            std::env::var("PATH").unwrap_or_default()
        )
    })
}
