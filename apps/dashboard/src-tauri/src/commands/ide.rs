use crate::state;

const DASHBOARD_WIDTH: i32 = 400;

/// Use AppleScript + System Events to position the VS Code window
/// to fill the screen to the right of the dashboard.
pub fn align_vscode_window(branch: &str) {
    let branch = branch.to_string();
    std::thread::spawn(move || {
        let script = format!(
            r#"
tell application "Finder"
    set screenBounds to bounds of window of desktop
end tell
set screenWidth to item 3 of screenBounds
set screenHeight to item 4 of screenBounds

set dashWidth to {dashboard_width}
set vsW to screenWidth - dashWidth
set vsH to screenHeight

delay 0.5

tell application "System Events"
    tell (first process whose bundle identifier is "com.microsoft.VSCode")
        set foundWindow to false
        repeat with w in windows
            if title of w contains "{branch}" then
                set position of w to {{dashWidth, 0}}
                set size of w to {{vsW, vsH}}
                set foundWindow to true
                exit repeat
            end if
        end repeat
        if not foundWindow then
            if (count of windows) > 0 then
                set position of window 1 to {{dashWidth, 0}}
                set size of window 1 to {{vsW, vsH}}
            end if
        end if
    end tell
end tell
"#,
            dashboard_width = DASHBOARD_WIDTH,
            branch = branch
        );

        let _ = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output();
    });
}

#[tauri::command]
pub fn workspace_focus(workspace_id: String) -> Result<(), String> {
    let app_state = state::load_state()?;

    for proj in &app_state.projects {
        for wt in &proj.worktrees {
            let ws_id = format!("{}-{}", proj.name, wt.branch);
            if ws_id == workspace_id {
                // Focus VS Code window with matching folder
                let script = format!(
                    r#"tell application "Visual Studio Code"
    activate
    set foundWindow to false
    repeat with w in windows
        if name of w contains "{}" then
            set index of w to 1
            set foundWindow to true
            exit repeat
        end if
    end repeat
    if not foundWindow then
        do shell script "code '{}'"
    end if
end tell"#,
                    wt.branch, wt.path
                );

                std::process::Command::new("osascript")
                    .args(["-e", &script])
                    .output()
                    .map_err(|e| format!("Failed to focus window: {}", e))?;

                // Resize and position the window to the right of the dashboard
                align_vscode_window(&wt.branch);

                return Ok(());
            }
        }
    }

    Err(format!("Workspace '{}' not found", workspace_id))
}

#[tauri::command]
pub fn pick_folder() -> Result<Option<String>, String> {
    // Use native macOS dialog via AppleScript
    let output = std::process::Command::new("osascript")
        .args([
            "-e",
            r#"set theFolder to choose folder with prompt "Select a git repository"
return POSIX path of theFolder"#,
        ])
        .output()
        .map_err(|e| format!("Failed to open folder picker: {}", e))?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            Ok(None)
        } else {
            Ok(Some(path))
        }
    } else {
        Ok(None) // User cancelled
    }
}
