use crate::state;
use std::path::Path;
use std::time::Duration;

const DASHBOARD_WIDTH: i32 = 400;

/// Write the active workspace marker file.
pub fn write_active_marker(workspace_id: &str) {
    let active_file = state::status_dir().join("active.json");
    let _ = std::fs::write(
        active_file,
        format!("{{\"workspaceId\":\"{}\"}}", workspace_id),
    );
}

/// Match a VS Code window title to a workspace ID.
/// Uses the folder name from the worktree path (last path component),
/// which VS Code always includes in its window title.
fn match_title_to_workspace(title: &str) -> Option<String> {
    let app_state = state::load_state().ok()?;
    let mut best_match: Option<(String, usize)> = None;

    for proj in &app_state.projects {
        for wt in &proj.worktrees {
            let folder_name = Path::new(&wt.path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");

            if !folder_name.is_empty() && title.contains(folder_name) {
                let ws_id = format!("{}-{}", proj.name, wt.branch);
                // Prefer the longest folder name match to avoid "app" matching "my-app"
                if best_match.as_ref().map_or(true, |(_, len)| folder_name.len() > *len) {
                    best_match = Some((ws_id, folder_name.len()));
                }
            }
        }
    }

    best_match.map(|(id, _)| id)
}

/// Start a background thread that polls the frontmost VS Code window
/// and updates active.json when the focused workspace changes.
/// This handles workspace tracking for projects without the Band VS Code extension.
pub fn start_focus_polling() {
    std::thread::spawn(|| {
        let mut last_active: Option<String> = None;
        loop {
            std::thread::sleep(Duration::from_secs(1));

            if let Some(ws_id) = detect_frontmost_vscode() {
                if last_active.as_deref() != Some(ws_id.as_str()) {
                    last_active = Some(ws_id.clone());
                    write_active_marker(&ws_id);
                }
            }
        }
    });
}

/// Check if VS Code is the frontmost app, and if so return the matched workspace ID.
fn detect_frontmost_vscode() -> Option<String> {
    let script = r#"
tell application "System Events"
    set frontProc to first application process whose frontmost is true
    if bundle identifier of frontProc is "com.microsoft.VSCode" then
        if (count of windows of frontProc) > 0 then
            return title of window 1 of frontProc
        end if
    end if
end tell
return ""
"#;

    let output = std::process::Command::new("osascript")
        .args(["-e", script])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let title = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if title.is_empty() {
        return None;
    }

    match_title_to_workspace(&title)
}

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

                // Track the active workspace
                write_active_marker(&ws_id);

                // Resize and position the window to the right of the dashboard
                align_vscode_window(&wt.branch);

                return Ok(());
            }
        }
    }

    Err(format!("Workspace '{}' not found", workspace_id))
}

/// Return the currently active workspace ID by reading the marker file.
#[tauri::command]
pub fn get_active_workspace() -> Result<Option<String>, String> {
    let active_file = state::status_dir().join("active.json");
    let data = match std::fs::read_to_string(&active_file) {
        Ok(d) => d,
        Err(_) => return Ok(None),
    };

    #[derive(serde::Deserialize)]
    struct ActiveMarker {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
    }

    match serde_json::from_str::<ActiveMarker>(&data) {
        Ok(marker) => Ok(Some(marker.workspace_id)),
        Err(_) => Ok(None),
    }
}

/// Detect the frontmost VS Code window title and map it to a workspace ID.
#[tauri::command]
pub fn detect_active_workspace() -> Result<Option<String>, String> {
    let script = r#"
tell application "System Events"
    tell (first process whose bundle identifier is "com.microsoft.VSCode")
        if (count of windows) > 0 then
            return title of window 1
        end if
    end tell
end tell
return ""
"#;

    let output = std::process::Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| format!("Failed to detect active window: {}", e))?;

    if !output.status.success() {
        return Ok(None);
    }

    let title = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if title.is_empty() {
        return Ok(None);
    }

    if let Some(ws_id) = match_title_to_workspace(&title) {
        write_active_marker(&ws_id);
        return Ok(Some(ws_id));
    }

    Ok(None)
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
