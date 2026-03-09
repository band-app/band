mod git;
mod shell;
mod state;

use clap::{Parser, Subcommand};
use std::fs;
use std::process;

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
    /// Create a workspace and write a prompt file for automated agent runs
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
        process::exit(1);
    }
}

/// Core logic: create a workspace and return the worktree path without printing.
fn create_workspace(project: &str, branch: &str, base: Option<&str>) -> Result<String, String> {
    let worktree_path = state::with_locked_state(|app_state| {
        let proj = app_state
            .projects
            .iter_mut()
            .find(|p| p.name == project)
            .ok_or_else(|| format!("Project '{project}' not found"))?;

        // Already tracked — return existing path
        if let Some(wt) = proj.worktrees.iter().find(|wt| wt.branch == branch) {
            return Ok(wt.path.clone());
        }

        let target_path = state::worktrees_dir().join(project).join(branch);
        let target_path_str = target_path.to_string_lossy().to_string();

        // Only create the git worktree if it doesn't already exist on disk
        if !target_path.exists() {
            let base_branch = base.unwrap_or(&proj.default_branch);
            git::create_worktree(&proj.path, branch, &target_path_str, Some(base_branch))?;
        }

        proj.worktrees.push(state::WorktreeState {
            branch: branch.to_string(),
            path: target_path_str.clone(),
            head: None,
        });

        Ok(target_path_str)
    })?;

    // Run setup script if configured — failure is non-fatal
    let config = state::load_project_config(&worktree_path);
    if let Some(setup) = &config.setup {
        if let Err(e) = shell::run_script(setup, &worktree_path) {
            eprintln!("Setup script failed for {project}/{branch}: {e}");
        }
    }

    Ok(worktree_path)
}

fn cmd_create(project: &str, branch: &str, base: Option<&str>) -> Result<(), String> {
    let worktree_path = create_workspace(project, branch, base)?;
    println!("{worktree_path}");
    Ok(())
}

fn cmd_run(project: &str, branch: &str, prompt: &str, base: Option<&str>) -> Result<(), String> {
    let worktree_path = create_workspace(project, branch, base)?;

    // Write prompt file
    let workspace_id = format!("{project}-{branch}");
    let prompt_file = state::workspace_prompts_dir().join(format!("{workspace_id}.json"));
    if let Some(parent) = prompt_file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create prompt directory: {e}"))?;
    }
    let prompt_data = serde_json::json!({
        "prompt": prompt,
        "didRun": false
    });
    let prompt_json = serde_json::to_string_pretty(&prompt_data)
        .map_err(|e| format!("Failed to serialize prompt: {e}"))?;
    std::fs::write(&prompt_file, prompt_json)
        .map_err(|e| format!("Failed to write prompt file: {e}"))?;

    // Open workspace in VS Code so the extension picks up the prompt.
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
    state::with_locked_state_read(|app_state| {
        let projects: Vec<_> = if let Some(name) = project_filter {
            app_state
                .projects
                .iter()
                .filter(|p| p.name == name)
                .collect()
        } else {
            app_state.projects.iter().collect()
        };

        if let Some(name) = project_filter {
            if projects.is_empty() {
                return Err(format!("Project '{name}' not found"));
            }
        }

        for proj in projects {
            for wt in &proj.worktrees {
                println!("{}\t{}\t{}", proj.name, wt.branch, wt.path);
            }
        }
        Ok(())
    })
}

fn cmd_remove(project: &str, branch: &str) -> Result<(), String> {
    let (worktree_path, project_path) = state::with_locked_state(|app_state| {
        let proj = app_state
            .projects
            .iter_mut()
            .find(|p| p.name == project)
            .ok_or_else(|| format!("Project '{project}' not found"))?;

        let wt = proj
            .worktrees
            .iter()
            .find(|wt| wt.branch == branch)
            .ok_or_else(|| format!("Worktree '{branch}' not found in project '{project}'"))?;

        let worktree_path = wt.path.clone();
        let project_path = proj.path.clone();

        proj.worktrees.retain(|wt| wt.branch != branch);

        Ok((worktree_path, project_path))
    })?;

    // Load config before removing the worktree (teardown script lives in it)
    let config = state::load_project_config(&worktree_path);

    // Clean up status file
    let status_file = state::status_dir().join(format!("{project}-{branch}.json"));
    let _ = std::fs::remove_file(status_file);

    // Clean up prompt file
    let prompt_file = state::workspace_prompts_dir().join(format!("{project}-{branch}.json"));
    let _ = std::fs::remove_file(prompt_file);

    // Run teardown script before removing worktree so it can access project files
    if let Some(teardown) = &config.teardown {
        if let Err(e) = shell::run_script(teardown, &worktree_path) {
            eprintln!("Teardown script failed for {project}/{branch}: {e}");
        }
    }

    // Remove git worktree
    if std::path::Path::new(&worktree_path).exists() {
        if let Err(e) = git::remove_worktree(&project_path, &worktree_path) {
            eprintln!("Warning: failed to remove git worktree: {e}");
        }
    }

    Ok(())
}

fn cmd_projects() -> Result<(), String> {
    state::with_locked_state_read(|app_state| {
        for proj in &app_state.projects {
            let wt_count = proj.worktrees.len();
            println!(
                "{}\t{}\t{} worktree{}",
                proj.name,
                proj.path,
                wt_count,
                if wt_count == 1 { "" } else { "s" }
            );
        }
        Ok(())
    })
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

    // Match CWD to workspace via state.json
    let workspace_id = state::with_locked_state_read(|app_state| {
        for proj in &app_state.projects {
            for wt in &proj.worktrees {
                if cwd.starts_with(&wt.path) || wt.path == cwd {
                    return Ok(Some(format!("{}-{}", proj.name, wt.branch)));
                }
            }
        }
        Ok(None)
    })?;

    let Some(workspace_id) = workspace_id else {
        return Ok(()); // Not a tracked workspace, silently ignore
    };

    // Write status file atomically (temp file + rename)
    let status_dir = state::status_dir();
    fs::create_dir_all(&status_dir).map_err(|e| format!("Failed to create status dir: {e}"))?;

    let status_file = status_dir.join(format!("{workspace_id}.json"));

    // Read existing status file if present, to preserve fields
    let mut status: serde_json::Value = if status_file.exists() {
        fs::read_to_string(&status_file)
            .ok()
            .and_then(|data| serde_json::from_str(&data).ok())
            .unwrap_or_else(|| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // Update agent status fields
    if let Some(obj) = status.as_object_mut() {
        obj.insert("workspaceId".to_string(), serde_json::json!(workspace_id));

        let agent = obj.entry("agent").or_insert_with(|| serde_json::json!({}));
        if let Some(agent_obj) = agent.as_object_mut() {
            agent_obj.insert("status".to_string(), serde_json::json!(agent_status));
            agent_obj.insert("lastActivity".to_string(), serde_json::json!(chrono_now()));
        }
    }

    let json =
        serde_json::to_string_pretty(&status).map_err(|e| format!("Failed to serialize: {e}"))?;

    // Atomic write: write to temp file then rename
    let tmp_file = status_dir.join(format!(".{workspace_id}.json.tmp"));
    fs::write(&tmp_file, &json).map_err(|e| format!("Failed to write temp file: {e}"))?;
    fs::rename(&tmp_file, &status_file)
        .map_err(|e| format!("Failed to rename status file: {e}"))?;

    Ok(())
}

/// Simple ISO 8601 timestamp without pulling in chrono crate.
fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    // Return Unix timestamp as string (good enough for ordering)
    format!("{}", dur.as_secs())
}
