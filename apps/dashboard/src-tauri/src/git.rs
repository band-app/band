use std::path::Path;
use std::process::Command;

pub fn git_cmd() -> Command {
    let mut cmd = Command::new("git");
    // Ensure git is found via Homebrew on macOS
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{path}"));
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

pub fn get_current_branch() -> Option<String> {
    let output = git_cmd()
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch.is_empty() {
        None
    } else {
        Some(branch)
    }
}

pub fn get_repo_name(path: &str) -> String {
    Path::new(path).file_name().map_or_else(
        || "unknown".to_string(),
        |n| n.to_string_lossy().to_string(),
    )
}

pub fn get_default_branch(path: &str) -> Result<String, String> {
    // Try symbolic-ref to origin HEAD
    let output = git_cmd()
        .args(["symbolic-ref", "refs/remotes/origin/HEAD"])
        .current_dir(path)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;

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
            .map_err(|e| format!("Failed to run git: {e}"))?;
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
        .map_err(|e| format!("Failed to list worktrees: {e}"))?;

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
            if current_branch.is_empty() && !is_bare {
                current_branch = resolve_detached_branch(&current_path);
            }
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
        if current_branch.is_empty() && !is_bare {
            current_branch = resolve_detached_branch(&current_path);
        }
        worktrees.push(WorktreeInfo {
            branch: current_branch,
            path: current_path,
            head: current_head,
            is_bare,
        });
    }

    Ok(worktrees)
}

/// When a worktree has a detached HEAD (e.g. during rebase), try to resolve
/// the original branch name from git's rebase state files.
fn resolve_detached_branch(worktree_path: &str) -> String {
    let git_file = Path::new(worktree_path).join(".git");
    let gitdir = if git_file.is_file() {
        // Worktree: .git is a file containing "gitdir: <path>"
        match std::fs::read_to_string(&git_file) {
            Ok(content) => match content.strip_prefix("gitdir: ") {
                Some(dir) => std::path::PathBuf::from(dir.trim()),
                None => return String::new(),
            },
            Err(_) => return String::new(),
        }
    } else if git_file.is_dir() {
        git_file
    } else {
        return String::new();
    };

    // Check interactive rebase (rebase-merge) then regular rebase (rebase-apply)
    for rebase_dir in &["rebase-merge", "rebase-apply"] {
        let head_name = gitdir.join(rebase_dir).join("head-name");
        if let Ok(name) = std::fs::read_to_string(&head_name) {
            let name = name.trim();
            return name.strip_prefix("refs/heads/").unwrap_or(name).to_string();
        }
    }

    String::new()
}

pub fn create_worktree(
    repo_path: &str,
    branch: &str,
    target_path: &str,
    base_branch: Option<&str>,
) -> Result<(), String> {
    // Try creating a new branch with -b
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

    // Branch may already exist — retry without -b to check out the existing branch
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@test.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@test.com")
            .output()
            .expect("git command failed");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// Resolve symlinks (macOS /var -> /private/var) to match git's output.
    fn real_path(p: &Path) -> std::path::PathBuf {
        fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
    }

    fn create_repo(tmp: &Path) -> std::path::PathBuf {
        let tmp = real_path(tmp);
        let repo = tmp.join("repo");
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        fs::write(repo.join("file.txt"), "hello").unwrap();
        git(&repo, &["add", "file.txt"]);
        git(&repo, &["commit", "-m", "initial"]);
        repo
    }

    #[test]
    fn resolve_detached_branch_with_rebase_merge() {
        let tmp = tempfile::tempdir().unwrap();
        let worktree_path = tmp.path().join("my-worktree");
        fs::create_dir_all(&worktree_path).unwrap();

        // Create a fake gitdir
        let gitdir = tmp.path().join("gitdir");
        fs::create_dir_all(&gitdir).unwrap();

        // Write .git file pointing to the gitdir
        fs::write(
            worktree_path.join(".git"),
            format!("gitdir: {}", gitdir.display()),
        )
        .unwrap();

        // Create rebase-merge/head-name
        let rebase_dir = gitdir.join("rebase-merge");
        fs::create_dir_all(&rebase_dir).unwrap();
        fs::write(rebase_dir.join("head-name"), "refs/heads/my-feature\n").unwrap();

        let branch = resolve_detached_branch(worktree_path.to_str().unwrap());
        assert_eq!(branch, "my-feature");
    }

    #[test]
    fn resolve_detached_branch_with_rebase_apply() {
        let tmp = tempfile::tempdir().unwrap();
        let worktree_path = tmp.path().join("my-worktree");
        fs::create_dir_all(&worktree_path).unwrap();

        let gitdir = tmp.path().join("gitdir");
        fs::create_dir_all(&gitdir).unwrap();

        fs::write(
            worktree_path.join(".git"),
            format!("gitdir: {}", gitdir.display()),
        )
        .unwrap();

        // Create rebase-apply/head-name (regular rebase)
        let rebase_dir = gitdir.join("rebase-apply");
        fs::create_dir_all(&rebase_dir).unwrap();
        fs::write(rebase_dir.join("head-name"), "refs/heads/fix-branch\n").unwrap();

        let branch = resolve_detached_branch(worktree_path.to_str().unwrap());
        assert_eq!(branch, "fix-branch");
    }

    #[test]
    fn resolve_detached_branch_prefers_rebase_merge_over_apply() {
        let tmp = tempfile::tempdir().unwrap();
        let worktree_path = tmp.path().join("my-worktree");
        fs::create_dir_all(&worktree_path).unwrap();

        let gitdir = tmp.path().join("gitdir");
        fs::create_dir_all(&gitdir).unwrap();

        fs::write(
            worktree_path.join(".git"),
            format!("gitdir: {}", gitdir.display()),
        )
        .unwrap();

        // Both exist — rebase-merge should win (checked first)
        let merge_dir = gitdir.join("rebase-merge");
        fs::create_dir_all(&merge_dir).unwrap();
        fs::write(merge_dir.join("head-name"), "refs/heads/merge-branch\n").unwrap();

        let apply_dir = gitdir.join("rebase-apply");
        fs::create_dir_all(&apply_dir).unwrap();
        fs::write(apply_dir.join("head-name"), "refs/heads/apply-branch\n").unwrap();

        let branch = resolve_detached_branch(worktree_path.to_str().unwrap());
        assert_eq!(branch, "merge-branch");
    }

    #[test]
    fn resolve_detached_branch_no_rebase_state() {
        let tmp = tempfile::tempdir().unwrap();
        let worktree_path = tmp.path().join("my-worktree");
        fs::create_dir_all(&worktree_path).unwrap();

        let gitdir = tmp.path().join("gitdir");
        fs::create_dir_all(&gitdir).unwrap();

        fs::write(
            worktree_path.join(".git"),
            format!("gitdir: {}", gitdir.display()),
        )
        .unwrap();

        // No rebase state files — should return empty
        let branch = resolve_detached_branch(worktree_path.to_str().unwrap());
        assert_eq!(branch, "");
    }

    #[test]
    fn resolve_detached_branch_no_git_file() {
        let tmp = tempfile::tempdir().unwrap();
        let worktree_path = tmp.path().join("no-git");
        fs::create_dir_all(&worktree_path).unwrap();

        // No .git file at all
        let branch = resolve_detached_branch(worktree_path.to_str().unwrap());
        assert_eq!(branch, "");
    }

    #[test]
    fn list_worktrees_returns_main_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = create_repo(tmp.path());

        let worktrees = list_worktrees(repo.to_str().unwrap()).unwrap();

        assert_eq!(worktrees.len(), 1);
        assert_eq!(worktrees[0].branch, "main");
        assert_eq!(worktrees[0].path, repo.to_str().unwrap());
        assert!(!worktrees[0].head.is_empty());
        assert!(!worktrees[0].is_bare);
    }

    #[test]
    fn list_worktrees_returns_named_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = create_repo(tmp.path());
        let wt_path = real_path(tmp.path()).join("wt-feature");

        git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "feature",
                wt_path.to_str().unwrap(),
            ],
        );

        let worktrees = list_worktrees(repo.to_str().unwrap()).unwrap();

        assert_eq!(worktrees.len(), 2);
        let feature = worktrees.iter().find(|wt| wt.branch == "feature");
        assert!(feature.is_some());
        assert_eq!(feature.unwrap().path, wt_path.to_str().unwrap());
    }

    #[test]
    fn list_worktrees_resolves_detached_with_rebase_state() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = create_repo(tmp.path());
        let wt_path = real_path(tmp.path()).join("wt-detached");

        // Create a detached worktree
        git(
            &repo,
            &[
                "worktree",
                "add",
                "--detach",
                wt_path.to_str().unwrap(),
                "HEAD",
            ],
        );

        // Read gitdir from the worktree's .git file
        let git_content = fs::read_to_string(wt_path.join(".git")).unwrap();
        let gitdir = git_content.strip_prefix("gitdir: ").unwrap().trim();

        // Simulate interactive rebase state
        let rebase_dir = Path::new(gitdir).join("rebase-merge");
        fs::create_dir_all(&rebase_dir).unwrap();
        fs::write(rebase_dir.join("head-name"), "refs/heads/rebasing-branch\n").unwrap();

        let worktrees = list_worktrees(repo.to_str().unwrap()).unwrap();

        let detached = worktrees
            .iter()
            .find(|wt| wt.path == wt_path.to_str().unwrap());
        assert!(detached.is_some());
        assert_eq!(detached.unwrap().branch, "rebasing-branch");
    }

    #[test]
    fn list_worktrees_detached_without_rebase_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = create_repo(tmp.path());
        let wt_path = real_path(tmp.path()).join("wt-detached-plain");

        git(
            &repo,
            &[
                "worktree",
                "add",
                "--detach",
                wt_path.to_str().unwrap(),
                "HEAD",
            ],
        );

        let worktrees = list_worktrees(repo.to_str().unwrap()).unwrap();

        let detached = worktrees
            .iter()
            .find(|wt| wt.path == wt_path.to_str().unwrap());
        assert!(detached.is_some());
        assert_eq!(detached.unwrap().branch, "");
    }
}
