use crate::commands::ide;
use crate::git;
use crate::state;

#[tauri::command]
pub fn workspace_create(
    project: String,
    branch: String,
    base: Option<String>,
    prompt: Option<String>,
) -> Result<(), String> {
    let mut app_state = state::load_state()?;

    let proj = app_state
        .projects
        .iter_mut()
        .find(|p| p.name == project)
        .ok_or_else(|| format!("Project '{project}' not found"))?;

    // Already tracked in state — nothing to do
    if proj.worktrees.iter().any(|wt| wt.branch == branch) {
        return Ok(());
    }

    let target_path = state::worktrees_dir().join(&project).join(&branch);
    let target_path_str = target_path.to_string_lossy().to_string();

    // Only create the git worktree if it doesn't already exist on disk
    if !target_path.exists() {
        let base_branch = base.as_deref().unwrap_or(&proj.default_branch);

        git::create_worktree(&proj.path, &branch, &target_path_str, Some(base_branch))?;
    }

    proj.worktrees.push(state::WorktreeState {
        branch: branch.clone(),
        path: target_path_str.clone(),
        head: None,
    });

    state::save_state(&app_state)?;

    // Write prompt file if provided
    if let Some(prompt_text) = &prompt {
        let workspace_id = format!("{project}-{branch}");
        let prompt_file = state::band_home()
            .join("workspace-prompts")
            .join(format!("{workspace_id}.json"));
        if let Some(parent) = prompt_file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let prompt_data = serde_json::json!({
            "prompt": prompt_text,
            "didRun": false
        });
        if let Ok(json) = serde_json::to_string_pretty(&prompt_data) {
            let _ = std::fs::write(&prompt_file, json);
        }
    }

    // Run setup script if configured — failure is non-fatal since the workspace
    // was already created successfully.
    let config = state::load_project_config(&target_path_str);
    if let Some(setup) = &config.setup {
        if let Err(e) = state::run_script(setup, &target_path_str) {
            eprintln!("Setup script failed for {project}/{branch}: {e}");
        }
    }

    Ok(())
}

#[tauri::command]
pub fn workspace_list(project: String) -> Result<Vec<state::WorktreeState>, String> {
    let app_state = state::load_state()?;
    let proj = app_state
        .projects
        .iter()
        .find(|p| p.name == project)
        .ok_or_else(|| format!("Project '{project}' not found"))?;

    Ok(proj.worktrees.clone())
}

#[tauri::command]
pub fn workspace_remove(project: String, branch: String) -> Result<(), String> {
    let mut app_state = state::load_state()?;

    let proj = app_state
        .projects
        .iter_mut()
        .find(|p| p.name == project)
        .ok_or_else(|| format!("Project '{project}' not found"))?;

    let wt = proj
        .worktrees
        .iter()
        .find(|wt| wt.branch == branch)
        .ok_or_else(|| format!("Worktree '{branch}' not found"))?;

    let worktree_path = wt.path.clone();
    let project_path = proj.path.clone();

    // Remove from state immediately so the UI stays responsive
    proj.worktrees.retain(|wt| wt.branch != branch);
    state::save_state(&app_state)?;

    // Clean up status file
    let status_file = state::status_dir().join(format!("{project}-{branch}.json"));
    let _ = std::fs::remove_file(status_file);

    // Clean up prompt file
    let prompt_file = state::band_home()
        .join("workspace-prompts")
        .join(format!("{project}-{branch}.json"));
    let _ = std::fs::remove_file(prompt_file);

    // Remove git worktree synchronously so project_list won't re-discover it
    if std::path::Path::new(&worktree_path).exists() {
        let _ = git::remove_worktree(&project_path, &worktree_path);
    }

    // Do remaining cleanup (close IDE, teardown script) in a background thread
    std::thread::spawn(move || {
        let config = state::load_project_config(&worktree_path);
        if let Some(teardown) = &config.teardown {
            let _ = state::run_script(teardown, &worktree_path);
        }

        ide::close_workspace(&worktree_path);
    });

    Ok(())
}

#[tauri::command]
pub fn workspace_run_script(path: String, script_type: String) -> Result<(), String> {
    let config = state::load_project_config(&path);
    let script = match script_type.as_str() {
        "setup" => config.setup,
        "teardown" => config.teardown,
        other => return Err(format!("Unknown script type: {other}")),
    };
    let script = script.ok_or_else(|| format!("No {script_type} script configured"))?;
    state::run_script_in_terminal(&script, &path)
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
                // Track the active workspace
                ide::write_active_marker(&ws_id);

                // Launch VS Code and align window in a background thread
                // so we don't block the IPC channel / webview rendering.
                let path = wt.path.clone();
                let branch = wt.branch.clone();
                std::thread::spawn(move || {
                    let output = std::process::Command::new("code")
                        .arg(&path)
                        .env(
                            "PATH",
                            format!(
                                "/opt/homebrew/bin:/usr/local/bin:{}",
                                std::env::var("PATH").unwrap_or_default()
                            ),
                        )
                        .output();

                    if let Ok(output) = output {
                        if !output.status.success() {
                            let _ = std::process::Command::new("open")
                                .args(["-a", "Visual Studio Code", &path])
                                .output();
                        }
                    }

                    // Position VS Code window to the right of the dashboard
                    ide::align_vscode_window(&branch);
                });

                return Ok(());
            }
        }
    }

    Err(format!("Workspace '{workspace_id}' not found"))
}
