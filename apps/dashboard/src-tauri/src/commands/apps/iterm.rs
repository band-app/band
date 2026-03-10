use std::fmt::Write;

use super::{position_window_by_bundle_id, raise_window_by_bundle_id, AppDriver, ScreenRect};

pub const BUNDLE_ID: &str = "com.googlecode.iterm2";

pub struct ITermDriver;

impl AppDriver for ITermDriver {
    fn bundle_id(&self) -> &str {
        BUNDLE_ID
    }

    fn display_name(&self) -> &'static str {
        "iTerm2"
    }

    fn open_or_focus(
        &self,
        worktree_path: &str,
        folder_name: &str,
        config: &serde_json::Value,
    ) -> Result<(), String> {
        let window_name = format!("band:{folder_name}");

        // Check if a window with this name already exists
        let check_script = format!(
            r#"tell application "iTerm2"
    repeat with w in windows
        if name of w is "{window_name}" then
            select w
            activate
            return "found"
        end if
    end repeat
    return "notfound"
end tell"#
        );

        let output = std::process::Command::new("osascript")
            .args(["-e", &check_script])
            .output()
            .map_err(|e| format!("Failed to check iTerm windows: {e}"))?;

        let result = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if result == "found" {
            return Ok(());
        }

        // Create a new iTerm window with commands
        let commands = config
            .get("commands")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let mut script = format!(
            r#"tell application "iTerm2"
    set newWindow to (create window with default profile)
    tell newWindow
        set name to "{window_name}"
        tell current session of current tab
            write text "cd {worktree_path}"
"#
        );

        if let Some(first_cmd) = commands.first() {
            if let Some(cmd) = first_cmd.get("command").and_then(|v| v.as_str()) {
                if !cmd.is_empty() {
                    let _ = writeln!(script, "            write text \"{cmd}\"");
                }
            }
        }

        script.push_str("        end tell\n");

        // Additional commands create splits
        for cmd_config in commands.iter().skip(1) {
            let cmd = cmd_config
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let split_dir = cmd_config
                .get("split")
                .and_then(|v| v.as_str())
                .unwrap_or("vertical");

            let split_cmd = if split_dir == "horizontal" {
                "split horizontally with default profile"
            } else {
                "split vertically with default profile"
            };

            let _ = write!(
                script,
                r#"        tell current session of current tab
            set newSession to ({split_cmd})
            tell newSession
                write text "cd {worktree_path}"
"#
            );

            if !cmd.is_empty() {
                let _ = writeln!(script, "                write text \"{cmd}\"");
            }

            script.push_str("            end tell\n");
            script.push_str("        end tell\n");
        }

        script.push_str("    end tell\n");
        script.push_str("end tell\n");

        let _ = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| format!("Failed to open iTerm: {e}"))?;

        Ok(())
    }

    fn position_window(&self, folder_name: &str, rect: &ScreenRect) -> Result<(), String> {
        let window_name = format!("band:{folder_name}");
        position_window_by_bundle_id(BUNDLE_ID, &window_name, rect)
    }

    fn raise_window(&self, folder_name: &str) {
        let window_name = format!("band:{folder_name}");
        raise_window_by_bundle_id(BUNDLE_ID, &window_name);
    }

    fn matches_window_title(&self, title: &str, folder_name: &str) -> bool {
        let window_name = format!("band:{folder_name}");
        title == window_name
    }
}
