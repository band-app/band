mod api;
mod render;
mod skills;
mod state;
mod validate;

use clap::{Parser, Subcommand};
use std::collections::HashMap;
use std::fmt::Write;
use std::io::BufRead;
use std::process;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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
    /// Manage coding agent tasks
    Tasks {
        #[command(subcommand)]
        cmd: TasksCmd,
    },
    /// Send a message to a workspace chat (defaults to the workspace's active chat panel)
    Chat {
        /// Workspace ID (auto-detected from cwd if omitted)
        workspace_id: Option<String>,
        /// Message text to send
        #[arg(long)]
        message: String,
        /// Target a specific chat pane instead of the workspace default
        #[arg(long)]
        chat_id: Option<String>,
        /// Maximum number of agentic turns
        #[arg(long)]
        max_turns: Option<u32>,
        /// Agent mode (e.g. 'plan', 'edit')
        #[arg(long)]
        mode: Option<String>,
        /// Model to use for the coding agent (e.g. 'claude-opus-4-20250514')
        #[arg(long)]
        model: Option<String>,
        /// Coding agent ID (e.g. 'claude-code')
        #[arg(long)]
        agent: Option<String>,
    },
    /// Manage chat panes (multi-agent)
    Chats {
        #[command(subcommand)]
        cmd: ChatsCmd,
    },
    /// Manage browser tabs
    Browser {
        #[command(subcommand)]
        cmd: BrowserCmd,
    },
    /// Manage terminal sessions
    Terminal {
        #[command(subcommand)]
        cmd: TerminalCmd,
    },
    /// Manage scheduled cronjobs
    Cronjobs {
        #[command(subcommand)]
        cmd: CronjobsCmd,
    },
    /// Show current settings
    Settings,
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
    /// Generate SKILL.md files from schema and registry
    GenerateSkills {
        /// Output directory for generated skills (default: skills/)
        #[arg(long, default_value = "skills")]
        output_dir: String,
        /// Filter skills by name (substring match)
        #[arg(long)]
        filter: Option<String>,
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
        /// Maximum number of agentic turns
        #[arg(long)]
        max_turns: Option<u32>,
        /// Agent mode (e.g. 'plan', 'edit')
        #[arg(long)]
        mode: Option<String>,
        /// Model to use for the coding agent (e.g. 'claude-opus-4-20250514')
        #[arg(long)]
        model: Option<String>,
        /// Coding agent ID to use (e.g. 'claude-code')
        #[arg(long)]
        agent: Option<String>,
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
    /// Stream task output in real-time
    Watch {
        /// Task ID (optional if --workspace is provided)
        id: Option<String>,
        /// Watch the latest task for this workspace
        #[arg(long)]
        workspace: Option<String>,
        /// Show full tool inputs and outputs
        #[arg(long, short = 'v')]
        verbose: bool,
        /// Tool call visibility: auto (default), off, full
        #[arg(long, default_value = "auto")]
        tools: String,
    },
}

#[derive(Subcommand)]
enum ChatsCmd {
    /// List chat panes for a workspace
    List {
        /// Workspace ID
        workspace_id: String,
    },
    /// Create a new chat pane
    Create {
        /// Workspace ID
        workspace_id: String,
        /// Display name for the chat pane
        #[arg(long)]
        name: Option<String>,
        /// Coding agent ID (e.g. 'claude-code')
        #[arg(long)]
        agent: Option<String>,
        /// Model override
        #[arg(long)]
        model: Option<String>,
        /// Mode (e.g. 'plan', 'edit')
        #[arg(long)]
        mode: Option<String>,
    },
    /// Send a message to a chat pane
    Send {
        /// Chat pane ID
        chat_id: String,
        /// Message text
        #[arg(long)]
        message: String,
    },
    /// Stop a running chat pane
    Stop {
        /// Chat pane ID
        chat_id: String,
    },
    /// Remove a chat pane
    Remove {
        /// Chat pane ID
        chat_id: String,
    },
}

#[derive(Subcommand)]
enum BrowserCmd {
    /// List browser tabs for a workspace
    List {
        /// Workspace ID
        workspace_id: String,
    },
    /// Create a new browser tab
    Create {
        /// Workspace ID
        workspace_id: String,
        /// Initial URL to navigate to
        #[arg(long)]
        url: Option<String>,
        /// Display name for the browser tab
        #[arg(long)]
        name: Option<String>,
    },
    /// Navigate a browser tab to a URL
    Navigate {
        /// Browser tab ID
        browser_id: String,
        /// URL to navigate to
        url: String,
    },
    /// Get a browser tab's current state
    Get {
        /// Browser tab ID
        browser_id: String,
    },
    /// Remove a browser tab
    Remove {
        /// Browser tab ID
        browser_id: String,
    },
}

#[derive(Subcommand)]
enum TerminalCmd {
    /// List terminal sessions for a workspace
    List {
        /// Workspace ID
        workspace_id: String,
    },
    /// Create a new terminal session
    Create {
        /// Workspace ID
        workspace_id: String,
        /// Shell command to auto-run after spawn
        #[arg(long)]
        command: Option<String>,
        /// Working directory (relative to workspace root)
        #[arg(long)]
        cwd: Option<String>,
    },
    /// Send input to a terminal session
    Send {
        /// Terminal ID
        terminal_id: String,
        /// Text to send (supports \\n for newline, \\t for tab)
        #[arg(long)]
        data: String,
    },
    /// Get terminal output (scrollback buffer)
    Output {
        /// Terminal ID
        terminal_id: String,
        /// Number of lines to show (from end of buffer)
        #[arg(long, short = 'n')]
        lines: Option<u32>,
        /// Stream live output
        #[arg(long, short = 'f')]
        follow: bool,
    },
    /// Kill a terminal session
    Kill {
        /// Terminal ID
        terminal_id: String,
    },
    /// Attach to a terminal (stream output + send input interactively)
    Attach {
        /// Terminal ID
        terminal_id: String,
    },
}

#[derive(Subcommand)]
enum CronjobsCmd {
    /// List cronjobs
    List {
        /// Filter by project name
        #[arg(long)]
        project: Option<String>,
        /// Filter by workspace ID
        #[arg(long)]
        workspace: Option<String>,
    },
    /// Create a new cronjob
    Create {
        /// Storage key: project name (for project-scoped) or workspace ID (for workspace-scoped)
        key: String,
        /// Human-readable name for the job
        #[arg(long)]
        name: String,
        /// Prompt text to send to the coding agent
        #[arg(long)]
        prompt: String,
        /// Cron expression (e.g. "0 */6 * * *")
        #[arg(long)]
        cron: String,
        /// Scope: project or workspace
        #[arg(long, default_value = "project")]
        scope: String,
        /// Workspace ID (required when scope is "workspace")
        #[arg(long)]
        workspace_id: Option<String>,
        /// Start disabled
        #[arg(long)]
        disabled: bool,
    },
    /// Update an existing cronjob
    Update {
        /// Storage key (project name or workspace ID)
        key: String,
        /// Cronjob ID (e.g. `cj_1234567890`)
        id: String,
        /// New name
        #[arg(long)]
        name: Option<String>,
        /// New prompt
        #[arg(long)]
        prompt: Option<String>,
        /// New cron expression
        #[arg(long)]
        cron: Option<String>,
        /// Enable the job
        #[arg(long, conflicts_with = "disable")]
        enable: bool,
        /// Disable the job
        #[arg(long, conflicts_with = "enable")]
        disable: bool,
    },
    /// Delete a cronjob
    Delete {
        /// Storage key (project name or workspace ID)
        key: String,
        /// Cronjob ID (e.g. `cj_1234567890`)
        id: String,
    },
    /// Manually trigger a cronjob now
    Trigger {
        /// Storage key (project name or workspace ID)
        key: String,
        /// Cronjob ID (e.g. `cj_1234567890`)
        id: String,
    },
}

#[derive(Subcommand)]
enum TunnelCmd {
    /// Show tunnel status
    Status,
    /// Start the remote tunnel
    Start,
    /// Stop the remote tunnel
    Stop,
}

// --- Output types ---

pub(crate) struct CommandResult {
    pub(crate) text: String,
    pub(crate) json: serde_json::Value,
}

#[allow(clippy::too_many_lines)]
fn main() {
    let cli = Cli::parse();
    let json_output = cli.output == "json";

    // Schema always outputs JSON, handle separately
    if let Commands::Schema { ref command } = cli.command {
        handle_schema(command.as_deref());
        return;
    }

    // Watch streams output directly, handle separately
    if let Commands::Tasks {
        cmd:
            TasksCmd::Watch {
                ref id,
                ref workspace,
                verbose,
                ref tools,
            },
    } = cli.command
    {
        let tool_display = match tools.as_str() {
            "off" => render::ToolDisplay::Off,
            "full" => render::ToolDisplay::Full,
            _ => render::ToolDisplay::Auto,
        };
        let config = render::RenderConfig::new(verbose, tool_display);
        let exit_code = handle_watch(id.as_deref(), workspace.as_deref(), json_output, config);
        process::exit(exit_code);
    }

    // terminal output --follow streams output directly
    if let Commands::Terminal {
        cmd:
            TerminalCmd::Output {
                ref terminal_id,
                lines,
                follow: true,
            },
    } = cli.command
    {
        let exit_code = handle_terminal_follow(terminal_id, lines, json_output);
        process::exit(exit_code);
    }

    // terminal attach is interactive streaming
    if let Commands::Terminal {
        cmd: TerminalCmd::Attach { ref terminal_id },
    } = cli.command
    {
        let exit_code = handle_terminal_attach(terminal_id, json_output);
        process::exit(exit_code);
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
                max_turns,
                mode,
                model,
                agent,
            } => cmd_workspaces_create(
                &project,
                &branch,
                base.as_deref(),
                prompt.as_deref(),
                max_turns,
                mode.as_deref(),
                model.as_deref(),
                agent.as_deref(),
            ),
            WorkspacesCmd::Remove { project, branch } => cmd_workspaces_remove(&project, &branch),
        },
        Commands::Tasks { cmd } => match cmd {
            TasksCmd::List { project, status } => {
                cmd_tasks_list(project.as_deref(), status.as_deref())
            }
            TasksCmd::Cancel { task_id } => cmd_tasks_cancel(&task_id),
            TasksCmd::Rerun { task_id } => cmd_tasks_rerun(&task_id),
            TasksCmd::Watch { .. } => unreachable!(),
        },
        Commands::Chat {
            workspace_id,
            message,
            chat_id,
            max_turns,
            mode,
            model,
            agent,
        } => cmd_chat(
            workspace_id.as_deref(),
            &message,
            chat_id.as_deref(),
            max_turns,
            mode.as_deref(),
            model.as_deref(),
            agent.as_deref(),
        ),
        Commands::Chats { cmd } => match cmd {
            ChatsCmd::List { workspace_id } => cmd_chats_list(&workspace_id),
            ChatsCmd::Create {
                workspace_id,
                name,
                agent,
                model,
                mode,
            } => cmd_chats_create(
                &workspace_id,
                name.as_deref(),
                agent.as_deref(),
                model.as_deref(),
                mode.as_deref(),
            ),
            ChatsCmd::Send { chat_id, message } => cmd_chats_send(&chat_id, &message),
            ChatsCmd::Stop { chat_id } => cmd_chats_stop(&chat_id),
            ChatsCmd::Remove { chat_id } => cmd_chats_remove(&chat_id),
        },
        Commands::Browser { cmd } => match cmd {
            BrowserCmd::List { workspace_id } => cmd_browser_list(&workspace_id),
            BrowserCmd::Create {
                workspace_id,
                url,
                name,
            } => cmd_browser_create(&workspace_id, url.as_deref(), name.as_deref()),
            BrowserCmd::Navigate { browser_id, url } => cmd_browser_navigate(&browser_id, &url),
            BrowserCmd::Get { browser_id } => cmd_browser_get(&browser_id),
            BrowserCmd::Remove { browser_id } => cmd_browser_remove(&browser_id),
        },
        Commands::Terminal { cmd } => match cmd {
            TerminalCmd::List { workspace_id } => cmd_terminal_list(&workspace_id),
            TerminalCmd::Create {
                workspace_id,
                command,
                cwd,
            } => cmd_terminal_create(&workspace_id, command.as_deref(), cwd.as_deref()),
            TerminalCmd::Send { terminal_id, data } => cmd_terminal_send(&terminal_id, &data),
            TerminalCmd::Output {
                terminal_id,
                lines,
                follow: false,
            } => cmd_terminal_output(&terminal_id, lines),
            TerminalCmd::Output { .. } | TerminalCmd::Attach { .. } => unreachable!(),
            TerminalCmd::Kill { terminal_id } => cmd_terminal_kill(&terminal_id),
        },
        Commands::Cronjobs { cmd } => match cmd {
            CronjobsCmd::List { project, workspace } => {
                cmd_cronjobs_list(project.as_deref(), workspace.as_deref())
            }
            CronjobsCmd::Create {
                key,
                name,
                prompt,
                cron,
                scope,
                workspace_id,
                disabled,
            } => cmd_cronjobs_create(
                &key,
                &name,
                &prompt,
                &cron,
                &scope,
                workspace_id.as_deref(),
                disabled,
            ),
            CronjobsCmd::Update {
                key,
                id,
                name,
                prompt,
                cron,
                enable,
                disable,
            } => cmd_cronjobs_update(
                &key,
                &id,
                name.as_deref(),
                prompt.as_deref(),
                cron.as_deref(),
                enable,
                disable,
            ),
            CronjobsCmd::Delete { key, id } => cmd_cronjobs_delete(&key, &id),
            CronjobsCmd::Trigger { key, id } => cmd_cronjobs_trigger(&key, &id),
        },
        Commands::Settings => cmd_settings(json_output),
        Commands::Tunnel { cmd } => match cmd {
            TunnelCmd::Status => cmd_tunnel_status(),
            TunnelCmd::Start => cmd_tunnel_start(),
            TunnelCmd::Stop => cmd_tunnel_stop(),
        },
        Commands::Notify => cmd_notify(),
        Commands::Schema { .. } => unreachable!(),
        Commands::GenerateSkills { output_dir, filter } => {
            skills::generate_skills(&output_dir, filter.as_deref())
        }
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
    let mut rows: Vec<[String; 4]> = Vec::new();
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
            let workspace_id = wt.get("workspaceId").and_then(|w| w.as_str()).unwrap_or("");
            rows.push([
                name.to_string(),
                branch.to_string(),
                workspace_id.to_string(),
                path.to_string(),
            ]);
            workspaces.push(serde_json::json!({
                "project": name,
                "branch": branch,
                "workspaceId": workspace_id,
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

    let text = format_table(&["PROJECT", "BRANCH", "WORKSPACE ID", "PATH"], &rows);

    Ok(CommandResult {
        text,
        json: serde_json::json!({"workspaces": workspaces}),
    })
}

#[allow(clippy::too_many_arguments)]
fn cmd_workspaces_create(
    project: &str,
    branch: &str,
    base: Option<&str>,
    prompt: Option<&str>,
    max_turns: Option<u32>,
    mode: Option<&str>,
    model: Option<&str>,
    agent: Option<&str>,
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
    if let Some(max_turns) = max_turns {
        input["maxTurns"] = serde_json::json!(max_turns);
    }
    if let Some(mode) = mode {
        input["mode"] = serde_json::json!(mode);
    }
    if let Some(model) = model {
        input["model"] = serde_json::json!(model);
    }
    if let Some(agent) = agent {
        input["codingAgentId"] = serde_json::json!(agent);
    }
    let data = client.trpc_mutate("workspaces.create", &input)?;
    let path = data.get("path").and_then(|p| p.as_str()).unwrap_or("");

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

fn cmd_tasks_list(project: Option<&str>, status: Option<&str>) -> Result<CommandResult, String> {
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

// --- Chats commands ---

fn cmd_chats_list(workspace_id: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_query(
        "chats.list",
        &serde_json::json!({"workspaceId": workspace_id}),
    )?;

    let chats = data
        .get("chats")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();

    let mut rows: Vec<[String; 4]> = Vec::new();
    let mut json_chats = Vec::new();
    for chat in &chats {
        let id = chat.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let name = chat.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let agent = chat.get("agent").and_then(|v| v.as_str()).unwrap_or("");
        let status = chat.get("status").and_then(|v| v.as_str()).unwrap_or("");
        rows.push([
            id.to_string(),
            name.to_string(),
            agent.to_string(),
            status.to_string(),
        ]);
        json_chats.push(chat.clone());
    }

    let text = format_table(&["ID", "NAME", "AGENT", "STATUS"], &rows);

    Ok(CommandResult {
        text,
        json: serde_json::json!({"chats": json_chats}),
    })
}

fn cmd_chats_create(
    workspace_id: &str,
    name: Option<&str>,
    agent: Option<&str>,
    model: Option<&str>,
    mode: Option<&str>,
) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let mut input = serde_json::json!({"workspaceId": workspace_id});
    if let Some(n) = name {
        input["name"] = serde_json::json!(n);
    }
    if let Some(a) = agent {
        input["agent"] = serde_json::json!(a);
    }
    if let Some(m) = model {
        input["model"] = serde_json::json!(m);
    }
    if let Some(m) = mode {
        input["mode"] = serde_json::json!(m);
    }
    let data = client.trpc_mutate("chats.create", &input)?;
    let chat = data.get("chat").cloned().unwrap_or(serde_json::Value::Null);
    let id = chat.get("id").and_then(|v| v.as_str()).unwrap_or("");

    Ok(CommandResult {
        text: format!("{id}\n"),
        json: serde_json::json!({"chat": chat}),
    })
}

fn cmd_chats_send(chat_id: &str, message: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_mutate(
        "chats.send",
        &serde_json::json!({"chatId": chat_id, "message": message}),
    )?;

    let task_id = data.get("id").and_then(|v| v.as_str()).unwrap_or("");

    Ok(CommandResult {
        text: format!("{task_id}\n"),
        json: data,
    })
}

fn cmd_chats_stop(chat_id: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    client.trpc_mutate("chats.stop", &serde_json::json!({"chatId": chat_id}))?;

    Ok(CommandResult {
        text: format!("Chat {chat_id} stopped\n"),
        json: serde_json::json!({"ok": true, "chatId": chat_id}),
    })
}

fn cmd_chats_remove(chat_id: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    client.trpc_mutate("chats.remove", &serde_json::json!({"chatId": chat_id}))?;

    Ok(CommandResult {
        text: format!("Chat {chat_id} removed\n"),
        json: serde_json::json!({"ok": true, "chatId": chat_id}),
    })
}

/// Send a message to a workspace chat, defaulting to the workspace's active
/// chat panel when no `--chat-id` is provided. Returns the task id.
///
/// Server-side, `tasks.submit` resolves the default chat via
/// `getOrCreateDefaultChat`, which honors the saved chat layout's active
/// panel. So passing no `chatId` here matches the chat the user is looking
/// at in the dashboard.
fn cmd_chat(
    workspace_id: Option<&str>,
    message: &str,
    chat_id: Option<&str>,
    max_turns: Option<u32>,
    mode: Option<&str>,
    model: Option<&str>,
    agent: Option<&str>,
) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let workspace_id = resolve_workspace_id(&client, None, workspace_id)?;

    let mut input = serde_json::json!({
        "workspaceId": workspace_id,
        "prompt": message,
    });
    if let Some(chat_id) = chat_id {
        input["chatId"] = serde_json::json!(chat_id);
    }
    if let Some(max_turns) = max_turns {
        input["maxTurns"] = serde_json::json!(max_turns);
    }
    if let Some(mode) = mode {
        input["mode"] = serde_json::json!(mode);
    }
    if let Some(model) = model {
        input["model"] = serde_json::json!(model);
    }
    if let Some(agent) = agent {
        input["codingAgentId"] = serde_json::json!(agent);
    }

    let data = client.trpc_mutate("tasks.submit", &input)?;

    let id = data.get("id").and_then(|i| i.as_str()).unwrap_or("");
    let ws = data
        .get("workspaceId")
        .and_then(|w| w.as_str())
        .unwrap_or("");
    let resolved_chat_id = data.get("chatId").and_then(|c| c.as_str()).unwrap_or("");

    Ok(CommandResult {
        text: format!("{id}\n"),
        json: serde_json::json!({
            "id": id,
            "workspaceId": ws,
            "chatId": resolved_chat_id,
        }),
    })
}

// --- Browser commands ---

fn cmd_browser_list(workspace_id: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_query(
        "browsers.list",
        &serde_json::json!({"workspaceId": workspace_id}),
    )?;

    let browsers = data
        .get("browsers")
        .and_then(|b| b.as_array())
        .cloned()
        .unwrap_or_default();

    let mut rows: Vec<[String; 4]> = Vec::new();
    let mut json_browsers = Vec::new();
    for browser in &browsers {
        let id = browser.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let name = browser.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let url = browser.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let status = browser.get("status").and_then(|v| v.as_str()).unwrap_or("");
        rows.push([
            id.to_string(),
            name.to_string(),
            url.to_string(),
            status.to_string(),
        ]);
        json_browsers.push(browser.clone());
    }

    let text = format_table(&["ID", "NAME", "URL", "STATUS"], &rows);

    Ok(CommandResult {
        text,
        json: serde_json::json!({"browsers": json_browsers}),
    })
}

fn cmd_browser_create(
    workspace_id: &str,
    url: Option<&str>,
    name: Option<&str>,
) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let mut input = serde_json::json!({"workspaceId": workspace_id});
    if let Some(u) = url {
        input["url"] = serde_json::json!(u);
    }
    if let Some(n) = name {
        input["name"] = serde_json::json!(n);
    }
    let data = client.trpc_mutate("browsers.create", &input)?;
    let browser = data
        .get("browser")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let id = browser.get("id").and_then(|v| v.as_str()).unwrap_or("");

    Ok(CommandResult {
        text: format!("{id}\n"),
        json: serde_json::json!({"browser": browser}),
    })
}

fn cmd_browser_navigate(browser_id: &str, url: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    client.trpc_mutate(
        "browsers.navigate",
        &serde_json::json!({"browserId": browser_id, "url": url}),
    )?;

    Ok(CommandResult {
        text: format!("Navigated {browser_id} to {url}\n"),
        json: serde_json::json!({"ok": true, "browserId": browser_id, "url": url}),
    })
}

fn cmd_browser_get(browser_id: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_query(
        "browsers.get",
        &serde_json::json!({"browserId": browser_id}),
    )?;

    let browser = data
        .get("browser")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let id = browser.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let name = browser.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let url = browser.get("url").and_then(|v| v.as_str()).unwrap_or("");
    let status = browser.get("status").and_then(|v| v.as_str()).unwrap_or("");

    let text = format!("ID:     {id}\nName:   {name}\nURL:    {url}\nStatus: {status}\n");

    Ok(CommandResult {
        text,
        json: serde_json::json!({"browser": browser}),
    })
}

fn cmd_browser_remove(browser_id: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    client.trpc_mutate(
        "browsers.remove",
        &serde_json::json!({"browserId": browser_id}),
    )?;

    Ok(CommandResult {
        text: format!("Browser {browser_id} removed\n"),
        json: serde_json::json!({"ok": true, "browserId": browser_id}),
    })
}

// --- Terminal commands ---

fn cmd_terminal_list(workspace_id: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_query(
        "terminal.list",
        &serde_json::json!({"workspaceId": workspace_id}),
    )?;

    let terminals = data
        .get("terminals")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();

    let mut rows: Vec<[String; 4]> = Vec::new();
    let mut json_terminals = Vec::new();
    for term in &terminals {
        let id = term
            .get("terminalId")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let title = term.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let pid = term
            .get("pid")
            .and_then(serde_json::Value::as_u64)
            .map(|v| v.to_string())
            .unwrap_or_default();
        let scrollback = term
            .get("scrollbackLength")
            .and_then(serde_json::Value::as_u64)
            .map(|v| v.to_string())
            .unwrap_or_default();
        rows.push([id.to_string(), title.to_string(), pid, scrollback]);
        json_terminals.push(term.clone());
    }

    let text = format_table(&["TERMINAL ID", "TITLE", "PID", "SCROLLBACK"], &rows);

    Ok(CommandResult {
        text,
        json: serde_json::json!({"terminals": json_terminals}),
    })
}

fn cmd_terminal_create(
    workspace_id: &str,
    command: Option<&str>,
    cwd: Option<&str>,
) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let mut input = serde_json::json!({"workspaceId": workspace_id});
    if let Some(cmd) = command {
        input["command"] = serde_json::json!(cmd);
    }
    if let Some(c) = cwd {
        input["cwd"] = serde_json::json!(c);
    }
    let data = client.trpc_mutate("terminal.create", &input)?;
    let terminal_id = data
        .get("terminalId")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    Ok(CommandResult {
        text: format!("{terminal_id}\n"),
        json: data,
    })
}

fn cmd_terminal_send(terminal_id: &str, data: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    // Unescape common escape sequences
    let unescaped = data.replace("\\n", "\n").replace("\\t", "\t");
    client.trpc_mutate(
        "terminal.send",
        &serde_json::json!({"terminalId": terminal_id, "data": unescaped}),
    )?;

    Ok(CommandResult {
        text: format!("Sent to terminal {terminal_id}\n"),
        json: serde_json::json!({"ok": true, "terminalId": terminal_id}),
    })
}

fn cmd_terminal_output(terminal_id: &str, lines: Option<u32>) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let mut input = serde_json::json!({"terminalId": terminal_id});
    if let Some(n) = lines {
        input["lines"] = serde_json::json!(n);
    }
    let data = client.trpc_query("terminal.output", &input)?;
    let output = data.get("output").and_then(|v| v.as_str()).unwrap_or("");

    Ok(CommandResult {
        text: output.to_string(),
        json: data,
    })
}

fn cmd_terminal_kill(terminal_id: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    client.trpc_mutate(
        "terminal.kill",
        &serde_json::json!({"terminalId": terminal_id}),
    )?;

    Ok(CommandResult {
        text: format!("Terminal {terminal_id} killed\n"),
        json: serde_json::json!({"ok": true, "terminalId": terminal_id}),
    })
}

fn handle_terminal_follow(terminal_id: &str, lines: Option<u32>, json_output: bool) -> i32 {
    match cmd_terminal_follow(terminal_id, lines, json_output) {
        Ok(()) => 0,
        Err(e) => {
            if json_output {
                eprintln!("{}", serde_json::json!({"error": e}));
            } else {
                eprintln!("error: {e}");
            }
            1
        }
    }
}

fn cmd_terminal_follow(
    terminal_id: &str,
    lines: Option<u32>,
    json_output: bool,
) -> Result<(), String> {
    use std::io::Write;

    let client = api::ApiClient::from_settings()?;

    // If --lines was provided without --follow, that's handled elsewhere.
    // Here we stream live output, optionally replaying scrollback first.
    let mut input = serde_json::json!({"terminalId": terminal_id, "replay": true});
    if let Some(n) = lines {
        // When --lines is combined with --follow, first fetch the last N lines,
        // then switch to streaming without replay to avoid duplicates.
        let snap = client.trpc_query(
            "terminal.output",
            &serde_json::json!({"terminalId": terminal_id, "lines": n}),
        )?;
        let output = snap.get("output").and_then(|v| v.as_str()).unwrap_or("");
        if !output.is_empty() {
            print!("{output}");
            let _ = std::io::stdout().flush();
        }
        input["replay"] = serde_json::json!(false);
    }

    let mut response = client.trpc_subscribe("terminal.stream", &input)?;
    let status = response.status().as_u16();

    if status == 401 {
        return Err("Authentication failed. Check tokenSecret in settings".to_string());
    }
    if status >= 400 {
        let body: serde_json::Value = response
            .body_mut()
            .read_json()
            .unwrap_or(serde_json::Value::Null);
        let msg = body
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("Unknown server error");
        return Err(msg.to_string());
    }

    let mut body = response.into_body();
    let reader = std::io::BufReader::new(body.as_reader());
    stream_terminal_sse(reader, json_output)
}

fn stream_terminal_sse(reader: impl BufRead, json_output: bool) -> Result<(), String> {
    use std::io::Write;

    let mut line_buf = String::new();
    let mut data_buf = String::new();
    let mut reader = reader;

    loop {
        line_buf.clear();
        match reader.read_line(&mut line_buf) {
            Ok(0) => break, // EOF
            Ok(_) => {}
            Err(e) => return Err(format!("Connection error: {e}")),
        }

        let line = line_buf.trim_end();

        if line.is_empty() {
            if !data_buf.is_empty() {
                let chunk: serde_json::Value = serde_json::from_str(&data_buf)
                    .map_err(|e| format!("Invalid JSON in SSE: {e}"))?;
                data_buf.clear();

                let chunk_type = chunk.get("type").and_then(|t| t.as_str()).unwrap_or("");

                if json_output {
                    println!("{}", serde_json::to_string(&chunk).unwrap_or_default());
                } else if chunk_type == "output" {
                    if let Some(output) = chunk.get("data").and_then(|d| d.as_str()) {
                        print!("{output}");
                        let _ = std::io::stdout().flush();
                    }
                } else if chunk_type == "error" {
                    if let Some(msg) = chunk.get("data").and_then(|d| d.as_str()) {
                        eprintln!("error: {msg}");
                    }
                }

                if chunk_type == "exit" || chunk_type == "error" {
                    return Ok(());
                }
            }
            continue;
        }

        if let Some(data) = line.strip_prefix("data: ") {
            if !data_buf.is_empty() {
                data_buf.push('\n');
            }
            data_buf.push_str(data);
        }
        // Ignore id:, event:, and comment lines
    }

    Ok(())
}

fn handle_terminal_attach(terminal_id: &str, json_output: bool) -> i32 {
    match cmd_terminal_attach(terminal_id, json_output) {
        Ok(()) => 0,
        Err(e) => {
            if json_output {
                eprintln!("{}", serde_json::json!({"error": e}));
            } else {
                eprintln!("error: {e}");
            }
            1
        }
    }
}

/// Background thread: stream SSE output from the terminal and print to stdout.
fn stream_terminal_output(tid: &str, done: &AtomicBool) {
    use std::io::Write;

    let bg_client = match api::ApiClient::from_settings() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("error: {e}");
            return;
        }
    };
    let input = serde_json::json!({"terminalId": tid, "replay": true});
    let response = match bg_client.trpc_subscribe("terminal.stream", &input) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error: {e}");
            return;
        }
    };
    if response.status().as_u16() >= 400 {
        eprintln!("error: server returned HTTP {}", response.status().as_u16());
        return;
    }
    let mut body = response.into_body();
    let mut reader = std::io::BufReader::new(body.as_reader());
    let mut line_buf = String::new();
    let mut data_buf = String::new();

    loop {
        if done.load(Ordering::Relaxed) {
            break;
        }
        line_buf.clear();
        match reader.read_line(&mut line_buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = line_buf.trim_end();
        if line.is_empty() {
            if !data_buf.is_empty() {
                if let Ok(chunk) = serde_json::from_str::<serde_json::Value>(&data_buf) {
                    let chunk_type = chunk.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    if chunk_type == "output" {
                        if let Some(output) = chunk.get("data").and_then(|d| d.as_str()) {
                            print!("{output}");
                            let _ = std::io::stdout().flush();
                        }
                    } else if chunk_type == "exit" {
                        if !done.load(Ordering::Relaxed) {
                            eprintln!("\n[terminal exited]");
                        }
                        done.store(true, Ordering::Relaxed);
                        break;
                    }
                }
                data_buf.clear();
            }
            continue;
        }
        if let Some(data) = line.strip_prefix("data: ") {
            if !data_buf.is_empty() {
                data_buf.push('\n');
            }
            data_buf.push_str(data);
        }
    }
}

fn cmd_terminal_attach(terminal_id: &str, json_output: bool) -> Result<(), String> {
    let client = api::ApiClient::from_settings()?;

    if !json_output {
        eprintln!("[attached to terminal {terminal_id} — type input, press Ctrl+C to detach]");
    }

    let tid = terminal_id.to_string();
    let done = Arc::new(AtomicBool::new(false));
    let done_clone = done.clone();

    let output_handle = std::thread::spawn(move || {
        stream_terminal_output(&tid, &done_clone);
    });

    // Main thread: read stdin line-by-line and send to terminal
    let stdin = std::io::stdin();
    loop {
        if done.load(Ordering::Relaxed) {
            break;
        }
        let mut line = String::new();
        match stdin.read_line(&mut line) {
            Ok(0) => break, // EOF
            Ok(_) => {
                if done.load(Ordering::Relaxed) {
                    break;
                }
                if let Err(e) = client.trpc_mutate(
                    "terminal.send",
                    &serde_json::json!({"terminalId": terminal_id, "data": line}),
                ) {
                    eprintln!("error sending input: {e}");
                    break;
                }
            }
            Err(e) => {
                eprintln!("stdin error: {e}");
                break;
            }
        }
    }

    done.store(true, Ordering::Relaxed);
    let _ = output_handle.join();

    Ok(())
}

// --- Cronjobs commands ---

fn cmd_cronjobs_list(
    project: Option<&str>,
    workspace: Option<&str>,
) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;

    let mut input = serde_json::json!({});
    if let Some(p) = project {
        input["project"] = serde_json::json!(p);
    }
    if let Some(w) = workspace {
        input["workspaceId"] = serde_json::json!(w);
    }

    let data = client.trpc_query("cronjobs.list", &input)?;
    let jobs = data
        .get("jobs")
        .and_then(|j| j.as_array())
        .cloned()
        .unwrap_or_default();

    let mut rows: Vec<[String; 6]> = Vec::new();
    let mut json_jobs = Vec::new();
    for job in &jobs {
        let id = job.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let name = job.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let cron_expr = job
            .get("cronExpression")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let scope = job.get("scope").and_then(|v| v.as_str()).unwrap_or("");
        let enabled = job
            .get("enabled")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let last_status = job
            .get("lastRunStatus")
            .and_then(|v| v.as_str())
            .unwrap_or("-");

        rows.push([
            id.to_string(),
            name.to_string(),
            cron_expr.to_string(),
            scope.to_string(),
            if enabled {
                "enabled".to_string()
            } else {
                "disabled".to_string()
            },
            last_status.to_string(),
        ]);

        json_jobs.push(job.clone());
    }

    let text = format_table(&["ID", "NAME", "CRON", "SCOPE", "STATE", "LAST RUN"], &rows);

    Ok(CommandResult {
        text,
        json: serde_json::json!({"jobs": json_jobs}),
    })
}

#[allow(clippy::too_many_arguments)]
fn cmd_cronjobs_create(
    key: &str,
    name: &str,
    prompt: &str,
    cron: &str,
    scope: &str,
    workspace_id: Option<&str>,
    disabled: bool,
) -> Result<CommandResult, String> {
    if scope != "project" && scope != "workspace" {
        return Err("Scope must be 'project' or 'workspace'".to_string());
    }
    if scope == "workspace" && workspace_id.is_none() {
        return Err("--workspace-id is required when scope is 'workspace'".to_string());
    }

    let client = api::ApiClient::from_settings()?;
    let mut input = serde_json::json!({
        "key": key,
        "name": name,
        "prompt": prompt,
        "cronExpression": cron,
        "scope": scope,
        "enabled": !disabled,
    });
    if let Some(ws) = workspace_id {
        input["workspaceId"] = serde_json::json!(ws);
    }

    let data = client.trpc_mutate("cronjobs.create", &input)?;
    let job = data.get("job").cloned().unwrap_or(serde_json::Value::Null);
    let id = job.get("id").and_then(|v| v.as_str()).unwrap_or("");

    Ok(CommandResult {
        text: format!("{id}\n"),
        json: serde_json::json!({"job": job}),
    })
}

fn cmd_cronjobs_update(
    key: &str,
    id: &str,
    name: Option<&str>,
    prompt: Option<&str>,
    cron: Option<&str>,
    enable: bool,
    disable: bool,
) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let mut input = serde_json::json!({
        "key": key,
        "id": id,
    });
    if let Some(n) = name {
        input["name"] = serde_json::json!(n);
    }
    if let Some(p) = prompt {
        input["prompt"] = serde_json::json!(p);
    }
    if let Some(c) = cron {
        input["cronExpression"] = serde_json::json!(c);
    }
    if enable {
        input["enabled"] = serde_json::json!(true);
    }
    if disable {
        input["enabled"] = serde_json::json!(false);
    }

    let data = client.trpc_mutate("cronjobs.update", &input)?;
    let job = data.get("job").cloned().unwrap_or(serde_json::Value::Null);

    Ok(CommandResult {
        text: format!("Cronjob {id} updated\n"),
        json: serde_json::json!({"job": job}),
    })
}

fn cmd_cronjobs_delete(key: &str, id: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    client.trpc_mutate(
        "cronjobs.delete",
        &serde_json::json!({"key": key, "id": id}),
    )?;

    Ok(CommandResult {
        text: format!("Cronjob {id} deleted\n"),
        json: serde_json::json!({"ok": true}),
    })
}

fn cmd_cronjobs_trigger(key: &str, id: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_mutate(
        "cronjobs.trigger",
        &serde_json::json!({"key": key, "id": id}),
    )?;

    let task_id = data.get("taskId").and_then(|v| v.as_str()).unwrap_or("");
    let workspace_id = data
        .get("workspaceId")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    Ok(CommandResult {
        text: format!("{task_id}\n"),
        json: serde_json::json!({"taskId": task_id, "workspaceId": workspace_id}),
    })
}

fn handle_watch(
    id: Option<&str>,
    workspace: Option<&str>,
    json_output: bool,
    config: render::RenderConfig,
) -> i32 {
    match cmd_tasks_watch(id, workspace, json_output, config) {
        Ok(success) => i32::from(!success),
        Err(e) => {
            if json_output {
                eprintln!("{}", serde_json::json!({"error": e}));
            } else {
                eprintln!("error: {e}");
            }
            1
        }
    }
}

fn cmd_tasks_watch(
    id: Option<&str>,
    workspace: Option<&str>,
    json_output: bool,
    config: render::RenderConfig,
) -> Result<bool, String> {
    let client = api::ApiClient::from_settings()?;
    let workspace_id = resolve_workspace_id(&client, id, workspace)?;

    if !json_output {
        let label = id.unwrap_or(&workspace_id);
        eprintln!("[watching task {label} on {workspace_id}]");
        eprintln!();
    }

    let mut response = client.trpc_subscribe(
        "tasks.stream",
        &serde_json::json!({"workspaceId": workspace_id}),
    )?;
    let status = response.status().as_u16();

    if status == 401 {
        return Err("Authentication failed. Check tokenSecret in settings".to_string());
    }
    if status >= 400 {
        let body: serde_json::Value = response
            .body_mut()
            .read_json()
            .unwrap_or(serde_json::Value::Null);
        let msg = body
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("Unknown server error");
        return Err(msg.to_string());
    }

    let mut body = response.into_body();
    let reader = std::io::BufReader::new(body.as_reader());
    stream_sse_events(reader, json_output, config, &client)
}

fn stream_sse_events(
    reader: impl BufRead,
    json_output: bool,
    config: render::RenderConfig,
    client: &api::ApiClient,
) -> Result<bool, String> {
    let mut line_buf = String::new();
    let mut data_buf = String::new();
    let mut renderer = render::Renderer::new(config);
    let mut reader = reader;

    loop {
        line_buf.clear();
        match reader.read_line(&mut line_buf) {
            Ok(0) => break, // EOF
            Ok(_) => {}
            Err(e) => return Err(format!("Connection error: {e}")),
        }

        let line = line_buf.trim_end();

        if line.is_empty() {
            if !data_buf.is_empty() {
                let action = process_sse_data(&data_buf, json_output, &mut renderer)?;
                data_buf.clear();
                match action {
                    render::RenderAction::Finish => return Ok(renderer.task_succeeded),
                    render::RenderAction::NeedsInput(req) => {
                        handle_interactive_input(&req, client)?;
                    }
                    render::RenderAction::Continue => {}
                }
            }
            continue;
        }

        if let Some(data) = line.strip_prefix("data: ") {
            if !data_buf.is_empty() {
                data_buf.push('\n');
            }
            data_buf.push_str(data);
        }
        // Ignore id:, event:, and comment lines
    }

    Ok(renderer.task_succeeded)
}

fn process_sse_data(
    data: &str,
    json_output: bool,
    renderer: &mut render::Renderer,
) -> Result<render::RenderAction, String> {
    let chunk: serde_json::Value =
        serde_json::from_str(data).map_err(|e| format!("Invalid JSON in SSE: {e}"))?;

    if json_output {
        let chunk_type = chunk.get("type").and_then(|t| t.as_str()).unwrap_or("");
        println!("{}", serde_json::to_string(&chunk).unwrap_or_default());
        if chunk_type == "finish" {
            Ok(render::RenderAction::Finish)
        } else {
            Ok(render::RenderAction::Continue)
        }
    } else {
        Ok(renderer.render_chunk(&chunk))
    }
}

// ── Interactive input handling ──────────────────────────────────────

fn handle_interactive_input(
    req: &render::InteractiveRequest,
    client: &api::ApiClient,
) -> Result<(), String> {
    use std::io::IsTerminal;

    let is_tty = std::io::stdin().is_terminal();

    let answers = match &req.kind {
        render::InteractiveKind::PlanApproval => prompt_plan_approval(is_tty)?,
        render::InteractiveKind::AskUserQuestion { questions } => {
            prompt_questions(questions, is_tty)?
        }
    };

    client.trpc_mutate(
        "chat.answer",
        &serde_json::json!({
            "approvalId": req.approval_id,
            "answers": answers,
        }),
    )?;

    Ok(())
}

fn prompt_plan_approval(is_tty: bool) -> Result<HashMap<String, String>, String> {
    use std::io::Write as _;

    if !is_tty {
        eprintln!("  (non-interactive: auto-approving plan)");
        let mut answers = HashMap::new();
        answers.insert("plan".to_string(), "approved".to_string());
        return Ok(answers);
    }

    for attempt in 0..3 {
        eprint!("  Approve plan? [y/n]: ");
        std::io::stderr().flush().ok();

        let mut input = String::new();
        std::io::stdin()
            .read_line(&mut input)
            .map_err(|e| format!("Failed to read input: {e}"))?;

        let trimmed = input.trim().to_lowercase();
        match trimmed.as_str() {
            "y" | "yes" => {
                eprintln!("  Plan approved — agent continuing");
                let mut answers = HashMap::new();
                answers.insert("plan".to_string(), "approved".to_string());
                return Ok(answers);
            }
            "n" | "no" => {
                eprintln!("  Plan rejected");
                let mut answers = HashMap::new();
                answers.insert("plan".to_string(), "rejected".to_string());
                return Ok(answers);
            }
            _ => {
                if attempt < 2 {
                    eprintln!("  Please enter y or n.");
                }
            }
        }
    }

    // After 3 invalid attempts, default to approved.
    eprintln!("  (defaulting to approved)");
    let mut answers = HashMap::new();
    answers.insert("plan".to_string(), "approved".to_string());
    Ok(answers)
}

fn prompt_questions(
    questions: &[render::QuestionData],
    is_tty: bool,
) -> Result<HashMap<String, String>, String> {
    let mut answers = HashMap::new();

    for q in questions {
        if q.options.is_empty() {
            continue;
        }

        if !is_tty {
            let first_label = &q.options[0].label;
            eprintln!("  (non-interactive: selecting \"{first_label}\")");
            answers.insert(q.question.clone(), first_label.clone());
            continue;
        }

        let selected = if q.multi_select {
            prompt_multi_select(q)?
        } else {
            prompt_single_select(q)?
        };

        if !selected.is_empty() {
            answers.insert(q.question.clone(), selected);
        }
    }

    Ok(answers)
}

fn prompt_single_select(q: &render::QuestionData) -> Result<String, String> {
    use std::io::Write as _;

    let num_options = q.options.len();

    for attempt in 0..3 {
        eprint!("  Select option [1-{num_options}]: ");
        std::io::stderr().flush().ok();

        let mut input = String::new();
        std::io::stdin()
            .read_line(&mut input)
            .map_err(|e| format!("Failed to read input: {e}"))?;

        if let Some(label) = parse_single_selection(input.trim(), &q.options) {
            eprintln!("  Selected: {label}");
            return Ok(label);
        }

        if attempt < 2 {
            eprintln!("  Invalid selection. Enter a number from 1 to {num_options}.");
        }
    }

    // Default to first option after 3 failed attempts.
    let label = q.options[0].label.clone();
    eprintln!("  (defaulting to \"{label}\")");
    Ok(label)
}

fn prompt_multi_select(q: &render::QuestionData) -> Result<String, String> {
    use std::io::Write as _;

    let num_options = q.options.len();

    for attempt in 0..3 {
        eprint!("  Select options (comma-separated, e.g. 1,3) [1-{num_options}]: ");
        std::io::stderr().flush().ok();

        let mut input = String::new();
        std::io::stdin()
            .read_line(&mut input)
            .map_err(|e| format!("Failed to read input: {e}"))?;

        let labels = parse_multi_selection(input.trim(), &q.options);
        if !labels.is_empty() {
            eprintln!("  Selected: {labels}");
            return Ok(labels);
        }

        if attempt < 2 {
            eprintln!(
                "  Invalid selection. Enter numbers from 1 to {num_options}, separated by commas."
            );
        }
    }

    // Default to first option after 3 failed attempts.
    let label = q.options[0].label.clone();
    eprintln!("  (defaulting to \"{label}\")");
    Ok(label)
}

fn parse_single_selection(input: &str, options: &[render::OptionData]) -> Option<String> {
    let num: usize = input.parse().ok()?;
    if num >= 1 && num <= options.len() {
        Some(options[num - 1].label.clone())
    } else {
        None
    }
}

fn parse_multi_selection(input: &str, options: &[render::OptionData]) -> String {
    let labels: Vec<&str> = input
        .split(',')
        .filter_map(|s| {
            let num: usize = s.trim().parse().ok()?;
            if num >= 1 && num <= options.len() {
                Some(options[num - 1].label.as_str())
            } else {
                None
            }
        })
        .collect();
    labels.join(", ")
}

/// Resolve a task ID (tsk_*) or workspace ID to a workspace ID.
/// When neither `id` nor `workspace` is given, auto-detects from the current
/// working directory by matching the git toplevel against registered workspace paths.
fn resolve_workspace_id(
    client: &api::ApiClient,
    id: Option<&str>,
    workspace: Option<&str>,
) -> Result<String, String> {
    if let Some(ws) = workspace {
        return Ok(ws.to_string());
    }

    if let Some(id) = id {
        if id.starts_with("tsk_") {
            let data = client.trpc_query("tasks.list", &serde_json::json!({}))?;
            let tasks = data
                .get("tasks")
                .and_then(|t| t.as_array())
                .ok_or("Failed to list tasks")?;
            let task = tasks
                .iter()
                .find(|t| t.get("id").and_then(|i| i.as_str()) == Some(id))
                .ok_or(format!("Task '{id}' not found"))?;
            let workspace_id = task
                .get("workspaceId")
                .and_then(|w| w.as_str())
                .ok_or("Task has no workspace ID")?;
            return Ok(workspace_id.to_string());
        }
        return Ok(id.to_string());
    }

    // Auto-detect: match current git toplevel against registered workspace paths.
    detect_workspace_from_cwd(client)
}

/// Detect the current workspace by matching `git rev-parse --show-toplevel`
/// against the `path` field of all registered workspaces.
fn detect_workspace_from_cwd(client: &api::ApiClient) -> Result<String, String> {
    let git_output = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;

    if !git_output.status.success() {
        return Err("Not in a git repository. Specify a task ID or --workspace.".to_string());
    }

    let toplevel = String::from_utf8_lossy(&git_output.stdout)
        .trim()
        .to_string();

    let data = client.trpc_query_no_input("projects.list")?;
    let projects = data
        .get("projects")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();

    for proj in &projects {
        let worktrees = proj
            .get("worktrees")
            .and_then(|w| w.as_array())
            .cloned()
            .unwrap_or_default();
        for wt in &worktrees {
            let path = wt.get("path").and_then(|p| p.as_str()).unwrap_or("");
            if path == toplevel {
                let ws_id = wt.get("workspaceId").and_then(|w| w.as_str()).unwrap_or("");
                if !ws_id.is_empty() {
                    return Ok(ws_id.to_string());
                }
            }
        }
    }

    Err(format!(
        "No workspace found for '{toplevel}'. Specify a task ID or --workspace."
    ))
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

fn cmd_tunnel_start() -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_mutate("tunnel.start", &serde_json::json!({}))?;

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

    let tool_name = payload
        .get("tool_name")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let agent_status = match hook_event {
        "Stop" => "needs_attention",
        "PreToolUse" if tool_name == "AskUserQuestion" || tool_name == "ExitPlanMode" => {
            "needs_attention"
        }
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
pub(crate) fn build_schema(command: Option<&str>) -> Result<serde_json::Value, String> {
    let commands = vec![
        serde_json::json!({
            "name": "projects list",
            "description": "List registered projects",
            "parameters": [],
            "notes": "Text output: `name\\tpath\\tN worktree(s)` (tab-separated).\nJSON output: `{\"projects\": [{\"name\": \"...\", \"path\": \"...\", \"worktreeCount\": N}]}`"
        }),
        serde_json::json!({
            "name": "projects add",
            "description": "Register an existing repository as a project",
            "parameters": [
                {"name": "path", "type": "string", "required": true, "positional": true, "description": "Path to the git repository"},
                {"name": "--label", "type": "string", "required": false, "description": "Label for the project"},
            ],
            "notes": "Registers an existing git repository. Detects the default branch automatically. Returns the project name."
        }),
        serde_json::json!({
            "name": "projects remove",
            "description": "Unregister a project",
            "parameters": [
                {"name": "name", "type": "string", "required": true, "positional": true, "description": "Project name"},
            ],
            "notes": "Removes the project from Band's registry (does not delete the repository)."
        }),
        serde_json::json!({
            "name": "workspaces list",
            "description": "List workspaces, optionally filtered by project",
            "parameters": [
                {"name": "project", "type": "string", "required": false, "positional": true, "description": "Project name (optional filter)"},
            ],
            "notes": "Text output: `project\\tbranch\\tpath` (tab-separated, one per line).\nJSON output: `{\"workspaces\": [{\"project\": \"...\", \"branch\": \"...\", \"path\": \"...\"}]}`"
        }),
        serde_json::json!({
            "name": "workspaces create",
            "description": "Create a new workspace (git worktree + state registration)",
            "parameters": [
                {"name": "project", "type": "string", "required": true, "positional": true, "description": "Project name"},
                {"name": "branch", "type": "string", "required": true, "positional": true, "description": "Branch name"},
                {"name": "--base", "type": "string", "required": false, "description": "Base branch to create from (defaults to project's default branch)"},
                {"name": "--prompt", "type": "string", "required": false, "description": "Prompt to pass to the coding agent"},
                {"name": "--max-turns", "type": "integer", "required": false, "description": "Maximum number of agentic turns"},
                {"name": "--mode", "type": "string", "required": false, "description": "Agent mode (e.g. 'plan', 'edit')"},
                {"name": "--model", "type": "string", "required": false, "description": "Model to use for the coding agent (e.g. 'claude-opus-4-20250514')"},
                {"name": "--agent", "type": "string", "required": false, "description": "Coding agent ID to use (overrides workspace default)"},
            ],
            "notes": "Returns the worktree path. Idempotent — creating an existing workspace returns its path. Runs `.band/config.json` `setup` script if present (non-fatal).\n\n**Always use `--prompt` when the user wants work to begin immediately.** This submits a task to the coding agent right after workspace creation, so the agent starts working without a separate step. Only omit `--prompt` when the user explicitly wants to create the workspace for manual/later use.\n\nWhen to use `--prompt` (most cases):\n```sh\n# User says \"create a workspace and implement X\" or \"start working on X\"\nband workspaces create my-app feat/auth --prompt \"Implement GitHub issue #42: Add JWT authentication\"\n\n# User says \"create a workspace for issue #99 and start implementing\"\nband workspaces create my-app fix/bug-99 --prompt \"Fix issue #99: login redirect loop. See https://github.com/org/repo/issues/99\"\n```\n\nWhen to omit `--prompt` (rare — user explicitly wants no task):\n```sh\n# User says \"just create a workspace, I'll work on it myself\"\nband workspaces create my-app feat/experiment\n```\n\n**Do NOT create a workspace without `--prompt` and then separately run `band chat`.** That is two steps for what `--prompt` does in one."
        }),
        serde_json::json!({
            "name": "workspaces remove",
            "description": "Remove a workspace (git worktree + state cleanup)",
            "parameters": [
                {"name": "project", "type": "string", "required": true, "positional": true, "description": "Project name"},
                {"name": "branch", "type": "string", "required": true, "positional": true, "description": "Branch name"},
            ],
            "notes": "Runs `.band/config.json` `teardown` script before removal (non-fatal). Cleans up all associated files."
        }),
        serde_json::json!({
            "name": "settings",
            "description": "Show current settings",
            "parameters": [],
            "notes": "Pretty-prints the current settings as JSON. With `--output json`, outputs compact JSON."
        }),
        serde_json::json!({
            "name": "tunnel status",
            "description": "Show tunnel status",
            "parameters": [],
            "notes": "Shows whether the tunnel is running and its URL."
        }),
        serde_json::json!({
            "name": "tunnel start",
            "description": "Start the remote tunnel",
            "parameters": [],
            "notes": "Starts the remote tunnel. Returns the tunnel URL."
        }),
        serde_json::json!({
            "name": "tunnel stop",
            "description": "Stop the remote tunnel",
            "parameters": [],
            "notes": "Stops the remote tunnel."
        }),
        serde_json::json!({
            "name": "tasks list",
            "description": "List tasks, optionally filtered by project or status",
            "parameters": [
                {"name": "--project", "type": "string", "required": false, "description": "Filter by project name"},
                {"name": "--status", "type": "string", "required": false, "description": "Filter by status (running, completed, failed)"},
            ],
            "notes": "Text output: `ID\\tSTATUS\\tWORKSPACE\\tPROMPT` (tab-separated table).\nJSON output: `{\"tasks\": [{\"id\": \"...\", \"status\": \"...\", \"project\": \"...\", \"branch\": \"...\", \"prompt\": \"...\"}]}`"
        }),
        serde_json::json!({
            "name": "tasks cancel",
            "description": "Cancel a running task",
            "parameters": [
                {"name": "task_id", "type": "string", "required": true, "positional": true, "description": "Task ID (e.g. tsk_1234567890)"},
            ],
            "notes": "Cancels a running task.\nJSON output: `{\"cancelled\": true, \"taskId\": \"...\"}`"
        }),
        serde_json::json!({
            "name": "tasks rerun",
            "description": "Re-run a completed or failed task",
            "parameters": [
                {"name": "task_id", "type": "string", "required": true, "positional": true, "description": "Task ID (e.g. tsk_1234567890)"},
            ],
            "notes": "Re-runs a completed or failed task."
        }),
        serde_json::json!({
            "name": "tasks watch",
            "description": "Stream task output in real-time",
            "parameters": [
                {"name": "id", "type": "string", "required": false, "positional": true, "description": "Task ID (optional if --workspace is provided)"},
                {"name": "--workspace", "type": "string", "required": false, "description": "Watch the latest task for this workspace"},
            ],
            "notes": "Streams task output in real-time. Either provide a task ID or `--workspace` to watch the latest task for that workspace."
        }),
        serde_json::json!({
            "name": "cronjobs list",
            "description": "List cronjobs, optionally filtered by project or workspace",
            "parameters": [
                {"name": "--project", "type": "string", "required": false, "description": "Filter by project name"},
                {"name": "--workspace", "type": "string", "required": false, "description": "Filter by workspace ID"},
            ]
        }),
        serde_json::json!({
            "name": "cronjobs create",
            "description": "Create a new scheduled cronjob",
            "parameters": [
                {"name": "key", "type": "string", "required": true, "positional": true, "description": "Storage key: project name or workspace ID"},
                {"name": "--name", "type": "string", "required": true, "description": "Human-readable name for the job"},
                {"name": "--prompt", "type": "string", "required": true, "description": "Prompt text to send to the coding agent"},
                {"name": "--cron", "type": "string", "required": true, "description": "Cron expression (e.g. \"0 */6 * * *\")"},
                {"name": "--scope", "type": "string", "required": false, "description": "Scope: project (default) or workspace"},
                {"name": "--workspace-id", "type": "string", "required": false, "description": "Workspace ID (required when scope is workspace)"},
                {"name": "--disabled", "type": "boolean", "required": false, "description": "Create the job in disabled state"},
            ]
        }),
        serde_json::json!({
            "name": "cronjobs update",
            "description": "Update an existing cronjob",
            "parameters": [
                {"name": "key", "type": "string", "required": true, "positional": true, "description": "Storage key (project name or workspace ID)"},
                {"name": "id", "type": "string", "required": true, "positional": true, "description": "Cronjob ID (e.g. cj_1234567890)"},
                {"name": "--name", "type": "string", "required": false, "description": "New name"},
                {"name": "--prompt", "type": "string", "required": false, "description": "New prompt"},
                {"name": "--cron", "type": "string", "required": false, "description": "New cron expression"},
                {"name": "--enable", "type": "boolean", "required": false, "description": "Enable the job"},
                {"name": "--disable", "type": "boolean", "required": false, "description": "Disable the job"},
            ]
        }),
        serde_json::json!({
            "name": "cronjobs delete",
            "description": "Delete a cronjob",
            "parameters": [
                {"name": "key", "type": "string", "required": true, "positional": true, "description": "Storage key (project name or workspace ID)"},
                {"name": "id", "type": "string", "required": true, "positional": true, "description": "Cronjob ID (e.g. cj_1234567890)"},
            ]
        }),
        serde_json::json!({
            "name": "cronjobs trigger",
            "description": "Manually trigger a cronjob now",
            "parameters": [
                {"name": "key", "type": "string", "required": true, "positional": true, "description": "Storage key (project name or workspace ID)"},
                {"name": "id", "type": "string", "required": true, "positional": true, "description": "Cronjob ID (e.g. cj_1234567890)"},
            ]
        }),
        serde_json::json!({
            "name": "chat",
            "description": "Send a message to a workspace chat (defaults to the workspace's active chat panel)",
            "parameters": [
                {"name": "workspace_id", "type": "string", "required": false, "positional": true, "description": "Workspace ID (auto-detected from cwd if omitted)"},
                {"name": "--message", "type": "string", "required": true, "description": "Message text to send"},
                {"name": "--chat-id", "type": "string", "required": false, "description": "Target a specific chat pane instead of the workspace default"},
                {"name": "--max-turns", "type": "integer", "required": false, "description": "Maximum number of agentic turns"},
                {"name": "--mode", "type": "string", "required": false, "description": "Agent mode (e.g. 'plan', 'edit')"},
                {"name": "--model", "type": "string", "required": false, "description": "Model to use for the coding agent (e.g. 'claude-opus-4-20250514')"},
                {"name": "--agent", "type": "string", "required": false, "description": "Coding agent ID to use (overrides workspace default)"},
            ],
            "notes": "Sends a message to the workspace's chat. When `--chat-id` is omitted, the server resolves the workspace's *active* chat panel (the tab the user last focused in the dashboard), falling back to the first panel in the saved layout, then to the first chat in the registry, and finally creating a new \"Chat\" panel if the workspace has none. This means CLI prompts land in the same conversation the user is looking at.\n\nReturns the task ID.\nJSON output: `{\"id\": \"tsk_...\", \"workspaceId\": \"...\", \"chatId\": \"chat_...\"}`\n\nReplaces the removed `tasks create` command. Use `--chat-id` to target a specific chat pane (look it up with `band chats list <workspace_id>`)."
        }),
        serde_json::json!({
            "name": "chats list",
            "description": "List chat panes for a workspace",
            "parameters": [
                {"name": "workspace_id", "type": "string", "required": true, "positional": true, "description": "Workspace ID"},
            ],
            "notes": "Text output: `ID\\tNAME\\tAGENT\\tSTATUS` (tab-separated table).\nJSON output: `{\"chats\": [{\"id\": \"...\", \"name\": \"...\", \"agent\": \"...\", \"status\": \"...\"}]}`"
        }),
        serde_json::json!({
            "name": "chats create",
            "description": "Create a new chat pane in a workspace",
            "parameters": [
                {"name": "workspace_id", "type": "string", "required": true, "positional": true, "description": "Workspace ID"},
                {"name": "--name", "type": "string", "required": false, "description": "Display name for the chat pane"},
                {"name": "--agent", "type": "string", "required": false, "description": "Coding agent ID (e.g. 'claude-code')"},
                {"name": "--model", "type": "string", "required": false, "description": "Model override"},
                {"name": "--mode", "type": "string", "required": false, "description": "Mode (e.g. 'plan', 'edit')"},
            ],
            "notes": "Creates a new independent chat pane with its own agent process. Returns the chat ID.\nJSON output: `{\"chat\": {\"id\": \"...\", \"name\": \"...\", \"agent\": \"...\", \"status\": \"idle\"}}`"
        }),
        serde_json::json!({
            "name": "chats send",
            "description": "Send a message to a chat pane",
            "parameters": [
                {"name": "chat_id", "type": "string", "required": true, "positional": true, "description": "Chat pane ID"},
                {"name": "--message", "type": "string", "required": true, "description": "Message text"},
            ],
            "notes": "Submits a task to the chat pane's agent. Returns the task ID."
        }),
        serde_json::json!({
            "name": "chats stop",
            "description": "Stop a running chat pane",
            "parameters": [
                {"name": "chat_id", "type": "string", "required": true, "positional": true, "description": "Chat pane ID"},
            ],
            "notes": "Aborts the running task and sets chat status to stopped."
        }),
        serde_json::json!({
            "name": "chats remove",
            "description": "Remove a chat pane (kills agent, cleans up state)",
            "parameters": [
                {"name": "chat_id", "type": "string", "required": true, "positional": true, "description": "Chat pane ID"},
            ],
            "notes": "Removes the chat pane, kills the associated agent process, and cleans up state."
        }),
        serde_json::json!({
            "name": "browser list",
            "description": "List browser tabs for a workspace",
            "parameters": [
                {"name": "workspace_id", "type": "string", "required": true, "positional": true, "description": "Workspace ID"},
            ],
            "notes": "Text output: `ID\\tNAME\\tURL\\tSTATUS` (tab-separated table).\nJSON output: `{\"browsers\": [{\"id\": \"...\", \"name\": \"...\", \"url\": \"...\", \"status\": \"...\"}]}`"
        }),
        serde_json::json!({
            "name": "browser create",
            "description": "Create a new browser tab in a workspace",
            "parameters": [
                {"name": "workspace_id", "type": "string", "required": true, "positional": true, "description": "Workspace ID"},
                {"name": "--url", "type": "string", "required": false, "description": "Initial URL to navigate to"},
                {"name": "--name", "type": "string", "required": false, "description": "Display name for the browser tab"},
            ],
            "notes": "Text output: the new browser tab ID.\nJSON output: `{\"browser\": {\"id\": \"...\", ...}}`"
        }),
        serde_json::json!({
            "name": "browser navigate",
            "description": "Navigate a browser tab to a URL",
            "parameters": [
                {"name": "browser_id", "type": "string", "required": true, "positional": true, "description": "Browser tab ID"},
                {"name": "url", "type": "string", "required": true, "positional": true, "description": "URL to navigate to"},
            ],
            "notes": "Updates the browser tab's URL in the server state."
        }),
        serde_json::json!({
            "name": "browser get",
            "description": "Get a browser tab's current state",
            "parameters": [
                {"name": "browser_id", "type": "string", "required": true, "positional": true, "description": "Browser tab ID"},
            ],
            "notes": "Text output: formatted key-value pairs.\nJSON output: `{\"browser\": {\"id\": \"...\", \"name\": \"...\", \"url\": \"...\", \"status\": \"...\"}}`"
        }),
        serde_json::json!({
            "name": "browser remove",
            "description": "Remove a browser tab",
            "parameters": [
                {"name": "browser_id", "type": "string", "required": true, "positional": true, "description": "Browser tab ID"},
            ],
            "notes": "Removes the browser tab and cleans up state."
        }),
        serde_json::json!({
            "name": "terminal list",
            "description": "List terminal sessions for a workspace",
            "parameters": [
                {"name": "workspace_id", "type": "string", "required": true, "positional": true, "description": "Workspace ID"},
            ],
            "notes": "Text output: `TERMINAL ID\\tTITLE\\tPID\\tSCROLLBACK` (tab-separated table).\nJSON output: `{\"terminals\": [{\"terminalId\": \"...\", \"workspaceId\": \"...\", \"pid\": N, \"scrollbackLength\": N, \"title\": \"...\"}]}`"
        }),
        serde_json::json!({
            "name": "terminal create",
            "description": "Create a new terminal session in a workspace",
            "parameters": [
                {"name": "workspace_id", "type": "string", "required": true, "positional": true, "description": "Workspace ID"},
                {"name": "--command", "type": "string", "required": false, "description": "Shell command to auto-run after spawn"},
                {"name": "--cwd", "type": "string", "required": false, "description": "Working directory (relative to workspace root)"},
            ],
            "notes": "Creates a new terminal session with its own PTY process. Returns the terminal ID.\nJSON output: `{\"terminalId\": \"...\", \"workspaceId\": \"...\", \"pid\": N}`"
        }),
        serde_json::json!({
            "name": "terminal send",
            "description": "Send input to a terminal session",
            "parameters": [
                {"name": "terminal_id", "type": "string", "required": true, "positional": true, "description": "Terminal ID"},
                {"name": "--data", "type": "string", "required": true, "description": "Text to send (supports \\n for newline, \\t for tab)"},
            ],
            "notes": "Writes text to the terminal's PTY stdin. Use \\n to send a newline (execute command).\nExample: band terminal send <id> --data \"ls -la\\n\""
        }),
        serde_json::json!({
            "name": "terminal output",
            "description": "Get terminal output (scrollback buffer)",
            "parameters": [
                {"name": "terminal_id", "type": "string", "required": true, "positional": true, "description": "Terminal ID"},
                {"name": "--lines", "type": "integer", "required": false, "description": "Number of lines to show (from end of buffer)"},
                {"name": "--follow", "type": "boolean", "required": false, "description": "Stream live output (like tail -f)"},
            ],
            "notes": "Without --follow: fetches the current scrollback buffer (up to 100KB).\nWith --follow: streams live terminal output via SSE. Press Ctrl+C to stop."
        }),
        serde_json::json!({
            "name": "terminal kill",
            "description": "Kill a terminal session",
            "parameters": [
                {"name": "terminal_id", "type": "string", "required": true, "positional": true, "description": "Terminal ID"},
            ],
            "notes": "Kills the terminal's PTY process and cleans up the session."
        }),
        serde_json::json!({
            "name": "terminal attach",
            "description": "Attach to a terminal (stream output + send input interactively)",
            "parameters": [
                {"name": "terminal_id", "type": "string", "required": true, "positional": true, "description": "Terminal ID"},
            ],
            "notes": "Streams terminal output to stdout while reading stdin line-by-line and sending it to the terminal.\nPress Ctrl+C to detach. Best for running commands, not full TUI interaction (use web UI for that)."
        }),
        serde_json::json!({
            "name": "notify",
            "description": "Receive hook notifications from Claude Code (reads JSON from stdin)",
            "parameters": [],
            "notes": "Not called directly — registered as a Claude Code hook by the Band dashboard."
        }),
        serde_json::json!({
            "name": "schema",
            "description": "Show command schemas as JSON",
            "parameters": [
                {"name": "command", "type": "string", "required": false, "positional": true, "description": "Command name (omit to list all commands)"},
            ]
        }),
        serde_json::json!({
            "name": "generate-skills",
            "description": "Generate SKILL.md files from schema and registry",
            "parameters": [
                {"name": "--output-dir", "type": "string", "required": false, "description": "Output directory for generated skills (default: skills/)"},
                {"name": "--filter", "type": "string", "required": false, "description": "Filter skills by name (substring match)"},
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
pub(crate) fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", dur.as_secs())
}
