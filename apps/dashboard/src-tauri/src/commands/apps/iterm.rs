use std::fmt::Write;

use super::{AppDriver, ScreenRect};
use crate::commands::ax_windows;

pub const BUNDLE_ID: &str = "com.googlecode.iterm2";
const APP_TYPE: &str = "iterm";

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

        let commands: Vec<&str> = config
            .get("commands")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|c| c.get("command").and_then(|v| v.as_str()))
                    .collect()
            })
            .unwrap_or_default();

        // 1. Check WindowRegistry for a known window
        if let Some(entry) = ax_windows::get_window(APP_TYPE, folder_name) {
            if ax_windows::is_window_valid(APP_TYPE, folder_name, BUNDLE_ID) {
                ax_windows::focus_window(entry.pid, entry.cg_window_id);
                return Ok(());
            }
            ax_windows::unregister_window(APP_TYPE, folder_name);
        }

        // 2. Try to find existing window by CGWindowList title
        if let Some(win) = ax_windows::find_window_by_title(BUNDLE_ID, &window_name) {
            ax_windows::register_window(APP_TYPE, folder_name, win.pid, win.cg_window_id);
            ax_windows::focus_window(win.pid, win.cg_window_id);
            return Ok(());
        }

        // 3. Snapshot existing iTerm windows before creation
        let existing = ax_windows::snapshot_window_ids(BUNDLE_ID);

        // Check if iTerm is running
        let is_running = !ax_windows::list_windows_for_bundle(BUNDLE_ID).is_empty()
            || is_iterm_process_running();

        // 4. Create window via AppleScript (kept for iTerm session/split creation)
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

        if is_running {
            // iTerm is running but our window doesn't exist. Create a new one.
            script.push_str(
                r#"
tell application "iTerm2"
    set targetWindow to (create window with default profile)
    tell targetWindow
        tell current session of current tab
            set name to windowName
            write text "cd " & quoted form of worktreePath"#,
            );
        } else {
            // iTerm is not running. `activate` launches it and creates a default window.
            script.push_str(
                r#"
tell application "iTerm2"
    activate
    delay 1
    set targetWindow to current window
    tell targetWindow
        tell current session of current tab
            set name to windowName
            write text "cd " & quoted form of worktreePath"#,
            );
        }

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

        let output = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| format!("Failed to open iTerm: {e}"))?;

        let stderr = String::from_utf8_lossy(&output.stderr);
        if !output.status.success() && !stderr.is_empty() {
            return Err(format!("iTerm AppleScript failed: {stderr}"));
        }

        // 5. Discover the new window via snapshot-diff or title match
        if let Some(win) =
            ax_windows::await_new_window(BUNDLE_ID, Some(&window_name), &existing, 5000)
        {
            ax_windows::register_window(APP_TYPE, folder_name, win.pid, win.cg_window_id);
        } else if let Some(win) = ax_windows::await_new_window(BUNDLE_ID, None, &existing, 2000) {
            // Fallback: if title didn't match (shell prompt override), use snapshot diff
            ax_windows::register_window(APP_TYPE, folder_name, win.pid, win.cg_window_id);
        }

        Ok(())
    }

    fn position_window(&self, folder_name: &str, rect: &ScreenRect) -> Result<(), String> {
        let entry = ax_windows::get_window(APP_TYPE, folder_name)
            .ok_or_else(|| "No iTerm window registered".to_string())?;
        if !ax_windows::position_window(
            entry.pid,
            entry.cg_window_id,
            rect.x,
            rect.y,
            rect.width,
            rect.height,
        ) {
            ax_windows::unregister_window(APP_TYPE, folder_name);
            return Err("Failed to position iTerm window (stale reference)".to_string());
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
        let window_name = format!("band:{folder_name}");
        title.contains(&window_name)
    }
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
