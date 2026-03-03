use crate::git;
use crate::state;

#[tauri::command]
pub fn workspace_create(project: String, branch: String, base: Option<String>) -> Result<(), String> {
    let mut app_state = state::load_state()?;

    let proj = app_state
        .projects
        .iter_mut()
        .find(|p| p.name == project)
        .ok_or_else(|| format!("Project '{}' not found", project))?;

    // Check if worktree for this branch already exists
    if proj.worktrees.iter().any(|wt| wt.branch == branch) {
        return Err(format!(
            "Worktree for branch '{}' already exists in project '{}'",
            branch, project
        ));
    }

    let band_home = state::band_home();
    let target_path = band_home
        .join("worktrees")
        .join(&project)
        .join(&branch);
    let target_path_str = target_path.to_string_lossy().to_string();

    let base_branch = base
        .as_deref()
        .unwrap_or(&proj.default_branch);

    git::create_worktree(&proj.path, &branch, &target_path_str, Some(base_branch))?;

    proj.worktrees.push(state::WorktreeState {
        branch: branch.clone(),
        path: target_path_str,
        head: None,
    });

    state::save_state(&app_state)?;
    Ok(())
}

#[tauri::command]
pub fn workspace_list(project: String) -> Result<Vec<state::WorktreeState>, String> {
    let app_state = state::load_state()?;
    let proj = app_state
        .projects
        .iter()
        .find(|p| p.name == project)
        .ok_or_else(|| format!("Project '{}' not found", project))?;

    Ok(proj.worktrees.clone())
}

#[tauri::command]
pub fn workspace_remove(project: String, branch: String) -> Result<(), String> {
    let mut app_state = state::load_state()?;

    let proj = app_state
        .projects
        .iter_mut()
        .find(|p| p.name == project)
        .ok_or_else(|| format!("Project '{}' not found", project))?;

    let wt = proj
        .worktrees
        .iter()
        .find(|wt| wt.branch == branch)
        .ok_or_else(|| format!("Worktree '{}' not found", branch))?;

    let worktree_path = wt.path.clone();

    // Remove git worktree (ignore errors if the path no longer exists on disk)
    if std::path::Path::new(&worktree_path).exists() {
        git::remove_worktree(&proj.path, &worktree_path)?;
    }

    // Remove from state
    proj.worktrees.retain(|wt| wt.branch != branch);
    state::save_state(&app_state)?;

    // Clean up status file
    let status_file = state::status_dir().join(format!("{}-{}.json", project, branch));
    let _ = std::fs::remove_file(status_file);

    Ok(())
}

#[tauri::command]
pub fn workspace_open(workspace_id: String) -> Result<(), String> {
    // workspace_id is "project-branch"
    let app_state = state::load_state()?;

    // Find the workspace
    for proj in &app_state.projects {
        for wt in &proj.worktrees {
            let ws_id = format!("{}-{}", proj.name, wt.branch);
            if ws_id == workspace_id {
                // Open VS Code at the worktree path
                let output = std::process::Command::new("code")
                    .arg(&wt.path)
                    .env(
                        "PATH",
                        format!(
                            "/opt/homebrew/bin:/usr/local/bin:{}",
                            std::env::var("PATH").unwrap_or_default()
                        ),
                    )
                    .output()
                    .map_err(|e| format!("Failed to launch VS Code: {}", e))?;

                if !output.status.success() {
                    // Fallback: try `open -a "Visual Studio Code" {path}`
                    std::process::Command::new("open")
                        .args(["-a", "Visual Studio Code", &wt.path])
                        .output()
                        .map_err(|e| format!("Failed to open VS Code: {}", e))?;
                }

                // Position VS Code window to the right of the dashboard
                align_vscode_window(&wt.branch);

                return Ok(());
            }
        }
    }

    Err(format!("Workspace '{}' not found", workspace_id))
}

/// Use AppleScript to position the VS Code window to fill the screen
/// to the right of the dashboard (400px from the left edge).
fn align_vscode_window(branch: &str) {
    let dashboard_width = 400;
    let script = format!(
        r#"
use framework "AppKit"

-- Get the main screen frame
set screenFrame to (current application's NSScreen's mainScreen()'s frame()) as record
set screenWidth to |width| of |size| of screenFrame
set screenHeight to |height| of |size| of screenFrame

set vsX to {dashboard_width}
set vsY to 0
set vsW to (screenWidth - {dashboard_width}) as integer
set vsH to screenHeight as integer

delay 0.5
tell application "Visual Studio Code"
    activate
    set foundWindow to false
    repeat with w in windows
        if name of w contains "{branch}" then
            set bounds of w to {{vsX, vsY, vsX + vsW, vsY + vsH}}
            set foundWindow to true
            exit repeat
        end if
    end repeat
    if not foundWindow then
        -- Fall back to the frontmost window
        if (count of windows) > 0 then
            set bounds of window 1 to {{vsX, vsY, vsX + vsW, vsY + vsH}}
        end if
    end if
end tell
"#,
        dashboard_width = dashboard_width,
        branch = branch
    );

    // Run in background — don't block the command
    std::thread::spawn(move || {
        let _ = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output();
    });
}
