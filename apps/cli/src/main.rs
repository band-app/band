mod api;
mod shell;
mod state;
mod validate;

use clap::{Parser, Subcommand};
use std::fmt::Write;
use std::process;

#[derive(Parser)]
#[command(name = "band", about = "Band CLI — programmatic workspace management")]
struct Cli {
    /// Output format: text or json
    #[arg(long, global = true, default_value = "text", env = "BAND_OUTPUT")]
    output: String,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Manage registered projects
    Projects {
        #[command(subcommand)]
        cmd: ProjectsCmd,
    },
    /// Manage workspaces (git worktrees)
    Workspaces {
        #[command(subcommand)]
        cmd: WorkspacesCmd,
    },
    /// Show current settings
    Settings,
    /// Manage tasks
    Tasks {
        #[command(subcommand)]
        cmd: TasksCmd,
    },
    /// Manage the remote tunnel
    Tunnel {
        #[command(subcommand)]
        cmd: TunnelCmd,
    },
    /// Receive hook notifications from Claude Code (reads JSON from stdin)
    Notify,
    /// Show command schemas as JSON
    Schema {
        /// Command name (omit to list all commands)
        command: Option<String>,
    },
}

#[derive(Subcommand)]
enum ProjectsCmd {
    /// List registered projects
    List,
    /// Register an existing repository as a project
    Add {
        /// Path to the git repository
        path: String,
        /// Label for the project
        #[arg(long)]
        label: Option<String>,
    },
    /// Unregister a project
    Remove {
        /// Project name
        name: String,
    },
}

#[derive(Subcommand)]
enum WorkspacesCmd {
    /// List workspaces, optionally filtered by project
    List {
        /// Project name (optional filter)
        project: Option<String>,
    },
    /// Create a new workspace (git worktree + state registration)
    Create {
        /// Project name
        project: String,
        /// Branch name
        branch: String,
        /// Base branch to create from (defaults to project's default branch)
        #[arg(long)]
        base: Option<String>,
        /// Prompt to pass to the coding agent
        #[arg(long)]
        prompt: Option<String>,
    },
    /// Remove a workspace (git worktree + state cleanup)
    Remove {
        /// Project name
        project: String,
        /// Branch name
        branch: String,
    },
}

#[derive(Subcommand)]
enum TasksCmd {
    /// List tasks
    List {
        /// Filter by project name
        #[arg(long)]
        project: Option<String>,
        /// Filter by status (running, completed, failed)
        #[arg(long)]
        status: Option<String>,
    },
    /// Cancel a running task
    Cancel {
        /// Task ID (e.g. `tsk_1234567890`)
        task_id: String,
    },
    /// Re-run a completed or failed task
    Rerun {
        /// Task ID (e.g. `tsk_1234567890`)
        task_id: String,
    },
}

#[derive(Subcommand)]
enum TunnelCmd {
    /// Show tunnel status
    Status,
    /// Start the remote tunnel
    Start {
        /// Subdomain to use
        #[arg(long)]
        subdomain: Option<String>,
    },
    /// Stop the remote tunnel
    Stop,
}

// --- Output types ---

struct CommandResult {
    text: String,
    json: serde_json::Value,
}

fn main() {
    let cli = Cli::parse();
    let json_output = cli.output == "json";

    // Schema always outputs JSON, handle separately
    if let Commands::Schema { ref command } = cli.command {
        handle_schema(command.as_deref());
        return;
    }

    let result = match cli.command {
        Commands::Projects { cmd } => match cmd {
            ProjectsCmd::List => cmd_projects_list(),
            ProjectsCmd::Add { path, label } => cmd_projects_add(&path, label.as_deref()),
            ProjectsCmd::Remove { name } => cmd_projects_remove(&name),
        },
        Commands::Workspaces { cmd } => match cmd {
            WorkspacesCmd::List { project } => cmd_workspaces_list(project.as_deref()),
            WorkspacesCmd::Create {
                project,
                branch,
                base,
                prompt,
            } => cmd_workspaces_create(&project, &branch, base.as_deref(), prompt.as_deref()),
            WorkspacesCmd::Remove { project, branch } => cmd_workspaces_remove(&project, &branch),
        },
        Commands::Tasks { cmd } => match cmd {
            TasksCmd::List { project, status } => {
                cmd_tasks_list(project.as_deref(), status.as_deref())
            }
            TasksCmd::Cancel { task_id } => cmd_tasks_cancel(&task_id),
            TasksCmd::Rerun { task_id } => cmd_tasks_rerun(&task_id),
        },
        Commands::Settings => cmd_settings(json_output),
        Commands::Tunnel { cmd } => match cmd {
            TunnelCmd::Status => cmd_tunnel_status(),
            TunnelCmd::Start { subdomain } => cmd_tunnel_start(subdomain.as_deref()),
            TunnelCmd::Stop => cmd_tunnel_stop(),
        },
        Commands::Notify => cmd_notify(),
        Commands::Schema { .. } => unreachable!(),
    };

    match result {
        Ok(output) => {
            if json_output {
                println!("{}", serde_json::to_string(&output.json).unwrap());
            } else if !output.text.is_empty() {
                print!("{}", output.text);
            }
        }
        Err(e) => {
            if json_output {
                eprintln!("{}", serde_json::json!({"error": e}));
            } else {
                eprintln!("error: {e}");
            }
            process::exit(1);
        }
    }
}

/// Open the editor configured in .band/config.json or settings.json defaults.
/// Only opens editor-type apps (vscode, zed) — iTerm/Chrome are managed by the dashboard.
fn open_configured_editor(worktree_path: &str) {
    // Try to load apps config from project config, then fall back to settings defaults
    let apps = load_apps_config(worktree_path);

    // Find the first editor-type app
    let editor = apps.iter().find(|app| {
        let app_type = app.get("type").and_then(|v| v.as_str()).unwrap_or("");
        app_type == "vscode" || app_type == "zed"
    });

    let (app_name, cli_name) = if let Some(app) = editor {
        match app.get("type").and_then(|v| v.as_str()).unwrap_or("vscode") {
            "zed" => ("Zed", "zed"),
            _ => ("Visual Studio Code", "code"),
        }
    } else {
        if apps.is_empty() {
            eprintln!("Warning: IDE not configured, skipping editor launch");
        }
        // No editor-type app found — skip editor launch
        return;
    };

    // Try macOS `open -g` first (opens without stealing focus), fall back to CLI
    let opened = std::process::Command::new("open")
        .args(["-g", "-a", app_name, "--args", worktree_path])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !opened {
        let open_result = std::process::Command::new(cli_name)
            .arg(worktree_path)
            .env("PATH", shell::shell_path())
            .output();
        if let Err(e) = open_result {
            eprintln!("Warning: failed to open {app_name}: {e}");
        }
    }
}

/// Load the apps config from project .band/config.json, falling back to settings.json defaults.
fn load_apps_config(worktree_path: &str) -> Vec<serde_json::Value> {
    // Try project .band/config.json first
    let config_path = std::path::PathBuf::from(worktree_path)
        .join(".band")
        .join("config.json");

    if let Ok(data) = std::fs::read_to_string(&config_path) {
        if let Ok(config) = serde_json::from_str::<serde_json::Value>(&data) {
            if let Some(apps) = config.get("apps").and_then(|v| v.as_array()) {
                if !apps.is_empty() {
                    return apps.clone();
                }
            }
        }
    }

    // Fall back to settings.json defaults
    if let Ok(settings) = state::load_settings() {
        if let Some(defaults) = settings.defaults {
            if let Some(apps) = defaults.get("apps").and_then(|v| v.as_array()) {
                return apps.clone();
            }
        }
    }

    Vec::new()
}

fn handle_schema(command: Option<&str>) {
    match build_schema(command) {
        Ok(schema) => println!("{}", serde_json::to_string_pretty(&schema).unwrap()),
        Err(e) => {
            eprintln!("{}", serde_json::json!({"error": e}));
            process::exit(1);
        }
    }
}

// --- Projects commands ---

fn cmd_projects_list() -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_query_no_input("projects.list")?;

    let projects = data
        .get("projects")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();

    let mut json_projects = Vec::new();
    let mut rows: Vec<[String; 3]> = Vec::new();
    for proj in &projects {
        let name = proj.get("name").and_then(|n| n.as_str()).unwrap_or("");
        let path = proj.get("path").and_then(|p| p.as_str()).unwrap_or("");
        let wt_count = proj
            .get("worktrees")
            .and_then(|w| w.as_array())
            .map_or(0, Vec::len);
        rows.push([
            name.to_string(),
            path.to_string(),
            format!(
                "{} worktree{}",
                wt_count,
                if wt_count == 1 { "" } else { "s" }
            ),
        ]);
        json_projects.push(serde_json::json!({
            "name": name,
            "path": path,
            "worktreeCount": wt_count,
        }));
    }

    let text = format_table(&["NAME", "PATH", "WORKTREES"], &rows);

    Ok(CommandResult {
        text,
        json: serde_json::json!({"projects": json_projects}),
    })
}

fn cmd_projects_add(path: &str, label: Option<&str>) -> Result<CommandResult, String> {
    validate::validate_path(path, "Path")?;

    let client = api::ApiClient::from_settings()?;
    let mut input = serde_json::json!({"path": path});
    if let Some(label) = label {
        input["label"] = serde_json::json!(label);
    }
    let data = client.trpc_mutate("projects.add", &input)?;
    let name = data.get("name").and_then(|n| n.as_str()).unwrap_or("");
    let result_path = data.get("path").and_then(|p| p.as_str()).unwrap_or("");

    Ok(CommandResult {
        text: format!("{name}\n"),
        json: serde_json::json!({"name": name, "path": result_path}),
    })
}

fn cmd_projects_remove(name: &str) -> Result<CommandResult, String> {
    validate::validate_name(name, "Project name")?;

    let client = api::ApiClient::from_settings()?;
    client.trpc_mutate("projects.remove", &serde_json::json!({"name": name}))?;

    Ok(CommandResult {
        text: String::new(),
        json: serde_json::json!({"ok": true}),
    })
}

// --- Workspaces commands ---

fn cmd_workspaces_list(project_filter: Option<&str>) -> Result<CommandResult, String> {
    if let Some(name) = project_filter {
        validate::validate_name(name, "Project name")?;
    }

    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_query_no_input("projects.list")?;

    let projects = data
        .get("projects")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();

    let mut found_any = false;
    let mut rows: Vec<[String; 3]> = Vec::new();
    let mut workspaces = Vec::new();
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
            rows.push([name.to_string(), branch.to_string(), path.to_string()]);
            workspaces.push(serde_json::json!({
                "project": name,
                "branch": branch,
                "path": path,
            }));
            found_any = true;
        }
    }

    if let Some(filter) = project_filter {
        if !found_any {
            return Err(format!("Project '{filter}' not found"));
        }
    }

    let text = format_table(&["PROJECT", "BRANCH", "PATH"], &rows);

    Ok(CommandResult {
        text,
        json: serde_json::json!({"workspaces": workspaces}),
    })
}

fn cmd_workspaces_create(
    project: &str,
    branch: &str,
    base: Option<&str>,
    prompt: Option<&str>,
) -> Result<CommandResult, String> {
    validate::validate_name(project, "Project name")?;
    validate::validate_name(branch, "Branch name")?;
    if let Some(b) = base {
        validate::validate_name(b, "Base branch")?;
    }

    let client = api::ApiClient::from_settings()?;
    let mut input = serde_json::json!({
        "project": project,
        "branch": branch,
    });
    if let Some(base) = base {
        input["base"] = serde_json::json!(base);
    }
    if let Some(prompt) = prompt {
        input["prompt"] = serde_json::json!(prompt);
    }
    let data = client.trpc_mutate("workspaces.create", &input)?;
    let path = data.get("path").and_then(|p| p.as_str()).unwrap_or("");

    // When a prompt is provided, open the editor so the extension picks up the task
    if prompt.is_some() && !path.is_empty() {
        open_configured_editor(path);
    }

    Ok(CommandResult {
        text: format!("{path}\n"),
        json: serde_json::json!({"path": path}),
    })
}

fn cmd_workspaces_remove(project: &str, branch: &str) -> Result<CommandResult, String> {
    validate::validate_name(project, "Project name")?;
    validate::validate_name(branch, "Branch name")?;

    let client = api::ApiClient::from_settings()?;
    client.trpc_mutate(
        "workspaces.remove",
        &serde_json::json!({
            "project": project,
            "branch": branch,
        }),
    )?;

    Ok(CommandResult {
        text: String::new(),
        json: serde_json::json!({"ok": true}),
    })
}

// --- Tasks commands ---

fn cmd_tasks_list(
    project: Option<&str>,
    status: Option<&str>,
) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;

    let mut input = serde_json::json!({});
    if let Some(p) = project {
        input["project"] = serde_json::json!(p);
    }
    if let Some(s) = status {
        input["status"] = serde_json::json!(s);
    }

    let data = client.trpc_query("tasks.list", &input)?;
    let tasks = data
        .get("tasks")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();

    let mut rows: Vec<[String; 4]> = Vec::new();
    let mut json_tasks = Vec::new();
    for task in &tasks {
        let id = task.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let prompt = task.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
        let task_status = task.get("status").and_then(|v| v.as_str()).unwrap_or("");
        let project_name = task.get("project").and_then(|v| v.as_str()).unwrap_or("");
        let branch = task.get("branch").and_then(|v| v.as_str()).unwrap_or("");

        let truncated_prompt = if prompt.len() > 60 {
            format!("{}...", &prompt[..57])
        } else {
            prompt.to_string()
        };

        rows.push([
            id.to_string(),
            task_status.to_string(),
            format!("{project_name}/{branch}"),
            truncated_prompt,
        ]);

        json_tasks.push(task.clone());
    }

    let text = format_table(&["ID", "STATUS", "WORKSPACE", "PROMPT"], &rows);

    Ok(CommandResult {
        text,
        json: serde_json::json!({"tasks": json_tasks}),
    })
}

fn cmd_tasks_cancel(task_id: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    client.trpc_mutate("tasks.cancel", &serde_json::json!({"taskId": task_id}))?;

    Ok(CommandResult {
        text: format!("Task {task_id} cancelled\n"),
        json: serde_json::json!({"cancelled": true, "taskId": task_id}),
    })
}

fn cmd_tasks_rerun(task_id: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_mutate("tasks.rerun", &serde_json::json!({"taskId": task_id}))?;

    let workspace_id = data
        .get("workspaceId")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    Ok(CommandResult {
        text: format!("Task re-run started for workspace {workspace_id}\n"),
        json: data,
    })
}

// --- Settings command ---

fn cmd_settings(json_output: bool) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let result = client.trpc_query_no_input("settings.get")?;

    let text = if json_output {
        String::new()
    } else {
        serde_json::to_string_pretty(&result).unwrap_or_default() + "\n"
    };

    Ok(CommandResult { text, json: result })
}

// --- Tunnel commands ---

fn cmd_tunnel_status() -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_query_no_input("tunnel.status")?;

    let running = data
        .get("running")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let url = data.get("url").and_then(|v| v.as_str());

    let mut text = String::new();
    let _ = writeln!(text, "running: {}", if running { "yes" } else { "no" });
    if let Some(u) = url {
        let _ = writeln!(text, "url: {u}");
    }

    Ok(CommandResult {
        text,
        json: serde_json::json!({"running": running, "url": url}),
    })
}

fn cmd_tunnel_start(subdomain: Option<&str>) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let mut input = serde_json::json!({});
    if let Some(s) = subdomain {
        input["subdomain"] = serde_json::json!(s);
    }
    let data = client.trpc_mutate("tunnel.start", &input)?;

    let url = data.get("url").and_then(|v| v.as_str());
    let mut text = String::new();
    if let Some(u) = url {
        let _ = writeln!(text, "{u}");
    }

    Ok(CommandResult { text, json: data })
}

fn cmd_tunnel_stop() -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    client.trpc_mutate("tunnel.stop", &serde_json::json!({}))?;

    Ok(CommandResult {
        text: String::new(),
        json: serde_json::json!({"ok": true}),
    })
}

// --- Notify command ---

fn cmd_notify() -> Result<CommandResult, String> {
    use std::io::Read;

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

    let agent_status = match hook_event {
        "Stop" => "needs_attention",
        _ => "working",
    };

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
        return Ok(CommandResult {
            text: String::new(),
            json: serde_json::json!({"ok": true}),
        });
    };

    // Resolve CWD to workspace ID
    let resolve_result = client.trpc_query("statuses.resolve", &serde_json::json!({ "cwd": cwd }));
    let workspace_id = match resolve_result {
        Ok(data) => data
            .get("workspaceId")
            .and_then(|v| v.as_str())
            .map(String::from),
        Err(_) => {
            return Ok(CommandResult {
                text: String::new(),
                json: serde_json::json!({"ok": true}),
            });
        }
    };

    let Some(workspace_id) = workspace_id else {
        return Ok(CommandResult {
            text: String::new(),
            json: serde_json::json!({"ok": true}),
        });
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

    Ok(CommandResult {
        text: String::new(),
        json: serde_json::json!({"ok": true}),
    })
}

// --- Table formatting ---

fn format_table<const N: usize>(headers: &[&str; N], rows: &[[String; N]]) -> String {
    if rows.is_empty() {
        return String::new();
    }

    let mut widths = [0usize; N];
    for (i, h) in headers.iter().enumerate() {
        widths[i] = h.len();
    }
    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            widths[i] = widths[i].max(cell.len());
        }
    }

    let mut out = String::new();

    for (i, h) in headers.iter().enumerate() {
        if i > 0 {
            out.push_str("  ");
        }
        if i < N - 1 {
            let _ = write!(out, "{:<width$}", h, width = widths[i]);
        } else {
            out.push_str(h);
        }
    }
    out.push('\n');

    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            if i > 0 {
                out.push_str("  ");
            }
            if i < N - 1 {
                let _ = write!(out, "{:<width$}", cell, width = widths[i]);
            } else {
                out.push_str(cell);
            }
        }
        out.push('\n');
    }

    out
}

// --- Schema ---

#[allow(clippy::too_many_lines)]
fn build_schema(command: Option<&str>) -> Result<serde_json::Value, String> {
    let commands = vec![
        serde_json::json!({
            "name": "projects list",
            "description": "List registered projects",
            "parameters": []
        }),
        serde_json::json!({
            "name": "projects add",
            "description": "Register an existing repository as a project",
            "parameters": [
                {"name": "path", "type": "string", "required": true, "positional": true, "description": "Path to the git repository"},
                {"name": "--label", "type": "string", "required": false, "description": "Label for the project"},
            ]
        }),
        serde_json::json!({
            "name": "projects remove",
            "description": "Unregister a project",
            "parameters": [
                {"name": "name", "type": "string", "required": true, "positional": true, "description": "Project name"},
            ]
        }),
        serde_json::json!({
            "name": "workspaces list",
            "description": "List workspaces, optionally filtered by project",
            "parameters": [
                {"name": "project", "type": "string", "required": false, "positional": true, "description": "Project name (optional filter)"},
            ]
        }),
        serde_json::json!({
            "name": "workspaces create",
            "description": "Create a new workspace (git worktree + state registration)",
            "parameters": [
                {"name": "project", "type": "string", "required": true, "positional": true, "description": "Project name"},
                {"name": "branch", "type": "string", "required": true, "positional": true, "description": "Branch name"},
                {"name": "--base", "type": "string", "required": false, "description": "Base branch to create from (defaults to project's default branch)"},
                {"name": "--prompt", "type": "string", "required": false, "description": "Prompt to pass to the coding agent"},
            ]
        }),
        serde_json::json!({
            "name": "workspaces remove",
            "description": "Remove a workspace (git worktree + state cleanup)",
            "parameters": [
                {"name": "project", "type": "string", "required": true, "positional": true, "description": "Project name"},
                {"name": "branch", "type": "string", "required": true, "positional": true, "description": "Branch name"},
            ]
        }),
        serde_json::json!({
            "name": "settings",
            "description": "Show current settings",
            "parameters": []
        }),
        serde_json::json!({
            "name": "tunnel status",
            "description": "Show tunnel status",
            "parameters": []
        }),
        serde_json::json!({
            "name": "tunnel start",
            "description": "Start the remote tunnel",
            "parameters": [
                {"name": "--subdomain", "type": "string", "required": false, "description": "Subdomain to use"},
            ]
        }),
        serde_json::json!({
            "name": "tunnel stop",
            "description": "Stop the remote tunnel",
            "parameters": []
        }),
        serde_json::json!({
            "name": "tasks list",
            "description": "List tasks, optionally filtered by project or status",
            "parameters": [
                {"name": "--project", "type": "string", "required": false, "description": "Filter by project name"},
                {"name": "--status", "type": "string", "required": false, "description": "Filter by status (running, completed, failed)"},
            ]
        }),
        serde_json::json!({
            "name": "tasks cancel",
            "description": "Cancel a running task",
            "parameters": [
                {"name": "task_id", "type": "string", "required": true, "positional": true, "description": "Task ID (e.g. tsk_1234567890)"},
            ]
        }),
        serde_json::json!({
            "name": "tasks rerun",
            "description": "Re-run a completed or failed task",
            "parameters": [
                {"name": "task_id", "type": "string", "required": true, "positional": true, "description": "Task ID (e.g. tsk_1234567890)"},
            ]
        }),
        serde_json::json!({
            "name": "notify",
            "description": "Receive hook notifications from Claude Code (reads JSON from stdin)",
            "parameters": []
        }),
        serde_json::json!({
            "name": "schema",
            "description": "Show command schemas as JSON",
            "parameters": [
                {"name": "command", "type": "string", "required": false, "positional": true, "description": "Command name (omit to list all commands)"},
            ]
        }),
    ];

    if let Some(name) = command {
        commands
            .iter()
            .find(|c| c["name"] == name)
            .cloned()
            .ok_or_else(|| format!("Unknown command: {name}"))
    } else {
        Ok(serde_json::json!({"commands": commands}))
    }
}

/// Simple Unix timestamp without pulling in chrono crate.
fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", dur.as_secs())
}
