use crate::git;
use crate::state::{self, ProjectState};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ProjectInfo {
    pub name: String,
    pub path: String,
    #[serde(rename = "defaultBranch")]
    pub default_branch: String,
    pub worktrees: Vec<WorktreeInfo>,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorktreeInfo {
    pub branch: String,
    pub path: String,
    pub head: Option<String>,
    #[serde(rename = "hasSetup")]
    pub has_setup: bool,
    #[serde(rename = "hasTeardown")]
    pub has_teardown: bool,
}

impl From<&ProjectState> for ProjectInfo {
    fn from(ps: &ProjectState) -> Self {
        ProjectInfo {
            name: ps.name.clone(),
            path: ps.path.clone(),
            default_branch: ps.default_branch.clone(),
            label: ps.label.clone(),
            worktrees: ps
                .worktrees
                .iter()
                .map(|wt| {
                    let config = state::load_project_config(&wt.path);
                    WorktreeInfo {
                        branch: wt.branch.clone(),
                        path: wt.path.clone(),
                        head: wt.head.clone(),
                        has_setup: config.setup.is_some(),
                        has_teardown: config.teardown.is_some(),
                    }
                })
                .collect(),
        }
    }
}

#[tauri::command]
pub fn project_init(path: String) -> Result<ProjectInfo, String> {
    if !git::is_git_repo(&path) {
        return Err(format!("{path} is not a git repository"));
    }

    let name = git::get_repo_name(&path);
    let default_branch = git::get_default_branch(&path).unwrap_or_else(|_| "main".to_string());

    let mut app_state = state::load_state()?;

    // Check if already registered
    if app_state.projects.iter().any(|p| p.name == name) {
        return Err(format!("Project '{name}' already registered"));
    }

    // Get existing worktrees
    let git_worktrees = git::list_worktrees(&path).unwrap_or_default();
    let worktrees = git_worktrees
        .iter()
        .filter(|wt| !wt.is_bare)
        .map(|wt| state::WorktreeState {
            branch: wt.branch.clone(),
            path: wt.path.clone(),
            head: Some(wt.head.clone()),
        })
        .collect();

    let project = ProjectState {
        name: name.clone(),
        path: path.clone(),
        default_branch,
        worktrees,
        label: None,
    };

    app_state.projects.push(project);
    state::save_state(&app_state)?;

    let info = ProjectInfo::from(app_state.projects.last().unwrap());
    Ok(info)
}

#[tauri::command]
pub fn project_list() -> Result<Vec<ProjectInfo>, String> {
    let mut app_state = state::load_state()?;

    // Refresh worktree info from git for each project
    let mut changed = false;
    for proj in &mut app_state.projects {
        if let Ok(git_worktrees) = git::list_worktrees(&proj.path) {
            let fresh: Vec<state::WorktreeState> = git_worktrees
                .iter()
                .filter(|wt| !wt.is_bare)
                .map(|wt| state::WorktreeState {
                    branch: wt.branch.clone(),
                    path: wt.path.clone(),
                    head: Some(wt.head.clone()),
                })
                .collect();
            if proj.worktrees != fresh {
                proj.worktrees = fresh;
                changed = true;
            }
        } else {
            // Git failed — fall back to pruning stale paths from state.json
            let before = proj.worktrees.len();
            proj.worktrees
                .retain(|wt| std::path::Path::new(&wt.path).exists());
            if proj.worktrees.len() != before {
                changed = true;
            }
        }
    }
    if changed {
        let _ = state::save_state(&app_state);
    }

    Ok(app_state.projects.iter().map(ProjectInfo::from).collect())
}

#[tauri::command]
pub fn project_reorder(names: Vec<String>) -> Result<(), String> {
    let mut app_state = state::load_state()?;

    app_state.projects.sort_by_key(|p| {
        names
            .iter()
            .position(|n| n == &p.name)
            .unwrap_or(usize::MAX)
    });

    state::save_state(&app_state)?;
    Ok(())
}

#[tauri::command]
pub fn project_update_label(name: String, label: Option<String>) -> Result<(), String> {
    let mut app_state = state::load_state()?;
    let project = app_state
        .projects
        .iter_mut()
        .find(|p| p.name == name)
        .ok_or_else(|| format!("Project '{name}' not found"))?;
    project.label = label;
    state::save_state(&app_state)?;
    Ok(())
}

#[tauri::command]
pub fn project_remove(name: String) -> Result<(), String> {
    let mut app_state = state::load_state()?;
    let initial_len = app_state.projects.len();
    app_state.projects.retain(|p| p.name != name);

    if app_state.projects.len() == initial_len {
        return Err(format!("Project '{name}' not found"));
    }

    state::save_state(&app_state)?;

    // Clean up status files for this project
    let status_dir = state::status_dir();
    if let Ok(entries) = std::fs::read_dir(&status_dir) {
        for entry in entries.flatten() {
            let filename = entry.file_name().to_string_lossy().to_string();
            if filename.starts_with(&format!("{name}-")) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    Ok(())
}
