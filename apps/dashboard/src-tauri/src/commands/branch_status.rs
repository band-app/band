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
pub struct WorkspaceBranchStatus {
    pub git: GitStatus,
    pub ci: CIStatus,
}

#[derive(Debug, Clone, Serialize)]
pub struct BranchStatusEvent {
    pub statuses: HashMap<String, WorkspaceBranchStatus>,
}

pub struct BranchStatusPollerState(pub Arc<Mutex<Option<Arc<AtomicBool>>>>);

fn gh_cmd() -> Command {
    let mut cmd = Command::new("gh");
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{}", path));
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
            .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<u32>().ok())
            .unwrap_or(0);

        return GitStatus {
            dirty,
            conflict,
            ahead: commit_count,
            behind: 0,
            sync_state: if commit_count > 0 { "ahead".to_string() } else { "synced".to_string() },
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
            let parts: Vec<&str> = text.trim().split_whitespace().collect();
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

    let output = match gh_cmd()
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
    {
        Ok(o) => o,
        Err(_) => return none,
    };

    if !output.status.success() {
        return none;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let runs: Vec<serde_json::Value> = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return none,
    };

    let run = match runs.first() {
        Some(r) => r,
        None => return none,
    };

    let status = run["status"].as_str().unwrap_or("");
    let conclusion = run["conclusion"].as_str().unwrap_or("");
    let url = run["url"].as_str().map(|s| s.to_string());

    let state = match status {
        "completed" => match conclusion {
            "success" => "success",
            "failure" | "timed_out" => "failure",
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

            let app_state = match state::load_state() {
                Ok(s) => s,
                Err(_) => {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    tick_count += 1;
                    continue;
                }
            };

            // CI poll every 30s (6 ticks of 5s), git fetch at same cadence
            let do_ci = tick_count % 6 == 0;

            // git fetch at CI cadence — per unique project path
            if do_ci {
                let mut fetched_paths = std::collections::HashSet::new();
                for proj in &app_state.projects {
                    if fetched_paths.insert(proj.path.clone()) {
                        let _ = git::git_cmd()
                            .args(["fetch", "--quiet", "--all"])
                            .current_dir(&proj.path)
                            .output();
                    }
                }
            }

            let mut statuses: HashMap<String, WorkspaceBranchStatus> = HashMap::new();

            for proj in &app_state.projects {
                for wt in &proj.worktrees {
                    let ws_id = format!("{}-{}", proj.name, wt.branch);
                    let git_status = get_git_status(&wt.path);

                    let ci_status = if do_ci {
                        let ci = get_ci_status(&wt.path, &wt.branch);
                        ci_cache.insert(ws_id.clone(), ci.clone());
                        ci
                    } else {
                        ci_cache.get(&ws_id).cloned().unwrap_or(CIStatus {
                            state: "none".to_string(),
                            url: None,
                        })
                    };

                    statuses.insert(
                        ws_id,
                        WorkspaceBranchStatus {
                            git: git_status,
                            ci: ci_status,
                        },
                    );
                }
            }

            let _ = app_handle.emit("branch-status", BranchStatusEvent { statuses });

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
