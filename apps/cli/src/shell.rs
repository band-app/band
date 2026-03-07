use std::process::{Command, Stdio};
use std::sync::OnceLock;

/// Resolve the user's full shell PATH once (includes nvm/volta/homebrew paths).
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

pub fn run_script(command: &str, cwd: &str) -> Result<(), String> {
    let output = Command::new("sh")
        .args(["-c", command])
        .current_dir(cwd)
        .env("PATH", shell_path())
        .output()
        .map_err(|e| format!("Failed to run script: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Script failed: {stderr}"));
    }

    Ok(())
}
