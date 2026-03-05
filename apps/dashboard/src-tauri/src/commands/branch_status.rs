use crate::git;
use crate::state;
use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize)]
pub struct GitStatus {
    pub dirty: bool,
    pub conflict: bool,
    pub ahead: u32,
    pub behind: u32,
    /// "synced" | "ahead" | "behind" | "diverged" | "untracked" (no upstream)
    pub sync_state: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CIStatus {
    /// "none" | "pending" | "running" | "success" | "failure" | "cancelled"
    pub state: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitStatusEvent {
    pub workspace_id: String,
    pub git: GitStatus,
}

#[derive(Debug, Clone, Serialize)]
pub struct CIStatusEvent {
    pub workspace_id: String,
    pub ci: CIStatus,
}

pub struct BranchStatusPollerState(pub Arc<Mutex<Option<Arc<AtomicBool>>>>);

fn gh_cmd() -> Command {
    let mut cmd = Command::new("gh");
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{path}"));
    }
    cmd
}

fn get_git_status(worktree_path: &str) -> GitStatus {
    // git status --porcelain
    let porcelain = git::git_cmd()
        .args(["status", "--porcelain"])
        .current_dir(worktree_path)
        .output();

    let (dirty, conflict) = match porcelain {
        Ok(output) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout);
            let has_changes = !text.trim().is_empty();
            let has_conflict = text.lines().any(|line| {
                line.starts_with("UU ")
                    || line.starts_with("AA ")
                    || line.starts_with("DD ")
                    || line.starts_with("AU ")
                    || line.starts_with("UA ")
                    || line.starts_with("DU ")
                    || line.starts_with("UD ")
            });
            (has_changes, has_conflict)
        }
        _ => (false, false),
    };

    // Check if there's an upstream tracking branch
    let has_upstream = git::git_cmd()
        .args(["rev-parse", "--abbrev-ref", "@{upstream}"])
        .current_dir(worktree_path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if !has_upstream {
        // Count commits on this branch not on any remote-tracking branch
        let commit_count = git::git_cmd()
            .args(["rev-list", "--count", "HEAD", "--not", "--remotes"])
            .current_dir(worktree_path)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .trim()
                    .parse::<u32>()
                    .ok()
            })
            .unwrap_or(0);

        return GitStatus {
            dirty,
            conflict,
            ahead: commit_count,
            behind: 0,
            sync_state: if commit_count > 0 {
                "ahead".to_string()
            } else {
                "synced".to_string()
            },
        };
    }

    // git rev-list --left-right --count HEAD...@{upstream}
    let rev_list = git::git_cmd()
        .args(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])
        .current_dir(worktree_path)
        .output();

    let (ahead, behind) = match rev_list {
        Ok(output) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout);
            let parts: Vec<&str> = text.split_whitespace().collect();
            if parts.len() == 2 {
                let a = parts[0].parse::<u32>().unwrap_or(0);
                let b = parts[1].parse::<u32>().unwrap_or(0);
                (a, b)
            } else {
                (0, 0)
            }
        }
        _ => (0, 0),
    };

    let sync_state = match (ahead, behind) {
        (0, 0) => "synced",
        (_, 0) => "ahead",
        (0, _) => "behind",
        (_, _) => "diverged",
    };

    GitStatus {
        dirty,
        conflict,
        ahead,
        behind,
        sync_state: sync_state.to_string(),
    }
}

fn get_ci_status(worktree_path: &str, branch: &str) -> CIStatus {
    let none = CIStatus {
        state: "none".to_string(),
        url: None,
    };

    let Ok(output) = gh_cmd()
        .args([
            "run",
            "list",
            "--branch",
            branch,
            "--limit",
            "1",
            "--json",
            "status,conclusion,url,updatedAt",
        ])
        .current_dir(worktree_path)
        .output()
    else {
        return none;
    };

    if !output.status.success() {
        return none;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let Ok(runs) = serde_json::from_str::<Vec<serde_json::Value>>(&text) else {
        return none;
    };

    let Some(run) = runs.first() else {
        return none;
    };

    let status = run["status"].as_str().unwrap_or("");
    let conclusion = run["conclusion"].as_str().unwrap_or("");
    let url = run["url"].as_str().map(std::string::ToString::to_string);

    let state = match status {
        "completed" => match conclusion {
            "success" => "success",
            "cancelled" | "skipped" => "cancelled",
            _ => "failure",
        },
        "in_progress" => "running",
        "queued" | "waiting" | "pending" | "requested" => "pending",
        _ => "none",
    };

    CIStatus {
        state: state.to_string(),
        url,
    }
}

#[tauri::command]
pub fn branch_status_watch_start(app: AppHandle) -> Result<(), String> {
    let state = app.state::<BranchStatusPollerState>();
    let mut guard = state.0.lock().unwrap();

    // If already running, stop the old one
    if let Some(old_stop) = guard.take() {
        old_stop.store(true, Ordering::Relaxed);
    }

    let stop_flag = Arc::new(AtomicBool::new(false));
    *guard = Some(stop_flag.clone());
    drop(guard);

    let app_handle = app.clone();

    std::thread::spawn(move || {
        let mut ci_cache: HashMap<String, CIStatus> = HashMap::new();
        let mut tick_count: u64 = 0;

        loop {
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }

            let Ok(app_state) = state::load_state() else {
                std::thread::sleep(std::time::Duration::from_secs(5));
                tick_count += 1;
                continue;
            };

            // CI poll every 30s (6 ticks of 5s), git fetch at same cadence
            let do_ci = tick_count.is_multiple_of(6);

            // Parallel git fetch at CI cadence — per unique project path
            if do_ci {
                let unique_paths: Vec<String> = {
                    let mut seen = std::collections::HashSet::new();
                    app_state
                        .projects
                        .iter()
                        .filter_map(|p| {
                            if seen.insert(p.path.clone()) {
                                Some(p.path.clone())
                            } else {
                                None
                            }
                        })
                        .collect()
                };

                std::thread::scope(|s| {
                    for path in &unique_paths {
                        s.spawn(move || {
                            let _ = git::git_cmd()
                                .args(["fetch", "--quiet", "--all"])
                                .current_dir(path)
                                .output();
                        });
                    }
                });
            }

            // Emit git status per workspace immediately (fast, local)
            for proj in &app_state.projects {
                for wt in &proj.worktrees {
                    let ws_id = format!("{}-{}", proj.name, wt.branch);
                    let git_status = get_git_status(&wt.path);

                    let _ = app_handle.emit(
                        "branch-git-status",
                        GitStatusEvent {
                            workspace_id: ws_id.clone(),
                            git: git_status,
                        },
                    );

                    // Emit cached CI status on non-CI ticks
                    if !do_ci {
                        let ci = ci_cache.get(&ws_id).cloned().unwrap_or(CIStatus {
                            state: "none".to_string(),
                            url: None,
                        });
                        let _ = app_handle.emit(
                            "branch-ci-status",
                            CIStatusEvent {
                                workspace_id: ws_id,
                                ci,
                            },
                        );
                    }
                }
            }

            // On CI ticks, fetch CI status per workspace (slow, network)
            if do_ci {
                for proj in &app_state.projects {
                    for wt in &proj.worktrees {
                        let ws_id = format!("{}-{}", proj.name, wt.branch);
                        let ci = get_ci_status(&wt.path, &wt.branch);
                        ci_cache.insert(ws_id.clone(), ci.clone());

                        let _ = app_handle.emit(
                            "branch-ci-status",
                            CIStatusEvent {
                                workspace_id: ws_id,
                                ci,
                            },
                        );
                    }
                }
            }

            tick_count += 1;
            // Sleep in 1s increments to allow stop_flag checking
            for _ in 0..5 {
                if stop_flag.load(Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn branch_status_watch_stop(app: AppHandle) -> Result<(), String> {
    let state = app.state::<BranchStatusPollerState>();
    let mut guard = state.0.lock().unwrap();
    if let Some(stop_flag) = guard.take() {
        stop_flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}
