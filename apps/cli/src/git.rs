use std::process::Command;

pub fn git_cmd() -> Command {
    let mut cmd = Command::new("git");
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{path}"));
    }
    cmd
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
        .map_err(|e| format!("Failed to create worktree: {e}"))?;

    if output.status.success() {
        return Ok(());
    }

    // Branch may already exist — retry without -b
    let output = git_cmd()
        .args(["worktree", "add", target_path, branch])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to create worktree: {e}"))?;

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
        .map_err(|e| format!("Failed to remove worktree: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}
