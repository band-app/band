use std::process::Command;

fn git_cmd() -> Command {
    let mut cmd = Command::new("git");
    // Ensure git is found via Homebrew on macOS
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{path}"));
    }
    cmd
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
