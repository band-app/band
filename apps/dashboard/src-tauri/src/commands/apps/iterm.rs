use std::fmt::Write;

use super::AppHandler;
use crate::commands::ax_windows;

pub const BUNDLE_ID: &str = "com.googlecode.iterm2";

pub struct ITermDriver;

impl AppHandler for ITermDriver {
    fn bundle_id(&self) -> &str {
        BUNDLE_ID
    }

    fn display_name(&self) -> &'static str {
        "iTerm2"
    }

    fn app_type(&self) -> &'static str {
        "iterm"
    }

    fn window_title_hint(&self, folder_name: &str) -> Option<String> {
        Some(format!("band:{folder_name}"))
    }

    fn watcher_title_hint(&self, _folder_name: &str) -> Option<String> {
        None
    }

    fn launch(
        &self,
        _worktree_path: &str,
        _folder_name: &str,
        _config: &serde_json::Value,
    ) -> Result<(), String> {
        let is_running = !ax_windows::list_windows_for_bundle(BUNDLE_ID).is_empty()
            || is_iterm_process_running();

        if is_running {
            run_applescript(
                r#"tell application "iTerm2" to create window with default profile"#,
            )?;
        } else {
            std::process::Command::new("open")
                .args(["-a", "iTerm"])
                .output()
                .map_err(|e| format!("Failed to launch iTerm: {e}"))?;
        }

        Ok(())
    }

    fn setup(
        &self,
        worktree_path: &str,
        folder_name: &str,
        config: &serde_json::Value,
    ) -> Result<(), String> {
        let window_name = format!("band:{folder_name}");

        let commands: Vec<&str> = config
            .get("commands")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|c| c.get("command").and_then(|v| v.as_str()))
                    .collect()
            })
            .unwrap_or_default();

        let mut script = String::from("set windowName to ");
        script.push_str(&applescript_string(&window_name));
        let _ = write!(
            script,
            "\nset worktreePath to {}",
            applescript_string(worktree_path)
        );
        for (i, cmd) in commands.iter().enumerate() {
            let _ = write!(script, "\nset cmd{} to {}", i + 1, applescript_string(cmd));
        }

        // Target the most recent window (the one launch() just created)
        script.push_str(
            r#"
tell application "iTerm2"
    set targetWindow to current window
    if targetWindow is missing value then return
    tell targetWindow
        tell current session of current tab
            set name to windowName
            write text "cd " & quoted form of worktreePath"#,
        );

        // First command in the first session
        if let Some(cmd) = commands.first() {
            if !cmd.is_empty() {
                script.push_str("\n            write text cmd1");
            }
        }

        script.push_str("\n        end tell");

        // Additional commands create vertical splits
        for (i, cmd) in commands.iter().enumerate().skip(1) {
            script.push_str(
                r#"
        tell current session of current tab
            set newSession to (split vertically with default profile)
            tell newSession
                set name to windowName
                write text "cd " & quoted form of worktreePath"#,
            );

            if !cmd.is_empty() {
                let _ = write!(script, "\n                write text cmd{}", i + 1);
            }

            script.push_str(
                r"
            end tell
        end tell",
            );
        }

        script.push_str(
            r"
    end tell
end tell",
        );

        run_applescript(&script)?;
        Ok(())
    }
}

/// Run an `AppleScript` and return an error if it fails.
fn run_applescript(script: &str) -> Result<(), String> {
    let output = std::process::Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| format!("Failed to run iTerm AppleScript: {e}"))?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() && !stderr.is_empty() {
        return Err(format!("iTerm AppleScript failed: {stderr}"));
    }

    Ok(())
}

/// Check if iTerm2 process is running (it may have no windows yet).
fn is_iterm_process_running() -> bool {
    let output = std::process::Command::new("pgrep")
        .args(["-x", "iTerm2"])
        .output();
    output.is_ok_and(|o| o.status.success())
}

/// Escape a string as an `AppleScript` quoted string literal.
fn applescript_string(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}
