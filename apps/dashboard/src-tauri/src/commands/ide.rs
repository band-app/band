use crate::state;

#[tauri::command]
pub fn workspace_focus(workspace_id: String) -> Result<(), String> {
    let app_state = state::load_state()?;

    for proj in &app_state.projects {
        for wt in &proj.worktrees {
            let ws_id = format!("{}-{}", proj.name, wt.branch);
            if ws_id == workspace_id {
                // Use AppleScript to focus VS Code window with matching folder
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
