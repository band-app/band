use std::path::Path;
use std::process::Command;

fn git_cmd() -> Command {
    let mut cmd = Command::new("git");
    // Ensure git is found via Homebrew on macOS
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{}", path));
    }
    cmd
}

pub fn is_git_repo(path: &str) -> bool {
    git_cmd()
        .args(["rev-parse", "--git-dir"])
        .current_dir(path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn get_repo_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

pub fn get_default_branch(path: &str) -> Result<String, String> {
    // Try symbolic-ref to origin HEAD
    let output = git_cmd()
        .args(["symbolic-ref", "refs/remotes/origin/HEAD"])
        .current_dir(path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if output.status.success() {
        let refname = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if let Some(branch) = refname.strip_prefix("refs/remotes/origin/") {
            return Ok(branch.to_string());
        }
    }

    // Fallback: check if main or master exists
    for branch in &["main", "master"] {
        let output = git_cmd()
            .args(["rev-parse", "--verify", branch])
            .current_dir(path)
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))?;
        if output.status.success() {
            return Ok(branch.to_string());
        }
    }

    Ok("main".to_string())
}

pub struct WorktreeInfo {
    pub branch: String,
    pub path: String,
    pub head: String,
    pub is_bare: bool,
}

pub fn list_worktrees(repo_path: &str) -> Result<Vec<WorktreeInfo>, String> {
    let output = git_cmd()
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to list worktrees: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut worktrees = Vec::new();
    let mut current_path = String::new();
    let mut current_head = String::new();
    let mut current_branch = String::new();
    let mut is_bare = false;

    for line in text.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            current_path = path.to_string();
        } else if let Some(head) = line.strip_prefix("HEAD ") {
            current_head = head.to_string();
        } else if let Some(branch_ref) = line.strip_prefix("branch ") {
            current_branch = branch_ref
                .strip_prefix("refs/heads/")
                .unwrap_or(branch_ref)
                .to_string();
        } else if line == "bare" {
            is_bare = true;
        } else if line.is_empty() && !current_path.is_empty() {
            worktrees.push(WorktreeInfo {
                branch: current_branch.clone(),
                path: current_path.clone(),
                head: current_head.clone(),
                is_bare,
            });
            current_path.clear();
            current_head.clear();
            current_branch.clear();
            is_bare = false;
        }
    }

    // Push last entry
    if !current_path.is_empty() {
        worktrees.push(WorktreeInfo {
            branch: current_branch,
            path: current_path,
            head: current_head,
            is_bare,
        });
    }

    Ok(worktrees)
}

pub fn create_worktree(
    repo_path: &str,
    branch: &str,
    target_path: &str,
    base_branch: Option<&str>,
) -> Result<(), String> {
    let mut args = vec!["worktree", "add"];

    if let Some(base) = base_branch {
        args.extend_from_slice(&["-b", branch, target_path, base]);
    } else {
        args.extend_from_slice(&["-b", branch, target_path]);
    }

    let output = git_cmd()
        .args(&args)
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to create worktree: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

pub fn remove_worktree(repo_path: &str, worktree_path: &str) -> Result<(), String> {
    let output = git_cmd()
        .args(["worktree", "remove", "--force", worktree_path])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to remove worktree: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}
