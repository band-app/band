mod api;
mod shell;
mod state;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "band", about = "Band CLI — programmatic workspace management")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Create a new workspace (git worktree + state registration)
    Create {
        /// Project name
        project: String,
        /// Branch name
        branch: String,
        /// Base branch to create from (defaults to project's default branch)
        #[arg(long)]
        base: Option<String>,
    },
    /// Create a workspace and dispatch a prompt to the coding agent
    Run {
        /// Project name
        project: String,
        /// Branch name
        branch: String,
        /// Prompt to pass to the coding agent
        #[arg(long)]
        prompt: String,
        /// Base branch to create from (defaults to project's default branch)
        #[arg(long)]
        base: Option<String>,
    },
    /// List workspaces, optionally filtered by project
    List {
        /// Project name (optional filter)
        project: Option<String>,
    },
    /// Remove a workspace (git worktree + state cleanup)
    Remove {
        /// Project name
        project: String,
        /// Branch name
        branch: String,
    },
    /// List registered projects
    Projects,
    /// Receive hook notifications from Claude Code (reads JSON from stdin)
    Notify,
}

fn main() {
    let cli = Cli::parse();

    let result = match cli.command {
        Commands::Create {
            project,
            branch,
            base,
        } => cmd_create(&project, &branch, base.as_deref()),
        Commands::Run {
            project,
            branch,
            prompt,
            base,
        } => cmd_run(&project, &branch, &prompt, base.as_deref()),
        Commands::List { project } => cmd_list(project.as_deref()),
        Commands::Remove { project, branch } => cmd_remove(&project, &branch),
        Commands::Projects => cmd_projects(),
        Commands::Notify => cmd_notify(),
    };

    if let Err(e) = result {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn cmd_create(project: &str, branch: &str, base: Option<&str>) -> Result<(), String> {
    let client = api::ApiClient::from_settings()?;
    let mut input = serde_json::json!({
        "project": project,
        "branch": branch,
    });
    if let Some(base) = base {
        input["base"] = serde_json::json!(base);
    }
    let data = client.trpc_mutate("workspaces.create", &input)?;
    let path = data
        .get("path")
        .and_then(|p| p.as_str())
        .unwrap_or("");
    println!("{path}");
    Ok(())
}

fn cmd_run(project: &str, branch: &str, prompt: &str, base: Option<&str>) -> Result<(), String> {
    let client = api::ApiClient::from_settings()?;
    let mut input = serde_json::json!({
        "project": project,
        "branch": branch,
        "prompt": prompt,
    });
    if let Some(base) = base {
        input["base"] = serde_json::json!(base);
    }
    let data = client.trpc_mutate("workspaces.create", &input)?;
    let worktree_path = data
        .get("path")
        .and_then(|p| p.as_str())
        .unwrap_or("")
        .to_string();

    // Open workspace in VS Code so the extension picks up the task.
    // Try macOS `open -g` first (opens without stealing focus), fall back to `code`.
    let opened = std::process::Command::new("open")
        .args(["-g", "-a", "Visual Studio Code", "--args", &worktree_path])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !opened {
        let open_result = std::process::Command::new("code")
            .arg(&worktree_path)
            .env("PATH", shell::shell_path())
            .output();
        if let Err(e) = open_result {
            eprintln!("Warning: failed to open VS Code: {e}");
        }
    }

    println!("{worktree_path}");
    Ok(())
}

fn cmd_list(project_filter: Option<&str>) -> Result<(), String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_query("projects.list", &serde_json::json!({}))?;

    let projects = data
        .get("projects")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();

    let mut found_any = false;
    for proj in &projects {
        let name = proj.get("name").and_then(|n| n.as_str()).unwrap_or("");
        if let Some(filter) = project_filter {
            if name != filter {
                continue;
            }
        }
        let worktrees = proj
            .get("worktrees")
            .and_then(|w| w.as_array())
            .cloned()
            .unwrap_or_default();
        for wt in &worktrees {
            let branch = wt.get("branch").and_then(|b| b.as_str()).unwrap_or("");
            let path = wt.get("path").and_then(|p| p.as_str()).unwrap_or("");
            println!("{name}\t{branch}\t{path}");
            found_any = true;
        }
    }

    if let Some(filter) = project_filter {
        if !found_any {
            return Err(format!("Project '{filter}' not found"));
        }
    }

    Ok(())
}

fn cmd_remove(project: &str, branch: &str) -> Result<(), String> {
    let client = api::ApiClient::from_settings()?;
    client.trpc_mutate(
        "workspaces.remove",
        &serde_json::json!({
            "project": project,
            "branch": branch,
        }),
    )?;
    Ok(())
}

fn cmd_projects() -> Result<(), String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_query("projects.list", &serde_json::json!({}))?;

    let projects = data
        .get("projects")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();

    for proj in &projects {
        let name = proj.get("name").and_then(|n| n.as_str()).unwrap_or("");
        let path = proj.get("path").and_then(|p| p.as_str()).unwrap_or("");
        let wt_count = proj
            .get("worktrees")
            .and_then(|w| w.as_array())
            .map_or(0, Vec::len);
        println!(
            "{name}\t{path}\t{wt_count} worktree{}",
            if wt_count == 1 { "" } else { "s" }
        );
    }

    Ok(())
}

fn cmd_notify() -> Result<(), String> {
    use std::io::Read;

    // Read JSON from stdin
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .map_err(|e| format!("Failed to read stdin: {e}"))?;

    let payload: serde_json::Value = serde_json::from_str(&input)
        .map_err(|e| format!("Failed to parse JSON from stdin: {e}"))?;

    let hook_event = payload
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // Map hook event to agent status
    let agent_status = match hook_event {
        "Stop" | "PermissionRequest" => "needs_attention",
        _ => "working",
    };

    // Get CWD from the hook payload, or fall back to current dir
    let cwd = payload
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|p| p.to_string_lossy().to_string())
        })
        .unwrap_or_default();

    // All API calls for notify are fire-and-forget — fail silently
    // because this runs from git hooks and must not break git workflows
    let Ok(client) = api::ApiClient::from_settings() else {
        return Ok(());
    };

    // Resolve CWD to workspace ID
    let resolve_result = client.trpc_query(
        "statuses.resolve",
        &serde_json::json!({ "cwd": cwd }),
    );
    let workspace_id = match resolve_result {
        Ok(data) => data
            .get("workspaceId")
            .and_then(|v| v.as_str())
            .map(String::from),
        Err(_) => return Ok(()),
    };

    let Some(workspace_id) = workspace_id else {
        return Ok(()); // Not a tracked workspace, silently ignore
    };

    // Update status via API
    let _ = client.trpc_mutate(
        "statuses.update",
        &serde_json::json!({
            "workspaceId": workspace_id,
            "agent": {
                "status": agent_status,
                "lastActivity": chrono_now(),
            },
        }),
    );

    Ok(())
}

/// Simple Unix timestamp without pulling in chrono crate.
fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", dur.as_secs())
}
