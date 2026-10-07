mod api;
mod skills;
mod state;
mod validate;

use clap::{Parser, Subcommand};
use std::fmt::Write;
use std::io::BufRead;
use std::process;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Parser)]
#[command(name = "band", about = "Band CLI — programmatic worktree management")]
struct Cli {
    /// Output format: text or json
    #[arg(long, global = true, default_value = "text", env = "BAND_OUTPUT")]
    output: String,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Manage registered repos
    Repos {
        #[command(subcommand)]
        cmd: ReposCmd,
    },
    /// Manage worktrees (git worktrees)
    Worktrees {
        #[command(subcommand)]
        cmd: WorktreesCmd,
    },
    /// Start coding agents and list their sessions
    Agents {
        #[command(subcommand)]
        cmd: AgentsCmd,
    },
    /// Manage chat panes (multi-agent)
    Chats {
        #[command(subcommand)]
        cmd: ChatsCmd,
    },
    /// Manage browser tabs
    Browsers {
        #[command(subcommand)]
        cmd: BrowsersCmd,
    },
    /// Manage terminal sessions
    Terminals {
        #[command(subcommand)]
        cmd: TerminalsCmd,
    },
    /// Manage scheduled cronjobs
    Cronjobs {
        #[command(subcommand)]
        cmd: CronjobsCmd,
    },
    /// Manage what a chat listens for (PR reviews, CI, webhooks, timers)
    Subscriptions {
        #[command(subcommand)]
        cmd: SubscriptionsCmd,
    },
    /// List the hosts worktrees can run on
    Hosts {
        #[command(subcommand)]
        cmd: HostsCmd,
    },
    /// List the runners that start workers for worktrees waiting on a host
    Runners {
        #[command(subcommand)]
        cmd: RunnersCmd,
    },
    /// Check a repository's .band/environment.json
    Env {
        #[command(subcommand)]
        cmd: EnvCmd,
    },
    /// Manage the hub's device and worker tokens
    Tokens {
        #[command(subcommand)]
        cmd: TokensCmd,
    },
    /// Manage the credentials the hub stores encrypted (API keys, env values, OAuth connections)
    Vault {
        #[command(subcommand)]
        cmd: VaultCmd,
    },
    /// Manage the MCP servers the hub proxies for agents (credentials stay in the vault)
    Mcp {
        #[command(subcommand)]
        cmd: McpCmd,
    },
    /// Manage the context repos the hub holds (user and named contexts)
    Context {
        #[command(subcommand)]
        cmd: ContextCmd,
    },
    /// Manage projects: cross-repo bodies of work with their own context repo
    Projects {
        #[command(subcommand)]
        cmd: ProjectsCmd,
    },
    /// Manage tasks: a folder per piece of work in a project, with a worktree per repo
    Tasks {
        #[command(subcommand)]
        cmd: TasksCmd,
    },
    /// Show current settings
    Settings,
    /// Manage the remote tunnel
    Tunnel {
        #[command(subcommand)]
        cmd: TunnelCmd,
    },
    /// Open a file in the active Band worktree's editor pane
    Open {
        /// Path to the file (absolute, or relative to cwd). Optionally
        /// suffixed with `:line` / `:line:col` / `:line-lineEnd`.
        file_path: String,
        /// Worktree ID (overrides the dashboard's active worktree)
        #[arg(long)]
        worktree: Option<String>,
        /// Don't raise the dashboard window to the foreground after opening
        #[arg(long = "no-focus")]
        no_focus: bool,
    },
    /// Receive coding-agent hook notifications (reads JSON from stdin)
    Notify {
        /// Agent type that sent the hook (e.g. `claude-code`). Omit to let
        /// the server work it out from the payload or the worktree.
        #[arg(long)]
        agent: Option<String>,
    },
    /// Show command schemas as JSON
    Schema {
        /// Command name (omit to list all commands)
        command: Option<String>,
    },
    /// Manage CLI-shipped skills (`band`, `band-chat`, `band-terminal`,
    /// `band-browser`, `band-start`, `band-loop`, `band-subscribe`)
    Skills {
        #[command(subcommand)]
        cmd: SkillsCmd,
    },
}

#[derive(Subcommand)]
enum SkillsCmd {
    /// Install (or refresh) skills into the shared `~/.agents/skills/`
    /// directory and symlink each detected coding agent's skills/ folder.
    Install {
        /// Override the destination home dir (advanced; mostly for tests).
        /// Defaults to `$HOME`.
        #[arg(long)]
        home: Option<String>,
        /// Filter which skills to install by name (substring match).
        #[arg(long)]
        filter: Option<String>,
    },
}

#[derive(Subcommand)]
enum ReposCmd {
    /// List registered repos
    List,
    /// Register a repo from a path on the hub's machine, a remote URL (`--url`) or a folder on a worker (`--from`)
    Add {
        /// Path to the git repository. With `--from`, the folder on that host
        path: Option<String>,
        /// Label for the repo
        #[arg(long)]
        label: Option<String>,
        /// Add by remote URL. A worker clones it when a worktree first lands there
        #[arg(long, conflicts_with = "from")]
        url: Option<String>,
        /// Default branch for `--url`. Without it the hub asks the remote
        #[arg(long, requires = "url")]
        branch: Option<String>,
        /// Add the repo a folder on this host holds (host id, see `band hosts list`)
        #[arg(long)]
        from: Option<String>,
        /// With `--from`: serve a folder outside the worker's roots after confirming it
        #[arg(long, requires = "from")]
        add_root: bool,
        /// Project to put the repo in (defaults to the default project)
        #[arg(long)]
        project: Option<String>,
    },
    /// Unregister a repo
    Remove {
        /// Repo name
        name: String,
    },
}

#[derive(Subcommand)]
#[allow(clippy::large_enum_variant)]
enum WorktreesCmd {
    /// List worktrees, optionally filtered by repo
    List {
        /// Repo name (optional filter)
        repo: Option<String>,
    },
    /// Create a new worktree (git worktree + state registration)
    Create {
        /// Repo name
        repo: String,
        /// Branch name
        branch: String,
        /// Base branch to create from (defaults to repo's default branch)
        #[arg(long)]
        base: Option<String>,
        /// Prompt to pass to the coding agent
        #[arg(long)]
        prompt: Option<String>,
        /// Agent mode (e.g. 'plan', 'edit')
        #[arg(long)]
        mode: Option<String>,
        /// Model to use for the coding agent (e.g. 'claude-opus-4-20250514')
        #[arg(long)]
        model: Option<String>,
        /// Coding agent ID to use (e.g. 'claude-code')
        #[arg(long)]
        agent: Option<String>,
        /// Dispatch target for the prompt: 'terminal' (CLI default —
        /// launches the agent's interactive CLI in a fresh terminal pane)
        /// or 'chat' (submits to the worktree chat pane). Override
        /// precedence highest first: `--via` flag → `BAND_DISPATCH` env →
        /// `.band/config.json` `workspace.defaultVia` →
        /// `~/.band/settings.json` `cli.defaultVia` → terminal (issue #551)
        #[arg(long)]
        via: Option<String>,
        /// Place the worktree on an online host with these labels (k=v,
        /// comma-separated or repeated). With no match, the worktree waits
        /// as "provisioning" until a runner provides a host.
        #[arg(long, value_delimiter = ',')]
        labels: Vec<String>,
        /// Require host facts, e.g. `node=>=24` or `os=linux` (repeatable).
        /// Implies placement.
        #[arg(long)]
        requires: Vec<String>,
        /// Place on any online host, with no label or requirement.
        #[arg(long)]
        any_host: bool,
        /// How strongly the worktree is isolated: `worktree` (a git worktree
        /// on a shared worker, the default), `container` (a worker of its own
        /// in a container) or `vm`. `container` and `vm` need a runner that
        /// offers that level. Implies placement.
        #[arg(long, value_parser = ["worktree", "container", "vm"])]
        isolation: Option<String>,
        /// Where the repo's repository is on the chosen host (needed the
        /// first time the repo is used there).
        #[arg(long)]
        host_repo_path: Option<String>,
        /// Put the worktree in this project (name or ID from `band projects list`).
        /// The repo must be one of the project's.
        #[arg(long)]
        project: Option<String>,
    },
    /// Remove a worktree (git worktree + state cleanup)
    Remove {
        /// Repo name
        repo: String,
        /// Worktree name (the branch it was created on — its stable identity)
        name: String,
    },
}

#[derive(Subcommand)]
enum ChatsCmd {
    /// List chat panes for a worktree
    List {
        /// Worktree ID (auto-detected from cwd if omitted)
        worktree_id: Option<String>,
    },
    /// Create a new chat pane
    Create {
        /// Worktree ID (auto-detected from cwd if omitted)
        worktree_id: Option<String>,
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
        /// Label in the form `key=value` (repeatable). Keys with the
        /// reserved `band:` prefix are rejected by the server.
        #[arg(long = "label")]
        labels: Vec<String>,
    },
    /// Send a message to a worktree chat (defaults to the worktree's active chat panel)
    Send {
        /// Chat pane ID (defaults to the worktree's active chat panel)
        chat_id: Option<String>,
        /// Message text
        #[arg(long)]
        message: String,
        /// Worktree ID (auto-detected from cwd if omitted)
        #[arg(long)]
        worktree: Option<String>,
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
    /// Stream a chat pane's running task as raw NDJSON
    Watch {
        /// Chat pane ID (defaults to the cwd worktree's first chat pane)
        chat_id: Option<String>,
    },
    /// Stop a running chat pane
    Stop {
        /// Chat pane ID (defaults to the cwd worktree's first chat pane)
        chat_id: Option<String>,
    },
    /// Remove a chat pane
    Remove {
        /// Chat pane ID (defaults to the cwd worktree's first chat pane)
        chat_id: Option<String>,
    },
    /// Add or overwrite labels on a chat pane (additive merge — other
    /// labels are preserved).
    Label {
        /// Chat pane ID
        chat_id: String,
        /// One or more `key=value` pairs. Keys with the reserved
        /// `band:` prefix are rejected by the server.
        #[arg(required = true)]
        labels: Vec<String>,
    },
    /// Remove labels from a chat pane by key (other labels are preserved).
    Unlabel {
        /// Chat pane ID
        chat_id: String,
        /// One or more label keys to remove. Unknown keys are ignored.
        #[arg(required = true)]
        keys: Vec<String>,
    },
}

#[derive(Subcommand)]
enum BrowsersCmd {
    /// List browser tabs for a worktree
    List {
        /// Worktree ID (auto-detected from cwd if omitted)
        worktree_id: Option<String>,
    },
    /// Create a new browser tab
    Create {
        /// Worktree ID (auto-detected from cwd if omitted)
        worktree_id: Option<String>,
        /// Initial URL to navigate to
        #[arg(long)]
        url: Option<String>,
        /// Display name for the browser tab
        #[arg(long)]
        name: Option<String>,
    },
    /// Navigate a browser tab to a URL
    Navigate {
        /// Browser tab ID (defaults to the cwd worktree's first browser tab)
        browser_id: Option<String>,
        /// URL to navigate to
        #[arg(long)]
        url: String,
    },
    /// Get a browser tab's current state
    Get {
        /// Browser tab ID (defaults to the cwd worktree's first browser tab)
        browser_id: Option<String>,
    },
    /// Remove a browser tab
    Remove {
        /// Browser tab ID (defaults to the cwd worktree's first browser tab)
        browser_id: Option<String>,
    },
}

#[derive(Subcommand)]
enum AgentsCmd {
    /// List the running agent sessions of a worktree
    List {
        /// Worktree ID (auto-detected from cwd if omitted)
        worktree_id: Option<String>,
    },
    /// Start a coding agent, as a chat (gui) or as its CLI in a terminal (tui)
    Launch {
        /// Worktree ID (auto-detected from cwd if omitted)
        worktree_id: Option<String>,
        /// Coding agent ID from settings (default agent if omitted)
        #[arg(long)]
        agent: Option<String>,
        /// `gui` (chat) or `tui` (terminal); `chat` / `terminal` also accepted.
        /// Falls back to `$BAND_DISPATCH`, the repo's `.band/config.json`
        /// `workspace.defaultVia`, then the server's `agents.defaultMode`.
        #[arg(long)]
        mode: Option<String>,
        /// First prompt for the agent
        #[arg(long)]
        prompt: Option<String>,
    },
}

#[derive(Subcommand)]
enum TerminalsCmd {
    /// List terminal sessions for a worktree
    List {
        /// Worktree ID (auto-detected from cwd if omitted)
        worktree_id: Option<String>,
    },
    /// Create a new terminal session
    Create {
        /// Worktree ID (auto-detected from cwd if omitted)
        worktree_id: Option<String>,
        /// Shell command to auto-run after spawn
        #[arg(long)]
        command: Option<String>,
        /// Working directory (relative to worktree root)
        #[arg(long)]
        cwd: Option<String>,
    },
    /// Send input to a terminal session
    Send {
        /// Terminal ID (defaults to the cwd worktree's first terminal)
        terminal_id: Option<String>,
        /// Text to send (supports \\n for newline, \\t for tab)
        #[arg(long)]
        data: String,
    },
    /// Get terminal output (scrollback buffer)
    Output {
        /// Terminal ID (defaults to the cwd worktree's first terminal)
        terminal_id: Option<String>,
        /// Number of lines to show (from end of buffer)
        #[arg(long, short = 'n')]
        lines: Option<u32>,
        /// Stream live output
        #[arg(long, short = 'f')]
        follow: bool,
    },
    /// Kill a terminal session
    Kill {
        /// Terminal ID (defaults to the cwd worktree's first terminal)
        terminal_id: Option<String>,
    },
    /// Attach to a terminal (stream output + send input interactively)
    Attach {
        /// Terminal ID (defaults to the cwd worktree's first terminal)
        terminal_id: Option<String>,
    },
    /// Restart the terminal daemon, ending every terminal it hosts
    RestartDaemon,
}

#[derive(Subcommand)]
enum CronjobsCmd {
    /// List cronjobs
    List {
        /// Filter by repo name
        #[arg(long)]
        repo: Option<String>,
        /// Filter by worktree ID
        #[arg(long)]
        worktree: Option<String>,
    },
    /// Create a new cronjob
    Create {
        /// Storage key: repo name (for repo-scoped) or worktree ID (for worktree-scoped)
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
        /// Scope: repo or worktree
        #[arg(long, default_value = "repo")]
        scope: String,
        /// Worktree ID (required when scope is "worktree")
        #[arg(long)]
        worktree_id: Option<String>,
        /// Where each fire dispatches the prompt: `chat` (chat pane) or
        /// `terminal` (agent's vendor CLI in a fresh self-closing PTY). When
        /// omitted, resolved via the same precedence as `worktrees create`:
        /// `--via` flag → `$BAND_DISPATCH` → `.band/config.json`
        /// `workspace.defaultVia` → `~/.band/settings.json` `cli.defaultVia`
        /// → `terminal`. So a cron created from a chat agent defaults to chat,
        /// one created from a terminal defaults to terminal (issue #581).
        #[arg(long)]
        via: Option<String>,
        /// Start disabled
        #[arg(long)]
        disabled: bool,
    },
    /// Update an existing cronjob
    Update {
        /// Storage key (repo name or worktree ID)
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
        /// Storage key (repo name or worktree ID)
        key: String,
        /// Cronjob ID (e.g. `cj_1234567890`)
        id: String,
    },
    /// Manually trigger a cronjob now
    Trigger {
        /// Storage key (repo name or worktree ID)
        key: String,
        /// Cronjob ID (e.g. `cj_1234567890`)
        id: String,
    },
}

#[derive(Subcommand)]
enum SubscriptionsCmd {
    /// List a chat's subscriptions
    List {
        /// Chat ID (defaults to `$BAND_CHAT_ID`)
        #[arg(long, env = "BAND_CHAT_ID")]
        chat: Option<String>,
        /// List every subscription in this worktree instead of one chat's
        /// (wins over `$BAND_CHAT_ID`)
        #[arg(long)]
        worktree: Option<String>,
    },
    /// Subscribe a chat to events. Exactly one of `--pr`, `--branch`,
    /// `--webhook`, `--cron` and `--at`.
    Create {
        /// Chat ID (defaults to `$BAND_CHAT_ID`)
        #[arg(long, env = "BAND_CHAT_ID")]
        chat: Option<String>,
        /// Worktree ID (defaults to `$BAND_WORKTREE_ID`, then the chat's worktree)
        #[arg(long, env = "BAND_WORKTREE_ID")]
        worktree: Option<String>,
        /// Watch a pull request, as `owner/repo#N`
        #[arg(long, value_name = "OWNER/REPO#N")]
        pr: Option<String>,
        /// Watch a branch's CI, as `owner/repo@branch`. Implies `--ci`.
        #[arg(long, value_name = "OWNER/REPO@BRANCH")]
        branch: Option<String>,
        /// With `--pr`: deliver reviews. Reviews and comments are one
        /// subscription, and either flag (or neither, with no `--ci`) creates it.
        #[arg(long)]
        reviews: bool,
        /// With `--pr`: deliver comments (see `--reviews`)
        #[arg(long)]
        comments: bool,
        /// With `--pr`: also watch CI on the PR's head branch (looked up with `gh`)
        #[arg(long)]
        ci: bool,
        /// Create a webhook the chat is woken by. Prints its path and token once.
        #[arg(long)]
        webhook: bool,
        /// Recurring timer, as a cron expression (seconds field optional)
        #[arg(long)]
        cron: Option<String>,
        /// One-off timer: epoch milliseconds, or a delay such as `90s`, `10m`, `2h`, `1d`
        #[arg(long)]
        at: Option<String>,
        /// Stop after this many wakeups (default 10 for CI, 50 otherwise; a one-off timer always 1)
        #[arg(long)]
        max_wakeups: Option<u32>,
        /// Seconds to hold events before waking the chat (default 30)
        #[arg(long)]
        coalesce: Option<u32>,
    },
    /// Remove a subscription
    Remove {
        /// Subscription ID
        id: String,
    },
}

#[derive(Subcommand)]
enum HostsCmd {
    /// List hosts with their status, labels, agents, roots and last contact
    List,
    /// Remove an offline worker host that has no worktrees, and revoke its tokens
    Remove {
        /// Host ID (from `band hosts list`)
        id: String,
    },
}

#[derive(Subcommand)]
enum RunnersCmd {
    /// List the configured runners, what they are running and any settings errors
    List,
    /// Show what a runner's hooks printed for a host request
    Log {
        /// Host request ID (from `band worktrees create`'s provisioning result)
        request_id: String,
    },
}

#[derive(Subcommand)]
enum EnvCmd {
    /// Validate .band/environment.json, printing OK or each problem with its path
    Validate {
        /// Repository directory, or the environment.json file (default: the current directory)
        path: Option<String>,
    },
    /// Build the repo's environment image at its default branch, or report a cache hit
    Build {
        /// Repo name (from `band repos list`)
        repo: String,
        /// Build again even when an image for the same key exists
        #[arg(long)]
        force: bool,
        /// Return once the build has started instead of waiting for it to finish
        #[arg(long)]
        no_wait: bool,
    },
    /// Show a repo's current environment image and its latest build, with the log
    Status {
        /// Repo name (from `band repos list`)
        repo: String,
    },
}

#[derive(Subcommand)]
enum TokensCmd {
    /// List tokens (never their secrets)
    List,
    /// Create a device token for a UI or script. Prints the token once.
    CreateDevice {
        /// What the token is for, shown in the token list
        #[arg(long, default_value = "CLI device")]
        label: String,
        /// Let the token manage tokens (`tokens.*`). Without it the token
        /// gets 403 on every `band tokens` command.
        #[arg(long)]
        admin: bool,
    },
    /// Revoke a token. Whatever uses it stops authenticating.
    Revoke {
        /// Token ID (from `band tokens list`)
        id: String,
    },
}

#[derive(Subcommand)]
enum VaultCmd {
    /// List credentials (name, kind, scope, last use). Never their values.
    List,
    /// Store an API key, environment value or git access token. The value is read from stdin unless --value is given.
    Put {
        /// Credential name. An env item's name is the variable name.
        name: String,
        /// `api_key` (default), `env` or `git`
        #[arg(long, default_value = "api_key")]
        kind: String,
        /// `global` (default) or `repo:<name>`
        #[arg(long, default_value = "global")]
        scope: String,
        /// Short note shown in the list
        #[arg(long)]
        description: Option<String>,
        /// The value. Prefer stdin: an argument shows in the process list and shell history.
        #[arg(long)]
        value: Option<String>,
        /// For `--kind git`: the remote's host, such as github.com
        #[arg(long)]
        host: Option<String>,
        /// For `--kind git`: a pattern over the repository path, such as `owner/*` or `owner/repo`
        #[arg(long)]
        path: Option<String>,
        /// For `--kind git`: the username git sends with the token (default x-access-token)
        #[arg(long)]
        username: Option<String>,
    },
    /// Delete a credential. An OAuth connection is revoked at its server first.
    Delete {
        /// Credential ID (from `band vault list`)
        id: String,
    },
    /// Re-encrypt every credential under a new key (key-file installs only)
    RotateKey,
}

#[derive(Subcommand)]
enum McpCmd {
    /// List the proxied MCP servers
    List,
    /// Add an HTTP MCP server. Agents reach it at `/mcp-proxy/<name>` on the hub.
    Add {
        /// Server name: lowercase letters, digits, hyphens and underscores
        name: String,
        /// The server's streamable HTTP endpoint (https, or http on loopback)
        url: String,
        /// Credential ID from `band vault list` (an API key or an OAuth connection)
        #[arg(long)]
        vault_item: Option<String>,
        /// Header that carries an API key (default Authorization). An OAuth credential always uses Authorization.
        #[arg(long)]
        header: Option<String>,
        /// Text before an API key in the header (default `Bearer `, pass an empty string for none)
        #[arg(long)]
        prefix: Option<String>,
        /// Comma-separated tools agents may see and call. Default: every tool.
        #[arg(long)]
        allow_tools: Option<String>,
        /// Keep only read-only tools (annotated readOnlyHint, or named in --read-only-tools)
        #[arg(long)]
        read_only: bool,
        /// Comma-separated tools to treat as read-only
        #[arg(long)]
        read_only_tools: Option<String>,
        /// Add the server switched off
        #[arg(long)]
        disabled: bool,
    },
    /// Remove a proxied MCP server
    Remove {
        /// Server name (from `band mcp list`)
        name: String,
    },
}

#[derive(Subcommand)]
enum ContextCmd {
    /// List the contexts
    List,
    /// Create a context. `user` is the user context; any other name is a named (project) context.
    Create {
        /// Context name: lowercase letters, digits, hyphens and underscores
        name: String,
        /// Existing repo to mirror both ways (https, ssh or scp-style URL)
        #[arg(long)]
        remote: Option<String>,
        /// Credential ID from `band vault list` for an https remote
        #[arg(long)]
        vault_item: Option<String>,
        /// Comma-separated `key=value` host labels a worker needs to pull this context
        #[arg(long)]
        labels: Option<String>,
        /// Workers may pull but not push
        #[arg(long)]
        read_only: bool,
    },
    /// Remove a context and its repo on the hub
    Remove {
        /// Context name (from `band context list`)
        name: String,
    },
    /// Link a context to a remote repo and mirror it now. Pass `--unlink` to drop the link.
    LinkRemote {
        /// Context name
        name: String,
        /// Remote URL (https, ssh or scp-style)
        remote: Option<String>,
        /// Credential ID from `band vault list` for an https remote
        #[arg(long)]
        vault_item: Option<String>,
        /// Drop the remote link
        #[arg(long)]
        unlink: bool,
    },
}

#[derive(Subcommand)]
enum ProjectsCmd {
    /// List the projects
    List,
    /// Show one project with its repos, context and worktrees
    Get {
        /// Project name or ID
        project: String,
    },
    /// Create a project and its context repo
    Create {
        /// Project name: lowercase letters, digits, hyphens and underscores
        name: String,
        /// What the project is for
        #[arg(long)]
        description: Option<String>,
        /// A repo the project may touch, as `name` or `name:role` (repeatable)
        #[arg(long = "repo")]
        repos: Vec<String>,
        /// Use this existing project context instead of creating one
        #[arg(long)]
        context: Option<String>,
        /// Mirror the new context repo with this remote (https, ssh or scp-style URL)
        #[arg(long)]
        remote_url: Option<String>,
        /// Credential ID from `band vault list` for an https remote
        #[arg(long)]
        remote_vault_item: Option<String>,
        /// Model of the project's coordinator (default: opus)
        #[arg(long)]
        model: Option<String>,
        /// Coding agent ID of the coordinator
        #[arg(long)]
        agent: Option<String>,
        /// Comma-separated `key=value` host labels for the project's worktrees
        #[arg(long)]
        labels: Option<String>,
    },
    /// Change a project's description, coordinator or labels
    Update {
        /// Project name or ID
        project: String,
        #[arg(long)]
        description: Option<String>,
        /// Model of the project's coordinator
        #[arg(long)]
        model: Option<String>,
        /// Coding agent ID of the coordinator
        #[arg(long)]
        agent: Option<String>,
        /// Comma-separated `key=value` host labels (replaces the list)
        #[arg(long)]
        labels: Option<String>,
    },
    /// Remove a project. Refused while worktrees belong to it.
    Remove {
        /// Project name or ID
        project: String,
        /// Also delete the project's context repo
        #[arg(long)]
        remove_context: bool,
    },
    /// Add a repo to a project, or change its role
    AddRepo {
        /// Project name or ID
        project: String,
        /// Repo name (from `band repos list`)
        repo: String,
        /// Role of the repo in the project, such as `api` or `client`
        #[arg(long)]
        role: Option<String>,
    },
    /// Remove a repo from a project. Refused while its worktrees belong to the project.
    RemoveRepo {
        /// Project name or ID
        project: String,
        /// Repo name
        repo: String,
    },
    /// Put an existing worktree in a project
    AttachWorktree {
        /// Project name or ID
        project: String,
        /// Worktree ID (from `band worktrees list`)
        worktree_id: String,
    },
    /// Take a worktree out of its project
    DetachWorktree {
        /// Worktree ID
        worktree_id: String,
    },
}

#[derive(Subcommand)]
enum TasksCmd {
    /// Create a task: a folder on one host with BRIEF.md, a worktree per repo and a chat
    Create {
        /// Project name or ID
        project: String,
        /// Branch every repo's worktree is made on, from its default branch
        branch: String,
        /// A repo of the project to start with, as `name` or `name:role` (repeatable). None starts an empty task.
        #[arg(long = "repo")]
        repos: Vec<String>,
        /// A file with the task's brief (markdown)
        #[arg(long)]
        brief: Option<String>,
        /// Task folder name (default: the branch with `/` replaced by `-`)
        #[arg(long)]
        name: Option<String>,
        /// Title of the task's chat
        #[arg(long)]
        title: Option<String>,
        /// Host ID to create the task on (default: a host that fits)
        #[arg(long)]
        host: Option<String>,
        /// Comma-separated `key=value` host labels the host must have
        #[arg(long)]
        labels: Option<String>,
        /// Coding agent ID of the task's chat
        #[arg(long)]
        agent: Option<String>,
        /// Model of the task's chat
        #[arg(long)]
        model: Option<String>,
        /// Make the task and its chat without sending the first prompt
        #[arg(long)]
        no_start: bool,
    },
    /// List a project's tasks, or every project's
    List {
        /// Project name or ID
        project: Option<String>,
    },
    /// Add a repo of the task's project to a task
    AddRepo {
        /// Task ID, or its name with --project
        task: String,
        /// Repo name
        repo: String,
        /// Role of the repo in the task
        #[arg(long)]
        role: Option<String>,
        /// Project name or ID, when `task` is a name
        #[arg(long)]
        project: Option<String>,
    },
    /// Remove a repo from a task. Refused while its worktree has commits or uncommitted changes.
    RemoveRepo {
        /// Task ID, or its name with --project
        task: String,
        /// Repo name
        repo: String,
        /// Project name or ID, when `task` is a name
        #[arg(long)]
        project: Option<String>,
    },
    /// Remove a task with its worktrees, chats and folder
    Remove {
        /// Task ID, or its name with --project
        task: String,
        /// Project name or ID, when `task` is a name
        #[arg(long)]
        project: Option<String>,
        /// Remove it even when a worktree has commits or uncommitted changes
        #[arg(long)]
        force: bool,
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

    // terminal output --follow streams output directly
    if let Commands::Terminals {
        cmd:
            TerminalsCmd::Output {
                ref terminal_id,
                lines,
                follow: true,
            },
    } = cli.command
    {
        let exit_code = handle_terminal_follow(terminal_id.as_deref(), lines, json_output);
        process::exit(exit_code);
    }

    // terminal attach is interactive streaming
    if let Commands::Terminals {
        cmd: TerminalsCmd::Attach { ref terminal_id },
    } = cli.command
    {
        let exit_code = handle_terminal_attach(terminal_id.as_deref(), json_output);
        process::exit(exit_code);
    }

    // chats watch streams the chat's running task as raw NDJSON
    if let Commands::Chats {
        cmd: ChatsCmd::Watch { ref chat_id },
    } = cli.command
    {
        let exit_code = handle_chats_watch(chat_id.as_deref());
        process::exit(exit_code);
    }

    // env commands exit non-zero on a problem or a failed build, with the details as their output
    if let Commands::Env { ref cmd } = cli.command {
        let exit_code = match cmd {
            EnvCmd::Validate { path } => handle_env_validate(path.as_deref(), json_output),
            EnvCmd::Build {
                repo,
                force,
                no_wait,
            } => handle_env_build(repo, *force, *no_wait, json_output),
            EnvCmd::Status { repo } => handle_env_status(repo, json_output),
        };
        process::exit(exit_code);
    }

    let result = match cli.command {
        Commands::Repos { cmd } => match cmd {
            ReposCmd::List => cmd_repos_list(),
            ReposCmd::Add {
                path,
                label,
                url,
                branch,
                from,
                add_root,
                project,
            } => cmd_repos_add(&ReposAddArgs {
                path: path.as_deref(),
                label: label.as_deref(),
                url: url.as_deref(),
                branch: branch.as_deref(),
                from: from.as_deref(),
                add_root,
                project: project.as_deref(),
            }),
            ReposCmd::Remove { name } => cmd_repos_remove(&name),
        },
        Commands::Worktrees { cmd } => match cmd {
            WorktreesCmd::List { repo } => cmd_worktrees_list(repo.as_deref()),
            WorktreesCmd::Create {
                repo,
                branch,
                base,
                prompt,
                mode,
                model,
                agent,
                via,
                labels,
                requires,
                any_host,
                isolation,
                host_repo_path,
                project,
            } => cmd_worktrees_create(
                &repo,
                &branch,
                base.as_deref(),
                prompt.as_deref(),
                mode.as_deref(),
                model.as_deref(),
                agent.as_deref(),
                via.as_deref(),
                &Placement {
                    labels: &labels,
                    requires: &requires,
                    any_host,
                    isolation: isolation.as_deref(),
                    host_repo_path: host_repo_path.as_deref(),
                    project: project.as_deref(),
                },
            ),
            WorktreesCmd::Remove { repo, name } => cmd_worktrees_remove(&repo, &name),
        },
        Commands::Agents { cmd } => match cmd {
            AgentsCmd::List { worktree_id } => cmd_agents_list(worktree_id.as_deref()),
            AgentsCmd::Launch {
                worktree_id,
                agent,
                mode,
                prompt,
            } => cmd_agents_launch(
                worktree_id.as_deref(),
                agent.as_deref(),
                mode.as_deref(),
                prompt.as_deref(),
            ),
        },
        Commands::Chats { cmd } => match cmd {
            ChatsCmd::List { worktree_id } => cmd_chats_list(worktree_id.as_deref()),
            ChatsCmd::Create {
                worktree_id,
                name,
                agent,
                model,
                mode,
                labels,
            } => cmd_chats_create(
                worktree_id.as_deref(),
                name.as_deref(),
                agent.as_deref(),
                model.as_deref(),
                mode.as_deref(),
                &labels,
            ),
            ChatsCmd::Send {
                chat_id,
                message,
                worktree,
                mode,
                model,
                agent,
            } => cmd_chats_send(
                chat_id.as_deref(),
                &message,
                worktree.as_deref(),
                mode.as_deref(),
                model.as_deref(),
                agent.as_deref(),
            ),
            ChatsCmd::Watch { .. } => unreachable!(),
            ChatsCmd::Stop { chat_id } => cmd_chats_stop(chat_id.as_deref()),
            ChatsCmd::Remove { chat_id } => cmd_chats_remove(chat_id.as_deref()),
            ChatsCmd::Label { chat_id, labels } => cmd_chats_label(&chat_id, &labels),
            ChatsCmd::Unlabel { chat_id, keys } => cmd_chats_unlabel(&chat_id, &keys),
        },
        Commands::Browsers { cmd } => match cmd {
            BrowsersCmd::List { worktree_id } => cmd_browser_list(worktree_id.as_deref()),
            BrowsersCmd::Create {
                worktree_id,
                url,
                name,
            } => cmd_browser_create(worktree_id.as_deref(), url.as_deref(), name.as_deref()),
            BrowsersCmd::Navigate { url, browser_id } => {
                cmd_browser_navigate(browser_id.as_deref(), &url)
            }
            BrowsersCmd::Get { browser_id } => cmd_browser_get(browser_id.as_deref()),
            BrowsersCmd::Remove { browser_id } => cmd_browser_remove(browser_id.as_deref()),
        },
        Commands::Terminals { cmd } => match cmd {
            TerminalsCmd::List { worktree_id } => cmd_terminal_list(worktree_id.as_deref()),
            TerminalsCmd::Create {
                worktree_id,
                command,
                cwd,
            } => cmd_terminal_create(worktree_id.as_deref(), command.as_deref(), cwd.as_deref()),
            TerminalsCmd::Send { terminal_id, data } => {
                cmd_terminal_send(terminal_id.as_deref(), &data)
            }
            TerminalsCmd::Output {
                terminal_id,
                lines,
                follow: false,
            } => cmd_terminal_output(terminal_id.as_deref(), lines),
            TerminalsCmd::Output { .. } | TerminalsCmd::Attach { .. } => unreachable!(),
            TerminalsCmd::Kill { terminal_id } => cmd_terminal_kill(terminal_id.as_deref()),
            TerminalsCmd::RestartDaemon => cmd_terminal_restart_daemon(),
        },
        Commands::Cronjobs { cmd } => match cmd {
            CronjobsCmd::List { repo, worktree } => {
                cmd_cronjobs_list(repo.as_deref(), worktree.as_deref())
            }
            CronjobsCmd::Create {
                key,
                name,
                prompt,
                cron,
                scope,
                worktree_id,
                via,
                disabled,
            } => cmd_cronjobs_create(
                &key,
                &name,
                &prompt,
                &cron,
                &scope,
                worktree_id.as_deref(),
                via.as_deref(),
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
        Commands::Subscriptions { cmd } => match cmd {
            SubscriptionsCmd::List { chat, worktree } => {
                cmd_subscriptions_list(chat.as_deref(), worktree.as_deref())
            }
            SubscriptionsCmd::Create {
                chat,
                worktree,
                pr,
                branch,
                reviews,
                comments,
                ci,
                webhook,
                cron,
                at,
                max_wakeups,
                coalesce,
            } => cmd_subscriptions_create(&SubscriptionSpec {
                chat,
                worktree,
                pr,
                branch,
                reviews,
                comments,
                ci,
                webhook,
                cron,
                at,
                max_wakeups,
                coalesce,
            }),
            SubscriptionsCmd::Remove { id } => cmd_subscriptions_remove(&id),
        },
        Commands::Env { .. } => unreachable!("handled before the match"),
        Commands::Hosts { cmd } => match cmd {
            HostsCmd::List => cmd_hosts_list(),
            HostsCmd::Remove { id } => cmd_hosts_remove(&id),
        },
        Commands::Runners { cmd } => match cmd {
            RunnersCmd::List => cmd_runners_list(),
            RunnersCmd::Log { request_id } => cmd_runners_log(&request_id),
        },
        Commands::Tokens { cmd } => match cmd {
            TokensCmd::List => cmd_tokens_list(),
            TokensCmd::CreateDevice { label, admin } => cmd_tokens_create_device(&label, admin),
            TokensCmd::Revoke { id } => cmd_tokens_revoke(&id),
        },
        Commands::Vault { cmd } => match cmd {
            VaultCmd::List => cmd_vault_list(),
            VaultCmd::Put {
                name,
                kind,
                scope,
                description,
                value,
                host,
                path,
                username,
            } => cmd_vault_put(
                &name,
                &kind,
                &scope,
                description.as_deref(),
                value,
                &GitTarget {
                    host: host.as_deref(),
                    path: path.as_deref(),
                    username: username.as_deref(),
                },
            ),
            VaultCmd::Delete { id } => cmd_vault_delete(&id),
            VaultCmd::RotateKey => cmd_vault_rotate_key(),
        },
        Commands::Mcp { cmd } => match cmd {
            McpCmd::List => cmd_mcp_list(),
            McpCmd::Add {
                name,
                url,
                vault_item,
                header,
                prefix,
                allow_tools,
                read_only,
                read_only_tools,
                disabled,
            } => cmd_mcp_add(
                &name,
                &url,
                vault_item.as_deref(),
                header.as_deref(),
                prefix.as_deref(),
                allow_tools.as_deref(),
                read_only,
                read_only_tools.as_deref(),
                disabled,
            ),
            McpCmd::Remove { name } => cmd_mcp_remove(&name),
        },
        Commands::Context { cmd } => match cmd {
            ContextCmd::List => cmd_context_list(),
            ContextCmd::Create {
                name,
                remote,
                vault_item,
                labels,
                read_only,
            } => cmd_context_create(
                &name,
                remote.as_deref(),
                vault_item.as_deref(),
                labels.as_deref(),
                read_only,
            ),
            ContextCmd::Remove { name } => cmd_context_remove(&name),
            ContextCmd::LinkRemote {
                name,
                remote,
                vault_item,
                unlink,
            } => cmd_context_link_remote(&name, remote.as_deref(), vault_item.as_deref(), unlink),
        },
        Commands::Tasks { cmd } => match cmd {
            TasksCmd::Create {
                project,
                branch,
                repos,
                brief,
                name,
                title,
                host,
                labels,
                agent,
                model,
                no_start,
            } => cmd_tasks_create(
                &project,
                &branch,
                &repos,
                brief.as_deref(),
                name.as_deref(),
                title.as_deref(),
                host.as_deref(),
                labels.as_deref(),
                agent.as_deref(),
                model.as_deref(),
                no_start,
            ),
            TasksCmd::List { project } => cmd_tasks_list(project.as_deref()),
            TasksCmd::AddRepo {
                task,
                repo,
                role,
                project,
            } => cmd_tasks_add_repo(&task, &repo, role.as_deref(), project.as_deref()),
            TasksCmd::RemoveRepo {
                task,
                repo,
                project,
            } => cmd_tasks_remove_repo(&task, &repo, project.as_deref()),
            TasksCmd::Remove {
                task,
                project,
                force,
            } => cmd_tasks_remove(&task, project.as_deref(), force),
        },
        Commands::Projects { cmd } => match cmd {
            ProjectsCmd::List => cmd_projects_list(),
            ProjectsCmd::Get { project } => cmd_projects_get(&project),
            ProjectsCmd::Create {
                name,
                description,
                repos,
                context,
                remote_url,
                remote_vault_item,
                model,
                agent,
                labels,
            } => cmd_projects_create(
                &name,
                description.as_deref(),
                &repos,
                context.as_deref(),
                remote_url.as_deref(),
                remote_vault_item.as_deref(),
                model.as_deref(),
                agent.as_deref(),
                labels.as_deref(),
            ),
            ProjectsCmd::Update {
                project,
                description,
                model,
                agent,
                labels,
            } => cmd_projects_update(
                &project,
                description.as_deref(),
                model.as_deref(),
                agent.as_deref(),
                labels.as_deref(),
            ),
            ProjectsCmd::Remove {
                project,
                remove_context,
            } => cmd_projects_remove(&project, remove_context),
            ProjectsCmd::AddRepo {
                project,
                repo,
                role,
            } => cmd_projects_add_repo(&project, &repo, role.as_deref()),
            ProjectsCmd::RemoveRepo { project, repo } => cmd_projects_remove_repo(&project, &repo),
            ProjectsCmd::AttachWorktree {
                project,
                worktree_id,
            } => cmd_projects_attach_worktree(&project, &worktree_id),
            ProjectsCmd::DetachWorktree { worktree_id } => {
                cmd_projects_detach_worktree(&worktree_id)
            }
        },
        Commands::Settings => cmd_settings(json_output),
        Commands::Tunnel { cmd } => match cmd {
            TunnelCmd::Status => cmd_tunnel_status(),
            TunnelCmd::Start => cmd_tunnel_start(),
            TunnelCmd::Stop => cmd_tunnel_stop(),
        },
        Commands::Open {
            file_path,
            worktree,
            no_focus,
        } => cmd_open(&file_path, worktree.as_deref(), !no_focus),
        Commands::Notify { agent } => cmd_notify(agent.as_deref()),
        Commands::Schema { .. } => unreachable!(),
        Commands::Skills { cmd } => match cmd {
            SkillsCmd::Install { home, filter } => {
                skills::install_skills(home.as_deref(), filter.as_deref())
            }
        },
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

// --- Repos commands ---

fn cmd_repos_list() -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_query_no_input("repos.list")?;

    let repos = data
        .get("repos")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();

    let mut json_repos = Vec::new();
    let mut rows: Vec<[String; 6]> = Vec::new();
    for proj in &repos {
        let name = proj.get("name").and_then(|n| n.as_str()).unwrap_or("");
        let path = proj.get("path").and_then(|p| p.as_str()).unwrap_or("");
        // `kind` defaults to "git" — the server always sets it, but older
        // servers (or test fixtures predating #427) may omit the field.
        let kind = proj.get("kind").and_then(|k| k.as_str()).unwrap_or("git");
        let wt_count = proj
            .get("worktrees")
            .and_then(|w| w.as_array())
            .map_or(0, Vec::len);
        // KIND is appended to the end of the column list (not inserted
        // between NAME and PATH) so existing scripts that index the text
        // output positionally — e.g. `awk '{print $2}'` to extract the
        // path — keep working. The JSON output is keyed and order-
        // insensitive, so the field placement there doesn't matter.
        let remote_url = proj.get("remoteUrl").and_then(|u| u.as_str());
        let clones = proj
            .get("clones")
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default();
        let clones_text = if clones.is_empty() {
            "-".to_string()
        } else {
            clones
                .iter()
                .map(|c| {
                    format!(
                        "{}:{}",
                        c.get("hostId").and_then(|h| h.as_str()).unwrap_or(""),
                        c.get("path").and_then(|p| p.as_str()).unwrap_or("")
                    )
                })
                .collect::<Vec<_>>()
                .join(", ")
        };
        // URL and CLONES go after KIND for the same positional-script reason.
        rows.push([
            name.to_string(),
            path.to_string(),
            format!(
                "{} worktree{}",
                wt_count,
                if wt_count == 1 { "" } else { "s" }
            ),
            kind.to_string(),
            remote_url.unwrap_or("-").to_string(),
            clones_text,
        ]);
        json_repos.push(serde_json::json!({
            "name": name,
            "path": path,
            "kind": kind,
            "worktreeCount": wt_count,
            "remoteUrl": remote_url,
            "clones": clones,
        }));
    }

    let text = format_table(
        &["NAME", "PATH", "WORKTREES", "KIND", "URL", "CLONES"],
        &rows,
    );

    Ok(CommandResult {
        text,
        json: serde_json::json!({"repos": json_repos}),
    })
}

struct ReposAddArgs<'a> {
    path: Option<&'a str>,
    label: Option<&'a str>,
    url: Option<&'a str>,
    branch: Option<&'a str>,
    from: Option<&'a str>,
    add_root: bool,
    project: Option<&'a str>,
}

fn cmd_repos_add(args: &ReposAddArgs) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;

    let data = if let Some(url) = args.url {
        if args.path.is_some() {
            return Err("Pass either a path or --url, not both".to_string());
        }
        let mut input = serde_json::json!({"remoteUrl": url});
        if let Some(branch) = args.branch {
            input["defaultBranch"] = serde_json::json!(branch);
        }
        if let Some(label) = args.label {
            input["label"] = serde_json::json!(label);
        }
        if let Some(project) = args.project {
            input["project"] = serde_json::json!(project);
        }
        client.trpc_mutate("repos.addByUrl", &input)?
    } else if let Some(host) = args.from {
        let path = args
            .path
            .ok_or("--from needs the folder on that host: band repos add --from <host> <path>")?;
        validate::validate_name(host, "Host")?;
        let mut input = serde_json::json!({"hostId": host, "path": path});
        if args.add_root {
            input["addRoot"] = serde_json::json!(true);
        }
        if let Some(label) = args.label {
            input["label"] = serde_json::json!(label);
        }
        if let Some(project) = args.project {
            input["project"] = serde_json::json!(project);
        }
        client
            .trpc_mutate("repos.addFromWorker", &input)
            .map_err(|msg| {
                if msg.contains("OUTSIDE_ROOTS:") {
                    format!("{msg}\nRepeat with --add-root to serve that folder from the worker.")
                } else {
                    msg
                }
            })?
    } else {
        let path = args
            .path
            .ok_or("Pass a path, --url <url> or --from <host> <path>")?;
        validate::validate_path(path, "Path")?;
        let mut input = serde_json::json!({"path": path});
        if let Some(label) = args.label {
            input["label"] = serde_json::json!(label);
        }
        client.trpc_mutate("repos.add", &input)?
    };
    let name = data.get("name").and_then(|n| n.as_str()).unwrap_or("");
    let result_path = data.get("path").and_then(|p| p.as_str()).unwrap_or("");
    let remote_url = data.get("remoteUrl").and_then(|u| u.as_str());

    Ok(CommandResult {
        text: format!("{name}\n"),
        json: serde_json::json!({"name": name, "path": result_path, "remoteUrl": remote_url}),
    })
}

fn cmd_repos_remove(name: &str) -> Result<CommandResult, String> {
    validate::validate_name(name, "Repo name")?;

    let client = api::ApiClient::from_settings()?;
    client.trpc_mutate("repos.remove", &serde_json::json!({"name": name}))?;

    Ok(CommandResult {
        text: String::new(),
        json: serde_json::json!({"ok": true}),
    })
}

// --- Worktrees commands ---

fn cmd_worktrees_list(repo_filter: Option<&str>) -> Result<CommandResult, String> {
    if let Some(name) = repo_filter {
        validate::validate_name(name, "Repo name")?;
    }

    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_query_no_input("repos.list")?;

    let repos = data
        .get("repos")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();

    let mut found_any = false;
    let mut rows: Vec<[String; 4]> = Vec::new();
    let mut listed = Vec::new();
    for proj in &repos {
        let name = proj.get("name").and_then(|n| n.as_str()).unwrap_or("");
        if let Some(filter) = repo_filter {
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
            let worktree_id = wt.get("worktreeId").and_then(|w| w.as_str()).unwrap_or("");
            rows.push([
                name.to_string(),
                branch.to_string(),
                worktree_id.to_string(),
                path.to_string(),
            ]);
            listed.push(serde_json::json!({
                "repo": name,
                "branch": branch,
                "worktreeId": worktree_id,
                "path": path,
            }));
            found_any = true;
        }
    }

    if let Some(filter) = repo_filter {
        if !found_any {
            return Err(format!("Repo '{filter}' not found"));
        }
    }

    let text = format_table(&["REPO", "BRANCH", "WORKTREE ID", "PATH"], &rows);

    Ok(CommandResult {
        text,
        json: serde_json::json!({"worktrees": listed}),
    })
}

/// Where `worktrees create` should put the worktree, when the caller gave
/// criteria instead of a host.
struct Placement<'a> {
    labels: &'a [String],
    requires: &'a [String],
    any_host: bool,
    isolation: Option<&'a str>,
    host_repo_path: Option<&'a str>,
    project: Option<&'a str>,
}

#[allow(clippy::too_many_arguments)]
fn cmd_worktrees_create(
    repo: &str,
    branch: &str,
    base: Option<&str>,
    prompt: Option<&str>,
    mode: Option<&str>,
    model: Option<&str>,
    agent: Option<&str>,
    via: Option<&str>,
    placement: &Placement,
) -> Result<CommandResult, String> {
    validate::validate_name(repo, "Repo name")?;
    validate::validate_name(branch, "Branch name")?;
    if let Some(b) = base {
        validate::validate_name(b, "Base branch")?;
    }

    // Read settings once and share the snapshot between the API client
    // (port + auth token) and the dispatch-target resolver (which may
    // fall back to `cli.defaultVia`). Without this, the bottom of the
    // `--via` precedence chain re-reads `~/.band/settings.json` on
    // every CLI invocation that doesn't supply `--via` and
    // `BAND_DISPATCH`.
    let settings = state::load_settings()?;
    let client = api::ApiClient::from_loaded_settings(settings.clone());

    // The server only branches on `via` when a prompt is present —
    // a no-prompt worktree create is a pure worktree-add with no
    // dispatch. Skip the precedence resolution entirely in that case
    // so we don't fork `git rev-parse --show-toplevel` or `stat` the
    // `.band/config.json` for nothing. We still validate an
    // explicitly-passed `--via` so a typo fails fast even without a
    // prompt — but BAND_DISPATCH / config / settings fallbacks are
    // dead weight on the no-prompt path.
    let resolved_via = if prompt.is_some() {
        // Resolve dispatch target (issue #551). Precedence, highest first:
        //   1. --via flag.
        //   2. $BAND_DISPATCH env var.
        //   3. .band/config.json `workspace.defaultVia` in the current repo.
        //   4. ~/.band/settings.json `cli.defaultVia`.
        //   5. Built-in CLI default: "terminal".
        //
        // The server-side default is "chat" so the web UI keeps its
        // existing behavior; the CLI explicitly forwards the resolved
        // value on every call so the server never has to guess.
        Some(resolve_dispatch_target(via, &settings)?)
    } else if let Some(v) = via {
        Some(validate_via(v, "--via flag")?)
    } else {
        None
    };

    let mut input = serde_json::json!({
        "repo": repo,
        "branch": branch,
    });
    if let Some(ref v) = resolved_via {
        input["via"] = serde_json::json!(v);
    }
    if let Some(base) = base {
        input["base"] = serde_json::json!(base);
    }
    if let Some(prompt) = prompt {
        input["prompt"] = serde_json::json!(prompt);
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
    if !placement.labels.is_empty()
        || !placement.requires.is_empty()
        || placement.any_host
        || placement.isolation.is_some()
    {
        input["placement"] = serde_json::json!({
            "labels": parse_label_pairs(placement.labels)?,
            "requires": parse_requirement_pairs(placement.requires)?,
        });
        if let Some(isolation) = placement.isolation {
            input["placement"]["environment"] = serde_json::json!({ "isolation": isolation });
        }
    }
    if let Some(path) = placement.host_repo_path {
        input["hostRepoPath"] = serde_json::json!(path);
    }
    if let Some(project) = placement.project {
        input["projectId"] = serde_json::json!(project);
    }
    let data = client.trpc_mutate("worktrees.create", &input)?;
    // No host fits yet: the hub recorded a host request and creates the
    // worktree when a runner provides one.
    if let Some(request_id) = data
        .get("provisioning")
        .and_then(|p| p.get("requestId"))
        .and_then(|r| r.as_str())
    {
        return Ok(CommandResult {
            text: format!("provisioning (host request {request_id})\n"),
            json: serde_json::json!({ "provisioning": { "requestId": request_id } }),
        });
    }
    let path = data.get("path").and_then(|p| p.as_str()).unwrap_or("");
    // The server is the source of truth for the actual dispatch. It echoes
    // back the via it dispatched with (which may differ from
    // `resolved_via` when the chosen adapter falls back to chat) and
    // emits `terminalId` only when a PTY was reserved. On the idempotent
    // path (existing worktree) the server omits both fields entirely —
    // no fresh dispatch happened — and the CLI must suppress them too so
    // a caller scripting on `.terminalId` can detect that case.
    let actual_via = data
        .get("via")
        .and_then(|v| v.as_str())
        .map(std::string::ToString::to_string);
    let terminal_id = data
        .get("terminalId")
        .and_then(|t| t.as_str())
        .map(std::string::ToString::to_string);

    let mut json = serde_json::json!({ "path": path });
    if let Some(ref v) = actual_via {
        json["via"] = serde_json::json!(v);
    }
    if let Some(ref tid) = terminal_id {
        json["terminalId"] = serde_json::json!(tid);
    }

    Ok(CommandResult {
        text: format!("{path}\n"),
        json,
    })
}

/// Walk the dispatch-target precedence chain (issue #551):
///   1. `--via` flag value.
///   2. `$BAND_DISPATCH` env var.
///   3. `.band/config.json` `workspace.defaultVia` in the current repo.
///   4. `~/.band/settings.json` `cli.defaultVia`.
///   5. Built-in CLI default: `"terminal"`.
///
/// Takes a pre-loaded `Settings` snapshot so the caller can share its
/// file read with the API client (`api::ApiClient::from_loaded_settings`)
/// — without it, every `band worktrees create` without `--via` or
/// `BAND_DISPATCH` would `stat`+`read` `~/.band/settings.json` twice.
///
/// Rejects unknown string values with a CLI error so a typo
/// (e.g. `--via terminall` or `BAND_DISPATCH=chats`) fails fast instead
/// of being silently rejected by the server's `z.enum` validator.
fn resolve_dispatch_target(
    flag: Option<&str>,
    settings: &state::Settings,
) -> Result<String, String> {
    if let Some(v) = flag {
        return validate_via(v, "--via flag");
    }
    if let Ok(env) = std::env::var("BAND_DISPATCH") {
        let trimmed = env.trim();
        if !trimmed.is_empty() {
            return validate_via(trimmed, "BAND_DISPATCH env var");
        }
    }
    if let Some(v) = read_repo_default_via() {
        return validate_via(&v, ".band/config.json workspace.defaultVia");
    }
    if let Some(v) = user_default_via(settings) {
        return validate_via(&v, "~/.band/settings.json cli.defaultVia");
    }
    Ok("terminal".to_string())
}

fn validate_via(value: &str, source: &str) -> Result<String, String> {
    match value {
        "chat" | "terminal" => Ok(value.to_string()),
        other => Err(format!(
            "Invalid dispatch target '{other}' from {source}: expected 'chat' or 'terminal'."
        )),
    }
}

/// Read `workspace.defaultVia` from `.band/config.json` in the current
/// working directory's git toplevel (or `cwd` when not in a git repo).
/// Returns `None` if the file is absent, malformed, or missing the key.
///
/// The repo-level config is the per-repo override for the user-level
/// `cli.defaultVia`. We deliberately read the file directly (no server
/// roundtrip) so the CLI behaves the same way whether the dashboard is
/// running or not.
///
/// **Cheap-stat first.** Most callers are outside a `.band/`-configured
/// repo (or run from a worktree that has none), so we check whether
/// `cwd/.band/config.json` exists *before* forking `git
/// rev-parse --show-toplevel`. If the file already sits in cwd we read
/// it directly; otherwise we fall through to the git-toplevel resolution
/// (the common case for being deep inside a subdirectory).
fn read_repo_default_via() -> Option<String> {
    let cwd = std::env::current_dir().ok()?;
    let cwd_config = cwd.join(".band").join("config.json");
    if cwd_config.is_file() {
        return parse_default_via(&cwd_config);
    }
    // Neutralise `GIT_DIR` and `GIT_WORK_TREE` so an outer git
    // configuration can't redirect the toplevel lookup to a different
    // repo — `validate_via` already rejects anything but
    // `"chat"|"terminal"`, so this is defence-in-depth rather than a
    // hot path, but eliminating the trust boundary is cheap.
    let toplevel = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&cwd)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| std::path::PathBuf::from(String::from_utf8_lossy(&o.stdout).trim().to_string()))?;
    parse_default_via(&toplevel.join(".band").join("config.json"))
}

fn parse_default_via(config_path: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(config_path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    parsed
        .get("workspace")
        .and_then(|w| w.get("defaultVia"))
        .and_then(|v| v.as_str())
        .map(std::string::ToString::to_string)
}

/// Pluck `cli.defaultVia` out of an already-loaded `Settings` snapshot.
/// Returns `None` when the key is absent or has the wrong type.
fn user_default_via(settings: &state::Settings) -> Option<String> {
    settings
        .cli
        .as_ref()
        .and_then(|c| c.get("defaultVia"))
        .and_then(|v| v.as_str())
        .map(std::string::ToString::to_string)
}

fn cmd_worktrees_remove(repo: &str, name: &str) -> Result<CommandResult, String> {
    validate::validate_name(repo, "Repo name")?;
    validate::validate_name(name, "Worktree name")?;

    let client = api::ApiClient::from_settings()?;
    // The server identifies a worktree by its immutable `name` — the branch
    // it was created on, which stays stable even after the git branch is
    // switched (see the `worktrees.name` column).
    client.trpc_mutate(
        "worktrees.remove",
        &serde_json::json!({
            "repo": repo,
            "name": name,
        }),
    )?;

    Ok(CommandResult {
        text: String::new(),
        json: serde_json::json!({"ok": true}),
    })
}

// --- Chats commands ---

fn cmd_chats_list(worktree_id: Option<&str>) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let worktree_id = resolve_worktree_id(&client, worktree_id)?;
    let data = client.trpc_query(
        "chats.list",
        &serde_json::json!({"worktreeId": worktree_id}),
    )?;

    let chats = data
        .get("chats")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();

    let mut rows: Vec<[String; 5]> = Vec::new();
    let mut json_chats = Vec::new();
    for chat in &chats {
        let id = chat.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let name = chat.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let agent = chat.get("agent").and_then(|v| v.as_str()).unwrap_or("");
        let status = chat.get("status").and_then(|v| v.as_str()).unwrap_or("");
        // Labels are persisted as a Record<string, string> on the server and
        // returned inline on each chat. Render them as `k=v,k=v` to keep the
        // table compact — empty record or missing field both render as an
        // empty cell. Keys are sorted for stable output (the server doesn't
        // promise insertion order across rehydrations).
        let labels = chat
            .get("labels")
            .and_then(|v| v.as_object())
            .map(|obj| {
                let mut pairs: Vec<(&String, &serde_json::Value)> = obj.iter().collect();
                pairs.sort_by(|a, b| a.0.cmp(b.0));
                pairs
                    .into_iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| format!("{k}={s}")))
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        rows.push([
            id.to_string(),
            name.to_string(),
            agent.to_string(),
            status.to_string(),
            labels,
        ]);
        json_chats.push(chat.clone());
    }

    let text = format_table(&["ID", "NAME", "AGENT", "STATUS", "LABELS"], &rows);

    Ok(CommandResult {
        text,
        json: serde_json::json!({"chats": json_chats}),
    })
}

fn cmd_chats_create(
    worktree_id: Option<&str>,
    name: Option<&str>,
    agent: Option<&str>,
    model: Option<&str>,
    mode: Option<&str>,
    label_args: &[String],
) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let worktree_id = resolve_worktree_id(&client, worktree_id)?;
    let mut input = serde_json::json!({"worktreeId": worktree_id});
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
    if !label_args.is_empty() {
        let labels = parse_label_pairs(label_args)?;
        input["labels"] = serde_json::Value::Object(labels);
    }
    let data = client.trpc_mutate("chats.create", &input)?;
    let chat = data.get("chat").cloned().unwrap_or(serde_json::Value::Null);
    let id = chat.get("id").and_then(|v| v.as_str()).unwrap_or("");

    Ok(CommandResult {
        text: format!("{id}\n"),
        json: serde_json::json!({"chat": chat}),
    })
}

/// Parse `key=constraint` host requirements such as `node=>=24`. Only the first
/// `=` separates the key, so the constraint may start with `>=`.
fn parse_requirement_pairs(
    pairs: &[String],
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let mut out = serde_json::Map::new();
    for raw in pairs {
        let (k, v) = raw
            .split_once('=')
            .ok_or_else(|| format!("requirement \"{raw}\" must be in the form key=constraint"))?;
        if k.is_empty() || v.is_empty() {
            return Err(format!(
                "requirement \"{raw}\" needs a key and a constraint"
            ));
        }
        out.insert(k.to_string(), serde_json::Value::String(v.to_string()));
    }
    Ok(out)
}

/// Parse a list of `key=value` strings into a JSON object. Splits each
/// pair on the **first** `=` so values may legitimately contain further
/// `=` characters (e.g. base64 or URL fragments). Refuses any pair that
/// lacks `=` or has an empty key, so a typo like `--label phaseplan`
/// fails loudly with a clear message instead of being silently dropped
/// or sent to the server as a no-key validation failure.
fn parse_label_pairs(
    pairs: &[String],
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let mut out = serde_json::Map::new();
    for raw in pairs {
        let (k, v) = raw
            .split_once('=')
            .ok_or_else(|| format!("label \"{raw}\" must be in the form key=value"))?;
        if k.is_empty() {
            return Err(format!("label \"{raw}\" has an empty key"));
        }
        // Catch empty values at the CLI boundary so the user sees an
        // actionable message tied to their input instead of the server's
        // generic "value must be a non-empty string" tRPC error — same
        // rule the server enforces but with the offending pair quoted
        // back at them. Aligns the CLI-side check with the server-side
        // one in `validateLabels`.
        if v.is_empty() {
            return Err(format!("label \"{raw}\" has an empty value"));
        }
        // Later duplicates overwrite earlier ones — `--label k=a --label k=b`
        // ends up as `k=b`, matching how kubectl handles the same input.
        out.insert(k.to_string(), serde_json::Value::String(v.to_string()));
    }
    Ok(out)
}

/// Fetch the current labels record for a chat via `chats.get`. Returns
/// an empty `Map` for unlabeled chats (and for chats whose server
/// response omits the field entirely — defensive read).
///
/// Used as the "read" half of the label/unlabel read-modify-write loop.
/// The intervening server-side `chats.update` is a full-set replace, so
/// the CLI has to fetch the current labels, merge locally, and send the
/// full intended set back. Two callers mutating labels on the same
/// chat concurrently can race; for the single-user workflow this is
/// targeting that's acceptable.
fn fetch_chat_labels(
    client: &api::ApiClient,
    chat_id: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let data = client.trpc_query("chats.get", &serde_json::json!({"chatId": chat_id}))?;
    let chat = data.get("chat").cloned().unwrap_or(serde_json::Value::Null);
    if chat.is_null() {
        return Err(format!("Chat \"{chat_id}\" not found"));
    }
    Ok(chat
        .get("labels")
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default())
}

fn cmd_chats_label(chat_id: &str, label_args: &[String]) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let additions = parse_label_pairs(label_args)?;
    let mut labels = fetch_chat_labels(&client, chat_id)?;
    for (k, v) in additions {
        labels.insert(k, v);
    }
    let intended = serde_json::Value::Object(labels);
    let data = client.trpc_mutate(
        "chats.update",
        &serde_json::json!({"chatId": chat_id, "labels": intended.clone()}),
    )?;
    let chat = data.get("chat").cloned().unwrap_or(serde_json::Value::Null);
    Ok(CommandResult {
        // Prefer the server-confirmed labels so the text output can't drift
        // from the JSON output if the server ever normalises keys differently
        // (today they always agree because validation runs the same sort).
        // Fall back to the intended set only if the response somehow omits
        // the field — that's a server bug we'd want to see surfaced.
        text: format_labels_cell(server_labels(&chat).unwrap_or(&intended)),
        json: serde_json::json!({"chat": chat}),
    })
}

fn cmd_chats_unlabel(chat_id: &str, keys: &[String]) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let mut labels = fetch_chat_labels(&client, chat_id)?;
    for k in keys {
        labels.remove(k);
    }
    let intended = serde_json::Value::Object(labels);
    let data = client.trpc_mutate(
        "chats.update",
        &serde_json::json!({"chatId": chat_id, "labels": intended.clone()}),
    )?;
    let chat = data.get("chat").cloned().unwrap_or(serde_json::Value::Null);
    Ok(CommandResult {
        // See `cmd_chats_label` — prefer server-confirmed labels for text
        // output so it can't silently diverge from the JSON output.
        text: format_labels_cell(server_labels(&chat).unwrap_or(&intended)),
        json: serde_json::json!({"chat": chat}),
    })
}

/// Extract the `labels` field from a `chats.update` server response.
/// Returns `None` if the response is missing the field or if it's the wrong
/// shape — in which case the caller should fall back to the locally-computed
/// set rather than silently rendering an empty cell.
fn server_labels(chat: &serde_json::Value) -> Option<&serde_json::Value> {
    let labels = chat.get("labels")?;
    if labels.is_object() {
        Some(labels)
    } else {
        None
    }
}

/// Render a labels record as `k=v,k=v\n` with sorted keys. Shared
/// between `band chats label` and `band chats unlabel` so both surface
/// the final state of the chat in the same format `chats list` uses.
///
/// **Sort-order assumption:** uses Rust's default byte-order `cmp`, which
/// matches the server's byte-order sort in `validateLabels` (codepoint
/// comparison via `a < b ? -1 : a > b ? 1 : 0`). Both sides deliberately
/// avoid locale-aware sort so the CLI table and JSON output show the
/// same chat with the same key ordering under every locale. If the
/// server's sort ever changes — or if the label-key regex
/// `^[a-zA-Z0-9_:-]{1,64}$` is relaxed to allow Unicode — re-audit both
/// sites together so they stay aligned.
fn format_labels_cell(labels: &serde_json::Value) -> String {
    // Empty string (not `"\n"`) when there's nothing to render — the
    // caller checks `!output.text.is_empty()` before printing, so a
    // bare `"\n"` would emit a spurious blank line on the
    // edge case where the server response lacks a labels object.
    let Some(obj) = labels.as_object() else {
        return String::new();
    };
    if obj.is_empty() {
        return String::new();
    }
    let mut pairs: Vec<(&String, &serde_json::Value)> = obj.iter().collect();
    pairs.sort_by(|a, b| a.0.cmp(b.0));
    let rendered: Vec<String> = pairs
        .into_iter()
        .filter_map(|(k, v)| v.as_str().map(|s| format!("{k}={s}")))
        .collect();
    format!("{}\n", rendered.join(","))
}

/// Send a message to a worktree chat, defaulting to the worktree's active
/// chat panel when no `chat_id` is provided. Returns the task id, or
/// `queued <queue entry id>` when the chat is busy and the server queued
/// the message behind the running turn.
///
/// Calls `tasks.submit` server-side, which resolves the default chat via
/// `getOrCreateDefaultChat` — honoring the saved chat layout's active panel,
/// then the first panel in the saved layout, then the first chat in the
/// registry, and finally lazy-creating a new "Chat" panel if the worktree
/// has none. So passing no `chat_id` here matches the chat the user is
/// looking at in the dashboard.
fn cmd_chats_send(
    chat_id: Option<&str>,
    message: &str,
    worktree_id: Option<&str>,
    mode: Option<&str>,
    model: Option<&str>,
    agent: Option<&str>,
) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let worktree_id = resolve_worktree_id(&client, worktree_id)?;

    let mut input = serde_json::json!({
        "worktreeId": worktree_id,
        "prompt": message,
    });
    if let Some(chat_id) = chat_id {
        input["chatId"] = serde_json::json!(chat_id);
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

    let ws = data
        .get("worktreeId")
        .and_then(|w| w.as_str())
        .unwrap_or("");
    let resolved_chat_id = data.get("chatId").and_then(|c| c.as_str()).unwrap_or("");

    if data.get("queued").and_then(serde_json::Value::as_bool) == Some(true) {
        let queued_id = data
            .get("queuedMessageId")
            .and_then(|q| q.as_str())
            .unwrap_or("");
        return Ok(CommandResult {
            text: format!("queued {queued_id}\n"),
            json: serde_json::json!({
                "id": null,
                "queued": true,
                "queuedMessageId": queued_id,
                "worktreeId": ws,
                "chatId": resolved_chat_id,
            }),
        });
    }

    let id = data.get("id").and_then(|i| i.as_str()).unwrap_or("");
    Ok(CommandResult {
        text: format!("{id}\n"),
        json: serde_json::json!({
            "id": id,
            "queued": false,
            "worktreeId": ws,
            "chatId": resolved_chat_id,
        }),
    })
}

/// Stream a chat pane's event log as raw NDJSON.
///
/// Connects to `GET /api/chats/<chat_id>/events` (the unified server-
/// authoritative SSE event log the dashboard uses) and dumps each
/// `data: {...}` payload to stdout, one JSON object per line. The
/// output is always raw JSON regardless of `--output`.
///
/// Behaviour change from the legacy `/api/tasks/<chat_id>/stream`:
/// the new endpoint keeps the connection open even when no task is
/// running, so the watcher behaves like `tail -f` — it surfaces the
/// NEXT submission's events live. SIGINT (Ctrl-C) terminates it. The
/// legacy 204 "no running task" branch is retained for forward-compat
/// in case any deployment still routes the old path through a proxy.
fn handle_chats_watch(chat_id: Option<&str>) -> i32 {
    match cmd_chats_watch(chat_id) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{}", serde_json::json!({"error": e}));
            1
        }
    }
}

fn cmd_chats_watch(chat_id: Option<&str>) -> Result<(), String> {
    use std::io::Write as _;

    let client = api::ApiClient::from_settings()?;
    let chat_id =
        resolve_default_panel(&client, chat_id, "chats.list", "chats", "id", "chat pane")?;
    let path = format!("/api/chats/{}/events", urlencoded_path_segment(&chat_id));
    let mut response = client.get_raw_stream(&path)?;
    let status = response.status().as_u16();

    if status == 401 {
        return Err("Authentication failed. Check tokenSecret in settings".to_string());
    }
    if status == 204 {
        // No running task — nothing to stream.
        return Ok(());
    }
    if status >= 400 {
        let body: serde_json::Value = response
            .body_mut()
            .read_json()
            .unwrap_or(serde_json::Value::Null);
        let msg = body
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Unknown server error");
        return Err(msg.to_string());
    }

    let mut body = response.into_body();
    let mut reader = std::io::BufReader::new(body.as_reader());
    let mut line_buf = String::new();
    let mut data_buf = String::new();
    let mut stdout = std::io::stdout().lock();

    loop {
        line_buf.clear();
        match reader.read_line(&mut line_buf) {
            Ok(0) => break, // EOF
            Ok(_) => {}
            Err(e) => return Err(format!("Connection error: {e}")),
        }

        let line = line_buf.trim_end();

        if line.is_empty() {
            // End of an SSE event — flush the accumulated data buffer as one
            // NDJSON line. Server emits multi-line `data:` for some events;
            // join them with `\n` per the SSE spec, then validate as JSON.
            if !data_buf.is_empty() {
                let _ = serde_json::from_str::<serde_json::Value>(&data_buf)
                    .map_err(|e| format!("Invalid JSON in SSE event: {e}\nbody: {data_buf}"))?;
                writeln!(stdout, "{data_buf}").map_err(|e| format!("Write error: {e}"))?;
                let _ = stdout.flush();
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
        // Ignore id:, event:, retry:, and comment lines.
    }

    Ok(())
}

/// URL-encode a single path segment (chat id). Only allows the unreserved
/// character set; everything else is percent-encoded so a hostile chat id
/// can't smuggle path components or query strings into the request URL.
fn urlencoded_path_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                const HEX: &[u8; 16] = b"0123456789ABCDEF";
                out.push('%');
                out.push(HEX[(b >> 4) as usize] as char);
                out.push(HEX[(b & 0x0f) as usize] as char);
            }
        }
    }
    out
}

fn cmd_chats_stop(chat_id: Option<&str>) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let chat_id =
        resolve_default_panel(&client, chat_id, "chats.list", "chats", "id", "chat pane")?;
    client.trpc_mutate("chats.stop", &serde_json::json!({"chatId": chat_id}))?;

    Ok(CommandResult {
        text: format!("Chat {chat_id} stopped\n"),
        json: serde_json::json!({"ok": true, "chatId": chat_id}),
    })
}

fn cmd_chats_remove(chat_id: Option<&str>) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let chat_id =
        resolve_default_panel(&client, chat_id, "chats.list", "chats", "id", "chat pane")?;
    client.trpc_mutate("chats.remove", &serde_json::json!({"chatId": chat_id}))?;

    Ok(CommandResult {
        text: format!("Chat {chat_id} removed\n"),
        json: serde_json::json!({"ok": true, "chatId": chat_id}),
    })
}

// --- Browser commands ---

fn cmd_browser_list(worktree_id: Option<&str>) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let worktree_id = resolve_worktree_id(&client, worktree_id)?;
    let data = client.trpc_query(
        "browsers.list",
        &serde_json::json!({"worktreeId": worktree_id}),
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
    worktree_id: Option<&str>,
    url: Option<&str>,
    name: Option<&str>,
) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let worktree_id = resolve_worktree_id(&client, worktree_id)?;
    let mut input = serde_json::json!({"worktreeId": worktree_id});
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

fn cmd_browser_navigate(browser_id: Option<&str>, url: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let browser_id = resolve_default_panel(
        &client,
        browser_id,
        "browsers.list",
        "browsers",
        "id",
        "browser tab",
    )?;
    client.trpc_mutate(
        "browsers.navigate",
        &serde_json::json!({"browserId": browser_id, "url": url}),
    )?;

    Ok(CommandResult {
        text: format!("Navigated {browser_id} to {url}\n"),
        json: serde_json::json!({"ok": true, "browserId": browser_id, "url": url}),
    })
}

fn cmd_browser_get(browser_id: Option<&str>) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let browser_id = resolve_default_panel(
        &client,
        browser_id,
        "browsers.list",
        "browsers",
        "id",
        "browser tab",
    )?;
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

fn cmd_browser_remove(browser_id: Option<&str>) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let browser_id = resolve_default_panel(
        &client,
        browser_id,
        "browsers.list",
        "browsers",
        "id",
        "browser tab",
    )?;
    client.trpc_mutate(
        "browsers.remove",
        &serde_json::json!({"browserId": browser_id}),
    )?;

    Ok(CommandResult {
        text: format!("Browser {browser_id} removed\n"),
        json: serde_json::json!({"ok": true, "browserId": browser_id}),
    })
}

// --- Agent commands ---

/// Normalize an agent mode flag: `gui` / `tui`, with the `--via` names
/// `chat` / `terminal` as aliases.
fn parse_agent_mode(mode: &str) -> Result<&'static str, String> {
    match mode {
        "gui" | "chat" => Ok("gui"),
        "tui" | "terminal" => Ok("tui"),
        other => Err(format!(
            "Invalid agent mode '{other}': expected gui, tui, chat or terminal"
        )),
    }
}

fn cmd_agents_list(worktree_id: Option<&str>) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let worktree_id = resolve_worktree_id(&client, worktree_id)?;
    let data = client.trpc_query(
        "agentSessions.list",
        &serde_json::json!({"worktreeId": worktree_id}),
    )?;
    let sessions = data
        .get("agentSessions")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let field = |s: &serde_json::Value, key: &str| {
        s.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let rows: Vec<[String; 6]> = sessions
        .iter()
        .map(|s| {
            // A gui session lives in a chat, a tui session in a terminal.
            let pane = s
                .get("chatId")
                .and_then(|v| v.as_str())
                .or_else(|| s.get("terminalId").and_then(|v| v.as_str()))
                .unwrap_or("")
                .to_string();
            [
                field(s, "id"),
                field(s, "agentDefinitionId"),
                field(s, "mode"),
                field(s, "state"),
                pane,
                field(s, "providerSessionId"),
            ]
        })
        .collect();

    let text = format_table(
        &[
            "SESSION ID",
            "AGENT",
            "MODE",
            "STATE",
            "PANE",
            "PROVIDER SESSION",
        ],
        &rows,
    );
    Ok(CommandResult {
        text,
        json: serde_json::json!({"agentSessions": sessions}),
    })
}

/// Resolve `band agents launch`'s mode, highest first: `--mode`, then
/// `$BAND_DISPATCH` (so an agent running in a Band terminal or chat starts
/// its agents the same way), then the repo's `.band/config.json`
/// `workspace.defaultVia`. `None` leaves the choice to the server's
/// `agents.defaultMode`, which also covers the older `cli.defaultVia`.
fn resolve_agent_mode(flag: Option<&str>) -> Result<Option<&'static str>, String> {
    if let Some(m) = flag {
        return parse_agent_mode(m).map(Some);
    }
    if let Ok(env) = std::env::var("BAND_DISPATCH") {
        let trimmed = env.trim();
        if !trimmed.is_empty() {
            return parse_agent_mode(trimmed)
                .map(Some)
                .map_err(|e| format!("{e} (from BAND_DISPATCH env var)"));
        }
    }
    if let Some(v) = read_repo_default_via() {
        return parse_agent_mode(&v)
            .map(Some)
            .map_err(|e| format!("{e} (from .band/config.json workspace.defaultVia)"));
    }
    Ok(None)
}

fn cmd_agents_launch(
    worktree_id: Option<&str>,
    agent: Option<&str>,
    mode: Option<&str>,
    prompt: Option<&str>,
) -> Result<CommandResult, String> {
    let mode = resolve_agent_mode(mode)?;
    let client = api::ApiClient::from_settings()?;
    let worktree_id = resolve_worktree_id(&client, worktree_id)?;
    let mut input = serde_json::json!({"worktreeId": worktree_id});
    if let Some(a) = agent {
        input["agentId"] = serde_json::json!(a);
    }
    if let Some(m) = mode {
        input["mode"] = serde_json::json!(m);
    }
    if let Some(p) = prompt {
        input["prompt"] = serde_json::json!(p);
    }
    let data = client.trpc_mutate("agentSessions.launch", &input)?;

    let started_mode = data.get("mode").and_then(|v| v.as_str()).unwrap_or("");
    let pane = data
        .get("chatId")
        .and_then(|v| v.as_str())
        .or_else(|| data.get("terminalId").and_then(|v| v.as_str()))
        .unwrap_or("");
    let mut text = format!("{started_mode}\t{pane}\n");
    if let Some(notice) = data.get("notice").and_then(|v| v.as_str()) {
        text = format!("{text}note: {notice}\n");
    }
    Ok(CommandResult { text, json: data })
}

// --- Terminal commands ---

fn cmd_terminal_list(worktree_id: Option<&str>) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let worktree_id = resolve_worktree_id(&client, worktree_id)?;
    let data = client.trpc_query(
        "terminal.list",
        &serde_json::json!({"worktreeId": worktree_id}),
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
    worktree_id: Option<&str>,
    command: Option<&str>,
    cwd: Option<&str>,
) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let worktree_id = resolve_worktree_id(&client, worktree_id)?;
    let mut input = serde_json::json!({"worktreeId": worktree_id});
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

fn cmd_terminal_send(terminal_id: Option<&str>, data: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let terminal_id = resolve_default_panel(
        &client,
        terminal_id,
        "terminal.list",
        "terminals",
        "terminalId",
        "terminal session",
    )?;
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

fn cmd_terminal_output(
    terminal_id: Option<&str>,
    lines: Option<u32>,
) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let terminal_id = resolve_default_panel(
        &client,
        terminal_id,
        "terminal.list",
        "terminals",
        "terminalId",
        "terminal session",
    )?;
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

fn cmd_terminal_kill(terminal_id: Option<&str>) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let terminal_id = resolve_default_panel(
        &client,
        terminal_id,
        "terminal.list",
        "terminals",
        "terminalId",
        "terminal session",
    )?;
    client.trpc_mutate(
        "terminal.kill",
        &serde_json::json!({"terminalId": terminal_id}),
    )?;

    Ok(CommandResult {
        text: format!("Terminal {terminal_id} killed\n"),
        json: serde_json::json!({"ok": true, "terminalId": terminal_id}),
    })
}

fn cmd_terminal_restart_daemon() -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let result = client.trpc_mutate("terminal.restartDaemon", &serde_json::json!({}))?;
    let killed_count = result
        .get("killedCount")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);

    Ok(CommandResult {
        text: format!(
            "Terminal daemon restarted; ended {killed_count} terminal session(s). Sessions from a previous version of Band are kept.\n"
        ),
        json: serde_json::json!({"ok": true, "killedCount": killed_count}),
    })
}

fn handle_terminal_follow(terminal_id: Option<&str>, lines: Option<u32>, json_output: bool) -> i32 {
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
    terminal_id: Option<&str>,
    lines: Option<u32>,
    json_output: bool,
) -> Result<(), String> {
    use std::io::Write;

    let client = api::ApiClient::from_settings()?;
    let terminal_id = resolve_default_panel(
        &client,
        terminal_id,
        "terminal.list",
        "terminals",
        "terminalId",
        "terminal session",
    )?;

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

fn handle_terminal_attach(terminal_id: Option<&str>, json_output: bool) -> i32 {
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
    let mut response = response;
    let status = response.status().as_u16();
    if status == 401 {
        eprintln!("error: Authentication failed. Check tokenSecret in settings");
        std::process::exit(1);
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
            .map_or_else(|| format!("server returned HTTP {status}"), str::to_string);
        eprintln!("error: {msg}");
        std::process::exit(1);
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
                        // The main thread may be blocked reading stdin, so end the process here.
                        std::process::exit(0);
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

fn cmd_terminal_attach(terminal_id: Option<&str>, json_output: bool) -> Result<(), String> {
    let client = api::ApiClient::from_settings()?;
    let terminal_id = resolve_default_panel(
        &client,
        terminal_id,
        "terminal.list",
        "terminals",
        "terminalId",
        "terminal session",
    )?;

    if !json_output {
        eprintln!("[attached to terminal {terminal_id} — type input, press Ctrl+C to detach]");
    }

    let tid = terminal_id.clone();
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

    // Detaching leaves the terminal running. The output thread may be waiting for the next chunk,
    // so it is left to end with the process instead of being joined.
    done.store(true, Ordering::Relaxed);
    drop(output_handle);

    Ok(())
}

// --- Cronjobs commands ---

fn cmd_cronjobs_list(repo: Option<&str>, worktree: Option<&str>) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;

    let mut input = serde_json::json!({});
    if let Some(p) = repo {
        input["repo"] = serde_json::json!(p);
    }
    if let Some(w) = worktree {
        input["worktreeId"] = serde_json::json!(w);
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
    worktree_id: Option<&str>,
    via: Option<&str>,
    disabled: bool,
) -> Result<CommandResult, String> {
    if scope != "repo" && scope != "worktree" {
        return Err("Scope must be 'repo' or 'worktree'".to_string());
    }
    if scope == "worktree" && worktree_id.is_none() {
        return Err("--worktree-id is required when scope is 'worktree'".to_string());
    }

    // Read settings once and share the snapshot between the API client (port +
    // auth token) and the dispatch-target resolver — same pattern as
    // `cmd_worktrees_create`. A cronjob always carries a prompt, so we always
    // resolve `via` through the precedence chain: a cron created from a chat
    // agent (BAND_DISPATCH=chat) defaults to chat, one from a terminal
    // (BAND_DISPATCH=terminal) defaults to terminal (issue #581).
    let settings = state::load_settings()?;
    let client = api::ApiClient::from_loaded_settings(settings.clone());
    let resolved_via = resolve_dispatch_target(via, &settings)?;

    let mut input = serde_json::json!({
        "key": key,
        "name": name,
        "prompt": prompt,
        "cronExpression": cron,
        "scope": scope,
        "via": resolved_via,
        "enabled": !disabled,
    });
    if let Some(ws) = worktree_id {
        input["worktreeId"] = serde_json::json!(ws);
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

    // The server echoes the dispatch it actually used (issue #581). A
    // via="terminal" job returns a `terminalId` (and no task/chat); a via="chat"
    // job — including a terminal job whose agent has no vendor CLI and fell back
    // — returns `taskId`/`chatId`.
    let worktree_id = data
        .get("worktreeId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let via = data.get("via").and_then(|v| v.as_str()).unwrap_or("chat");

    if via == "terminal" {
        let terminal_id = data
            .get("terminalId")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        return Ok(CommandResult {
            text: format!("{terminal_id}\n"),
            json: serde_json::json!({
                "via": "terminal",
                "terminalId": terminal_id,
                "worktreeId": worktree_id,
            }),
        });
    }

    let task_id = data.get("taskId").and_then(|v| v.as_str()).unwrap_or("");
    Ok(CommandResult {
        text: format!("{task_id}\n"),
        json: serde_json::json!({
            "via": "chat",
            "taskId": task_id,
            "worktreeId": worktree_id,
        }),
    })
}

// --- Subscriptions commands ---

const MS_PER_SECOND: u64 = 1000;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Parse `owner/repo#N`.
fn parse_pr_ref(value: &str) -> Result<(String, u64), String> {
    let invalid = || format!("Invalid --pr '{value}'. Use owner/repo#N, e.g. acme/api#12");
    let (repo, number) = value.split_once('#').ok_or_else(invalid)?;
    let number: u64 = number.parse().map_err(|_| invalid())?;
    if number == 0 || !repo.contains('/') || repo.starts_with('/') || repo.ends_with('/') {
        return Err(invalid());
    }
    Ok((repo.to_string(), number))
}

/// Parse `owner/repo@branch`.
fn parse_branch_ref(value: &str) -> Result<(String, String), String> {
    let invalid =
        || format!("Invalid --branch '{value}'. Use owner/repo@branch, e.g. acme/api@main");
    let (repo, branch) = value.split_once('@').ok_or_else(invalid)?;
    if branch.is_empty() || !repo.contains('/') || repo.starts_with('/') || repo.ends_with('/') {
        return Err(invalid());
    }
    Ok((repo.to_string(), branch.to_string()))
}

/// Parse `--at`: epoch milliseconds, or a delay (`90s`, `10m`, `2h`, `1d`) from `now`.
fn parse_at(value: &str, now: u64) -> Result<u64, String> {
    let invalid = || {
        format!(
            "Invalid --at '{value}'. Use epoch milliseconds or a delay such as 90s, 10m, 2h, 1d"
        )
    };
    if let Ok(ms) = value.parse::<u64>() {
        return Ok(ms);
    }
    let unit = value.chars().last().ok_or_else(invalid)?;
    let per_unit = match unit {
        's' => MS_PER_SECOND,
        'm' => 60 * MS_PER_SECOND,
        'h' => 3600 * MS_PER_SECOND,
        'd' => 86_400 * MS_PER_SECOND,
        _ => return Err(invalid()),
    };
    let amount: u64 = value[..value.len() - 1].parse().map_err(|_| invalid())?;
    if amount == 0 {
        return Err(invalid());
    }
    Ok(now.saturating_add(amount.saturating_mul(per_unit)))
}

/// The branch a pull request's head is on, from `gh` (`$BAND_GH_BIN` overrides the binary).
fn resolve_pr_branch(repo: &str, number: u64) -> Result<String, String> {
    let gh = std::env::var("BAND_GH_BIN").unwrap_or_else(|_| "gh".to_string());
    let output = std::process::Command::new(&gh)
        .args([
            "pr",
            "view",
            &number.to_string(),
            "-R",
            repo,
            "--json",
            "headRefName",
            "-q",
            ".headRefName",
        ])
        .output()
        .map_err(|e| {
            format!("--ci with --pr needs `gh` to look up the PR's branch ({e}). Use --branch {repo}@<branch> --ci instead")
        })?;
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() || branch.is_empty() {
        return Err(format!(
            "Could not look up the branch of {repo}#{number}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(branch)
}

/// `1d`, `3h`, `12m` from a millisecond span; `now` for anything under a minute.
fn format_span(ms: u64) -> String {
    const MINUTE: u64 = 60 * MS_PER_SECOND;
    if ms >= 86_400 * MS_PER_SECOND {
        format!("{}d", ms / (86_400 * MS_PER_SECOND))
    } else if ms >= 3600 * MS_PER_SECOND {
        format!("{}h", ms / (3600 * MS_PER_SECOND))
    } else if ms >= MINUTE {
        format!("{}m", ms / MINUTE)
    } else {
        "<1m".to_string()
    }
}

/// What a subscription watches, from its source and event key.
fn describe_subscription(sub: &serde_json::Value) -> String {
    let source = sub.get("source").and_then(|v| v.as_str()).unwrap_or("");
    let key = sub.get("filterKey").and_then(|v| v.as_str()).unwrap_or("");
    match source {
        "github" => {
            if let Some(pr) = key.strip_prefix("github:pr:") {
                format!("PR {pr}")
            } else if let Some(ci) = key.strip_prefix("github:ci:") {
                format!("CI on {ci}")
            } else {
                key.to_string()
            }
        }
        "timer" => {
            if let Some(cron) = sub.get("cron").and_then(|v| v.as_str()) {
                format!("cron {cron}")
            } else if let Some(at) = sub.get("at").and_then(serde_json::Value::as_u64) {
                let now = now_ms();
                if at > now {
                    format!("once, in {}", format_span(at - now))
                } else {
                    "once, due now".to_string()
                }
            } else {
                key.to_string()
            }
        }
        "webhook" => {
            let id = sub.get("id").and_then(|v| v.as_str()).unwrap_or("");
            format!("/api/hooks/{id}")
        }
        _ => key.to_string(),
    }
}

fn cmd_subscriptions_list(
    chat: Option<&str>,
    worktree: Option<&str>,
) -> Result<CommandResult, String> {
    if chat.is_none() && worktree.is_none() {
        return Err(
            "A chat is required. Pass --chat <id> or --worktree <id>, or run inside an agent chat ($BAND_CHAT_ID)"
                .to_string(),
        );
    }
    let client = api::ApiClient::from_settings()?;
    let mut input = serde_json::json!({});
    if let Some(w) = worktree {
        input["worktreeId"] = serde_json::json!(w);
    } else if let Some(c) = chat {
        input["chatId"] = serde_json::json!(c);
    }
    let data = client.trpc_query("subscriptions.list", &input)?;
    let subs = data.as_array().cloned().unwrap_or_default();

    let now = now_ms();
    let rows: Vec<[String; 5]> = subs
        .iter()
        .map(|sub| {
            let text = |key: &str| sub.get(key).and_then(|v| v.as_str()).unwrap_or("");
            let num = |key: &str| {
                sub.get(key)
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0)
            };
            let expires_at = num("expiresAt");
            [
                text("id").to_string(),
                text("source").to_string(),
                describe_subscription(sub),
                format!("{}/{}", num("wakeups"), num("maxWakeups")),
                if expires_at > now {
                    format!("in {}", format_span(expires_at - now))
                } else {
                    "expired".to_string()
                },
            ]
        })
        .collect();

    Ok(CommandResult {
        text: format_table(&["ID", "SOURCE", "WATCHES", "WAKEUPS", "EXPIRES"], &rows),
        json: serde_json::json!({"subscriptions": subs}),
    })
}

/// The flags of `band subscriptions create`.
#[allow(clippy::struct_excessive_bools)]
struct SubscriptionSpec {
    chat: Option<String>,
    worktree: Option<String>,
    pr: Option<String>,
    branch: Option<String>,
    reviews: bool,
    comments: bool,
    ci: bool,
    webhook: bool,
    cron: Option<String>,
    at: Option<String>,
    max_wakeups: Option<u32>,
    coalesce: Option<u32>,
}

/// The `subscriptions.create` inputs a `create` call stands for, without the
/// chat and limits. One `--pr` can mean two subscriptions (PR activity and CI).
fn subscription_sources(
    spec: &SubscriptionSpec,
    now: u64,
) -> Result<Vec<serde_json::Value>, String> {
    let chosen = [
        spec.pr.is_some(),
        spec.branch.is_some(),
        spec.webhook,
        spec.cron.is_some(),
        spec.at.is_some(),
    ]
    .iter()
    .filter(|set| **set)
    .count();
    if chosen != 1 {
        return Err("Pick exactly one of --pr, --branch, --webhook, --cron and --at".to_string());
    }
    if spec.pr.is_none() && (spec.reviews || spec.comments) {
        return Err("--reviews and --comments apply to --pr only".to_string());
    }
    if spec.pr.is_none() && spec.branch.is_none() && spec.ci {
        return Err("--ci applies to --pr and --branch only".to_string());
    }

    if let Some(pr) = &spec.pr {
        let (repo, number) = parse_pr_ref(pr)?;
        let mut sources = Vec::new();
        // PR activity is one subscription: reviews and comments arrive together.
        if spec.reviews || spec.comments || !spec.ci {
            sources.push(serde_json::json!({"source": "github", "repo": repo, "pr": number}));
        }
        if spec.ci {
            let branch = resolve_pr_branch(&repo, number)?;
            sources.push(serde_json::json!({"source": "github", "repo": repo, "branch": branch}));
        }
        return Ok(sources);
    }
    if let Some(branch) = &spec.branch {
        let (repo, branch) = parse_branch_ref(branch)?;
        return Ok(vec![
            serde_json::json!({"source": "github", "repo": repo, "branch": branch}),
        ]);
    }
    if spec.webhook {
        return Ok(vec![serde_json::json!({"source": "webhook"})]);
    }
    if let Some(cron) = &spec.cron {
        return Ok(vec![serde_json::json!({"source": "timer", "cron": cron})]);
    }
    let at = parse_at(spec.at.as_deref().unwrap_or(""), now)?;
    Ok(vec![serde_json::json!({"source": "timer", "at": at})])
}

fn cmd_subscriptions_create(spec: &SubscriptionSpec) -> Result<CommandResult, String> {
    let Some(chat) = spec.chat.as_deref() else {
        return Err(
            "A chat is required. Pass --chat <id>, or run inside an agent chat ($BAND_CHAT_ID)"
                .to_string(),
        );
    };
    let sources = subscription_sources(spec, now_ms())?;

    let client = api::ApiClient::from_settings()?;
    let mut created: Vec<serde_json::Value> = Vec::new();
    for mut input in sources {
        input["chatId"] = serde_json::json!(chat);
        input["createdBy"] = serde_json::json!("agent");
        if let Some(w) = &spec.worktree {
            input["worktreeId"] = serde_json::json!(w);
        }
        if let Some(n) = spec.max_wakeups {
            input["maxWakeups"] = serde_json::json!(n);
        }
        if let Some(c) = spec.coalesce {
            input["coalesceSeconds"] = serde_json::json!(c);
        }
        match client.trpc_mutate("subscriptions.create", &input) {
            Ok(sub) => created.push(sub),
            Err(err) => {
                // Don't leave half of a `--pr ... --ci` behind.
                for sub in &created {
                    if let Some(id) = sub.get("id").and_then(|v| v.as_str()) {
                        let _ = client
                            .trpc_mutate("subscriptions.remove", &serde_json::json!({"id": id}));
                    }
                }
                return Err(err);
            }
        }
    }

    let mut text = String::new();
    for sub in &created {
        let id = sub.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let _ = writeln!(text, "{id}\t{}", describe_subscription(sub));
        if let Some(hook) = sub.get("webhook").filter(|h| h.get("token").is_some()) {
            let path = hook.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let token = hook.get("token").and_then(|v| v.as_str()).unwrap_or("");
            let _ = writeln!(
                text,
                "  POST {path} with header X-Band-Webhook-Token: {token}\n  The token is shown once."
            );
        }
        if let Some(status) = sub
            .get("webhook")
            .and_then(|h| h.get("status"))
            .and_then(|v| v.as_str())
            .filter(|s| *s != "registered")
        {
            let _ = writeln!(text, "  GitHub webhook: {status}");
        }
    }

    Ok(CommandResult {
        text,
        json: serde_json::json!({"subscriptions": created}),
    })
}

fn cmd_subscriptions_remove(id: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    client.trpc_mutate("subscriptions.remove", &serde_json::json!({"id": id}))?;
    Ok(CommandResult {
        text: format!("Subscription {id} removed\n"),
        json: serde_json::json!({"ok": true, "id": id}),
    })
}

// --- Hosts commands ---

fn cmd_hosts_list() -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_query("hosts.list", &serde_json::json!({}))?;
    let hosts = data
        .get("hosts")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let rows: Vec<[String; 7]> = hosts
        .iter()
        .map(|host| {
            let text = |key: &str| host.get(key).and_then(|v| v.as_str()).unwrap_or("");
            let labels = host
                .get("labels")
                .and_then(|v| v.as_array())
                .map(|l| {
                    l.iter()
                        .filter_map(|x| x.as_str())
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .unwrap_or_default();
            let last_seen = host
                .get("lastSeenAt")
                .and_then(serde_json::Value::as_u64)
                .map_or_else(
                    || "never".to_string(),
                    |at| format!("{} ago", format_span(now_ms().saturating_sub(at))),
                );
            let list = |key: &str| {
                host.get(key)
                    .and_then(|v| v.as_array())
                    .map(|l| {
                        l.iter()
                            .filter_map(|x| x.as_str())
                            .collect::<Vec<_>>()
                            .join(",")
                    })
                    .filter(|joined| !joined.is_empty())
                    .unwrap_or_else(|| "-".to_string())
            };
            [
                text("id").to_string(),
                text("name").to_string(),
                text("status").to_string(),
                labels,
                list("agents"),
                list("roots"),
                last_seen,
            ]
        })
        .collect();

    Ok(CommandResult {
        text: format_table(
            &[
                "ID",
                "NAME",
                "STATUS",
                "LABELS",
                "AGENTS",
                "ROOTS",
                "LAST SEEN",
            ],
            &rows,
        ),
        json: serde_json::json!({"hosts": hosts}),
    })
}

fn cmd_hosts_remove(id: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    client.trpc_mutate("hosts.remove", &serde_json::json!({"hostId": id}))?;
    Ok(CommandResult {
        text: format!("Host {id} removed\n"),
        json: serde_json::json!({"ok": true, "id": id}),
    })
}

// --- Runners commands ---

fn cmd_runners_list() -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_query("runners.list", &serde_json::json!({}))?;
    let runners = data
        .get("runners")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let errors = data
        .get("errors")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let rows: Vec<[String; 5]> = runners
        .iter()
        .map(|runner| {
            let text = |key: &str| runner.get(key).and_then(|v| v.as_str()).unwrap_or("");
            let number = |key: &str| {
                runner
                    .get(key)
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0)
            };
            let labels = runner
                .get("labels")
                .and_then(|v| v.as_object())
                .map(|l| {
                    l.iter()
                        .map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or("")))
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .filter(|joined| !joined.is_empty())
                .unwrap_or_else(|| "-".to_string());
            [
                text("id").to_string(),
                text("spawn").to_string(),
                labels,
                format!("{}/{}", number("running"), number("maxConcurrent")),
                format!("{}s", number("timeoutSec")),
            ]
        })
        .collect();

    let mut text = format_table(&["ID", "SPAWN", "LABELS", "RUNNING", "TIMEOUT"], &rows);
    for error in &errors {
        text.extend(["Invalid runner: ", error.as_str().unwrap_or(""), "\n"]);
    }
    Ok(CommandResult { text, json: data })
}

fn cmd_runners_log(request_id: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_query("runners.log", &serde_json::json!({"requestId": request_id}))?;
    let log = data.get("log").and_then(|v| v.as_str());
    match log {
        Some(log) => Ok(CommandResult {
            text: if log.ends_with('\n') {
                log.to_string()
            } else {
                format!("{log}\n")
            },
            json: data,
        }),
        None => Err(format!("No runner log for request {request_id}")),
    }
}

// --- Env commands ---

/// Ask the hub to validate the environment file under `path`. Prints OK, or
/// each problem as `<path>: <message>`, and returns the exit code: 0 when the
/// file is valid, 1 when it has problems or does not exist.
fn handle_env_validate(path: Option<&str>, json_output: bool) -> i32 {
    match cmd_env_validate(path) {
        Ok((ok, text, json)) => {
            if json_output {
                println!("{}", serde_json::to_string(&json).unwrap());
            } else if ok {
                print!("{text}");
            } else {
                eprint!("{text}");
            }
            i32::from(!ok)
        }
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

fn cmd_env_validate(path: Option<&str>) -> Result<(bool, String, serde_json::Value), String> {
    let given = path.unwrap_or(".");
    validate::validate_path(given, "path")?;
    let absolute = std::fs::canonicalize(given)
        .map_err(|e| format!("Cannot read {given}: {e}"))?
        .to_string_lossy()
        .into_owned();
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_query(
        "environment.validate",
        &serde_json::json!({"path": absolute}),
    )?;

    let source = data.get("source").and_then(|v| v.as_str());
    let issues = data
        .get("issues")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let Some(source) = source else {
        let text = format!("No .band/environment.json found in {absolute}\n");
        let json = serde_json::json!({"ok": false, "source": null, "issues": []});
        return Ok((false, text, json));
    };

    let ok = issues.is_empty();
    let text = if ok {
        format!("OK {source}\n")
    } else {
        use std::fmt::Write as _;
        let mut text = format!(
            "{source} has {} problem{}:\n",
            issues.len(),
            if issues.len() == 1 { "" } else { "s" }
        );
        for issue in &issues {
            let issue_path = issue.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let message = issue.get("message").and_then(|v| v.as_str()).unwrap_or("");
            if issue_path.is_empty() {
                let _ = writeln!(text, "  {message}");
            } else {
                let _ = writeln!(text, "  {issue_path}: {message}");
            }
        }
        text
    };
    let json = serde_json::json!({"ok": ok, "source": source, "issues": issues});
    Ok((ok, text, json))
}

/// Prints a build's one-line summary, e.g. `ready band-env/api:0123abcd (key 0123abcd)`.
fn env_build_summary(build: &serde_json::Value) -> String {
    let text = |key: &str| build.get(key).and_then(|v| v.as_str()).unwrap_or("");
    let status = text("status");
    let key: String = text("key").chars().take(12).collect();
    match status {
        "ready" => format!("ready {} (key {key})", text("image")),
        "failed" => format!("failed (key {key}): {}", text("error")),
        _ => format!("{status} (key {key})"),
    }
}

/// The log of the latest build, or an empty string.
fn env_latest_log(status: &serde_json::Value) -> String {
    status
        .get("latest")
        .and_then(|l| l.get("log"))
        .and_then(|l| l.as_str())
        .unwrap_or("")
        .to_string()
}

/// Start a build (or find it cached or running) and, unless `no_wait`, follow
/// its log until it ends. Exit code 0 for a ready image, 1 for a failure.
fn handle_env_build(repo: &str, force: bool, no_wait: bool, json_output: bool) -> i32 {
    match cmd_env_build(repo, force, no_wait, json_output) {
        Ok(code) => code,
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

fn cmd_env_build(repo: &str, force: bool, no_wait: bool, json_output: bool) -> Result<i32, String> {
    let client = api::ApiClient::from_settings()?;
    let started = client.trpc_mutate(
        "environment.build",
        &serde_json::json!({"repoName": repo, "force": force}),
    )?;
    let build = started.get("build").cloned().unwrap_or_default();
    let cache_hit = started
        .get("cacheHit")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let build_id = build
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if cache_hit && !json_output {
        println!("Cache hit: {}", env_build_summary(&build));
    }
    if cache_hit || (no_wait && build.get("status").and_then(|v| v.as_str()) != Some("failed")) {
        if json_output {
            println!(
                "{}",
                serde_json::to_string(&serde_json::json!({
                    "cacheHit": cache_hit,
                    "build": build,
                }))
                .unwrap()
            );
        } else if !cache_hit {
            println!("Build started: {}", env_build_summary(&build));
        }
        return Ok(0);
    }

    // Follow the build: print the log as it grows.
    let mut printed = 0usize;
    loop {
        let status = client.trpc_query(
            "environment.imageStatus",
            &serde_json::json!({"repoName": repo}),
        )?;
        let latest = status.get("latest").cloned().unwrap_or_default();
        let same_build = latest.get("id").and_then(|v| v.as_str()) == Some(build_id.as_str());
        if !same_build {
            return Err("The build disappeared from the build list".to_string());
        }
        let log = env_latest_log(&status);
        if !json_output {
            // The hub drops the head of a log past its cap, which shifts
            // every offset. Resync to the end instead of printing garbage.
            let dropped = printed > 0 && log.starts_with("[earlier output dropped]");
            if dropped || log.len() < printed {
                println!("\n[log truncated by the hub]");
                printed = log.len();
            } else if log.len() > printed {
                if let Some(rest) = log.get(printed..) {
                    print!("{rest}");
                    printed = log.len();
                } else {
                    printed = log.len();
                }
            }
        }
        let state = latest.get("status").and_then(|v| v.as_str()).unwrap_or("");
        if state != "building" {
            if json_output {
                println!(
                    "{}",
                    serde_json::to_string(&serde_json::json!({
                        "cacheHit": false,
                        "build": latest,
                    }))
                    .unwrap()
                );
            } else {
                println!("{}", env_build_summary(&latest));
            }
            return Ok(i32::from(state != "ready"));
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
}

fn handle_env_status(repo: &str, json_output: bool) -> i32 {
    let result = api::ApiClient::from_settings().and_then(|client| {
        client.trpc_query(
            "environment.imageStatus",
            &serde_json::json!({"repoName": repo}),
        )
    });
    match result {
        Ok(status) => {
            if json_output {
                println!("{}", serde_json::to_string(&status).unwrap());
                return 0;
            }
            match status.get("current").filter(|c| !c.is_null()) {
                Some(current) => println!("Current image: {}", env_build_summary(current)),
                None => println!("Current image: none (no build has finished)"),
            }
            if let Some(latest) = status.get("latest").filter(|l| !l.is_null()) {
                println!("Latest build: {}", env_build_summary(latest));
                let log = env_latest_log(&status);
                if !log.is_empty() {
                    println!("\n{log}");
                }
            }
            0
        }
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

// --- Tokens commands ---

fn cmd_tokens_list() -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_query("tokens.list", &serde_json::json!({}))?;
    let tokens = data
        .get("tokens")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let rows: Vec<[String; 5]> = tokens
        .iter()
        .map(|token| {
            let text = |key: &str| token.get(key).and_then(|v| v.as_str()).unwrap_or("");
            let last_used = token
                .get("lastUsedAt")
                .and_then(serde_json::Value::as_u64)
                .map_or_else(
                    || "never".to_string(),
                    |at| format!("{} ago", format_span(now_ms().saturating_sub(at))),
                );
            [
                text("id").to_string(),
                text("kind").to_string(),
                text("label").to_string(),
                text("state").to_string(),
                last_used,
            ]
        })
        .collect();

    Ok(CommandResult {
        text: format_table(&["ID", "KIND", "LABEL", "STATE", "LAST USED"], &rows),
        json: serde_json::json!({"tokens": tokens}),
    })
}

fn cmd_tokens_create_device(label: &str, admin: bool) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_mutate(
        "tokens.createDevice",
        &serde_json::json!({"label": label, "admin": admin}),
    )?;
    let token = data
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or("The hub returned no token")?;
    let id = data
        .pointer("/view/id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let kind = if admin { "admin device" } else { "device" };
    Ok(CommandResult {
        text: format!(
            "{kind} token {id} created for \"{label}\"\nToken: {token}\nThis is the only time the token is shown.\n"
        ),
        json: serde_json::json!({"id": id, "label": label, "admin": admin, "token": token}),
    })
}

fn cmd_tokens_revoke(id: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    client.trpc_mutate("tokens.revoke", &serde_json::json!({"tokenId": id}))?;
    Ok(CommandResult {
        text: format!("Token {id} revoked\n"),
        json: serde_json::json!({"ok": true, "id": id}),
    })
}

// --- Vault commands ---

fn cmd_vault_list() -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_query("vault.list", &serde_json::json!({}))?;
    let items = data
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let rows: Vec<[String; 5]> = items
        .iter()
        .map(|item| {
            let text = |key: &str| item.get(key).and_then(|v| v.as_str()).unwrap_or("");
            let last_used = item
                .get("lastUsedAt")
                .and_then(serde_json::Value::as_u64)
                .map_or_else(
                    || "never".to_string(),
                    |at| format!("{} ago", format_span(now_ms().saturating_sub(at))),
                );
            [
                text("id").to_string(),
                text("name").to_string(),
                text("kind").to_string(),
                text("scope").to_string(),
                last_used,
            ]
        })
        .collect();
    Ok(CommandResult {
        text: format_table(&["ID", "NAME", "KIND", "SCOPE", "LAST USED"], &rows),
        json: serde_json::json!({"items": items}),
    })
}

/// Where a `git` credential applies, from `band vault put --kind git`.
struct GitTarget<'a> {
    host: Option<&'a str>,
    path: Option<&'a str>,
    username: Option<&'a str>,
}

fn cmd_vault_put(
    name: &str,
    kind: &str,
    scope: &str,
    description: Option<&str>,
    value: Option<String>,
    git: &GitTarget,
) -> Result<CommandResult, String> {
    if kind == "git" && (git.host.is_none() || git.path.is_none()) {
        return Err(
            "A git credential needs --host (such as github.com) and --path (such as 'owner/*')."
                .to_string(),
        );
    }
    if kind != "git" && (git.host.is_some() || git.path.is_some() || git.username.is_some()) {
        return Err("--host, --path and --username apply only to --kind git.".to_string());
    }
    let value = if let Some(v) = value {
        v
    } else {
        let mut buf = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf)
            .map_err(|e| format!("Could not read the value from stdin: {e}"))?;
        buf.trim_end_matches(['\n', '\r']).to_string()
    };
    if value.is_empty() {
        return Err("The value is empty. Pipe it on stdin or pass --value.".to_string());
    }
    let client = api::ApiClient::from_settings()?;
    let mut body = serde_json::json!({"name": name, "kind": kind, "scope": scope, "value": value});
    if let Some(d) = description {
        body["description"] = serde_json::json!(d);
    }
    if let Some(h) = git.host {
        body["host"] = serde_json::json!(h);
    }
    if let Some(p) = git.path {
        body["pathPattern"] = serde_json::json!(p);
    }
    if let Some(u) = git.username {
        body["username"] = serde_json::json!(u);
    }
    let data = client.trpc_mutate("vault.put", &body)?;
    let id = data
        .pointer("/item/id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    Ok(CommandResult {
        text: format!("Stored {name} ({kind}, {scope}) as {id}\n"),
        json: serde_json::json!({"item": data.get("item")}),
    })
}

fn cmd_vault_delete(id: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_mutate("vault.delete", &serde_json::json!({"id": id}))?;
    let revoked = data.get("revoked").and_then(serde_json::Value::as_bool);
    let note = match revoked {
        Some(true) => ", token revoked at the server",
        Some(false) => ", the server did not confirm the revocation",
        None => "",
    };
    Ok(CommandResult {
        text: format!("Deleted {id}{note}\n"),
        json: serde_json::json!({"removed": true, "id": id, "revoked": revoked}),
    })
}

fn cmd_vault_rotate_key() -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_mutate("vault.rotateKey", &serde_json::json!({}))?;
    let rotated = data
        .get("rotated")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    Ok(CommandResult {
        text: format!("Re-encrypted {rotated} credential(s) under a new key\n"),
        json: serde_json::json!({"rotated": rotated}),
    })
}

// --- MCP proxy commands ---

fn split_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .collect()
}

fn cmd_mcp_list() -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_query("mcp.list", &serde_json::json!({}))?;
    let servers = data
        .get("servers")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let rows: Vec<[String; 5]> = servers
        .iter()
        .map(|server| {
            let text = |key: &str| server.get(key).and_then(|v| v.as_str()).unwrap_or("");
            let tools = match server.get("allowTools").and_then(|v| v.as_array()) {
                Some(list) => format!("{} allowed", list.len()),
                None => "all".to_string(),
            };
            let mut mode =
                if server.get("readOnly").and_then(serde_json::Value::as_bool) == Some(true) {
                    "read-only".to_string()
                } else {
                    "read-write".to_string()
                };
            if server.get("enabled").and_then(serde_json::Value::as_bool) == Some(false) {
                mode.push_str(", disabled");
            }
            [
                text("name").to_string(),
                text("url").to_string(),
                if server.get("vaultItemId").is_some_and(|v| !v.is_null()) {
                    "vault".to_string()
                } else {
                    "none".to_string()
                },
                tools,
                mode,
            ]
        })
        .collect();
    Ok(CommandResult {
        text: format_table(&["NAME", "URL", "CREDENTIAL", "TOOLS", "MODE"], &rows),
        json: serde_json::json!({"servers": servers}),
    })
}

#[allow(clippy::too_many_arguments)]
fn cmd_mcp_add(
    name: &str,
    url: &str,
    vault_item: Option<&str>,
    header: Option<&str>,
    prefix: Option<&str>,
    allow_tools: Option<&str>,
    read_only: bool,
    read_only_tools: Option<&str>,
    disabled: bool,
) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let mut body = serde_json::json!({"name": name, "url": url, "readOnly": read_only});
    if let Some(v) = vault_item {
        body["vaultItemId"] = serde_json::json!(v);
    }
    if let Some(v) = header {
        body["headerName"] = serde_json::json!(v);
    }
    if let Some(v) = prefix {
        body["headerPrefix"] = serde_json::json!(v);
    }
    if let Some(v) = allow_tools {
        body["allowTools"] = serde_json::json!(split_list(v));
    }
    if let Some(v) = read_only_tools {
        body["readOnlyTools"] = serde_json::json!(split_list(v));
    }
    if disabled {
        body["enabled"] = serde_json::json!(false);
    }
    let data = client.trpc_mutate("mcp.add", &body)?;
    Ok(CommandResult {
        text: format!("Added MCP server {name}, proxied at /mcp-proxy/{name}\n"),
        json: serde_json::json!({"server": data.get("server")}),
    })
}

fn cmd_context_list() -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_query("context.list", &serde_json::json!({}))?;
    let contexts = data
        .get("contexts")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let rows: Vec<[String; 5]> = contexts
        .iter()
        .map(|c| {
            let text = |key: &str| c.get(key).and_then(|v| v.as_str()).unwrap_or("");
            let labels = c
                .get("labels")
                .and_then(|v| v.as_array())
                .map(|l| {
                    l.iter()
                        .filter_map(|v| v.as_str())
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .unwrap_or_default();
            let sync = match c.get("syncError").and_then(|v| v.as_str()) {
                Some(e) => format!("error: {e}"),
                None if c.get("remoteUrl").is_some_and(|v| !v.is_null()) => "ok".to_string(),
                None => "-".to_string(),
            };
            [
                text("name").to_string(),
                text("kind").to_string(),
                if text("remoteUrl").is_empty() {
                    "-".to_string()
                } else {
                    text("remoteUrl").to_string()
                },
                if labels.is_empty() {
                    "any".to_string()
                } else {
                    labels
                },
                sync,
            ]
        })
        .collect();
    Ok(CommandResult {
        text: format_table(&["NAME", "KIND", "REMOTE", "LABELS", "SYNC"], &rows),
        json: serde_json::json!({"contexts": contexts}),
    })
}

fn cmd_context_create(
    name: &str,
    remote: Option<&str>,
    vault_item: Option<&str>,
    labels: Option<&str>,
    read_only: bool,
) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let mut body = serde_json::json!({"name": name});
    if let Some(v) = remote {
        body["remoteUrl"] = serde_json::json!(v);
    }
    if let Some(v) = vault_item {
        body["remoteVaultItemId"] = serde_json::json!(v);
    }
    if let Some(v) = labels {
        body["labels"] = serde_json::json!(split_list(v));
    }
    if read_only {
        body["workerAccess"] = serde_json::json!("read-only");
    }
    let data = client.trpc_mutate("context.create", &body)?;
    Ok(CommandResult {
        text: format!("Created context {name}, served at /git/context/{name}.git\n"),
        json: serde_json::json!({"context": data.get("context")}),
    })
}

fn cmd_context_remove(name: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    client.trpc_mutate("context.remove", &serde_json::json!({"name": name}))?;
    Ok(CommandResult {
        text: format!("Removed context {name}\n"),
        json: serde_json::json!({"removed": true, "name": name}),
    })
}

fn cmd_context_link_remote(
    name: &str,
    remote: Option<&str>,
    vault_item: Option<&str>,
    unlink: bool,
) -> Result<CommandResult, String> {
    if unlink == remote.is_some() {
        return Err("Pass either a remote URL or --unlink".to_string());
    }
    let client = api::ApiClient::from_settings()?;
    let mut body = serde_json::json!({"name": name, "remoteUrl": remote});
    if let Some(v) = vault_item {
        body["vaultItemId"] = serde_json::json!(v);
    }
    let data = client.trpc_mutate("context.linkRemote", &body)?;
    let text = match remote {
        Some(url) => format!("Linked context {name} to {url} and mirrored it\n"),
        None => format!("Unlinked context {name} from its remote\n"),
    };
    Ok(CommandResult {
        text,
        json: serde_json::json!({"context": data.get("context")}),
    })
}

fn project_repos_text(project: &serde_json::Value) -> String {
    project
        .get("repos")
        .and_then(|v| v.as_array())
        .map(|repos| {
            repos
                .iter()
                .filter_map(|r| {
                    let name = r.get("repo")?.as_str()?;
                    match r.get("role").and_then(|v| v.as_str()) {
                        Some(role) => Some(format!("{name}:{role}")),
                        None => Some(name.to_string()),
                    }
                })
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default()
}

#[allow(clippy::too_many_arguments)]
fn cmd_tasks_create(
    project: &str,
    branch: &str,
    repos: &[String],
    brief: Option<&str>,
    name: Option<&str>,
    title: Option<&str>,
    host: Option<&str>,
    labels: Option<&str>,
    agent: Option<&str>,
    model: Option<&str>,
    no_start: bool,
) -> Result<CommandResult, String> {
    use std::fmt::Write as _;
    let client = api::ApiClient::from_settings()?;
    let mut body = serde_json::json!({"project": project, "branch": branch});
    if !repos.is_empty() {
        let list: Vec<serde_json::Value> = repos
            .iter()
            .map(|spec| match spec.split_once(':') {
                Some((repo, role)) => serde_json::json!({"repo": repo, "role": role}),
                None => serde_json::json!({"repo": spec}),
            })
            .collect();
        body["repos"] = serde_json::json!(list);
    }
    if let Some(path) = brief {
        let text = std::fs::read_to_string(path)
            .map_err(|e| format!("Could not read the brief {path}: {e}"))?;
        body["brief"] = serde_json::json!(text);
    }
    if let Some(v) = name {
        body["name"] = serde_json::json!(v);
    }
    if let Some(v) = title {
        body["title"] = serde_json::json!(v);
    }
    if let Some(v) = host {
        body["hostId"] = serde_json::json!(v);
    }
    if let Some(v) = labels {
        let mut map = serde_json::Map::new();
        for pair in split_list(v) {
            let (k, val) = pair
                .split_once('=')
                .ok_or_else(|| format!("Label {pair} is not key=value"))?;
            map.insert(k.to_string(), serde_json::json!(val));
        }
        body["placement"] = serde_json::json!({"labels": map});
    }
    if let Some(v) = agent {
        body["codingAgentId"] = serde_json::json!(v);
    }
    if let Some(v) = model {
        body["model"] = serde_json::json!(v);
    }
    if no_start {
        body["start"] = serde_json::json!(false);
    }
    let data = client.trpc_mutate("projectTasks.create", &body)?;
    let task = data.get("task").cloned().unwrap_or_default();
    let text = |key: &str| task.get(key).and_then(|v| v.as_str()).unwrap_or("");
    let mut out = format!(
        "Created task {} ({}) on host {}\n  folder: {}\n",
        text("name"),
        text("id"),
        text("hostId"),
        text("folder"),
    );
    for m in task
        .get("members")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        let _ = writeln!(
            out,
            "  repo {}: {}",
            m.get("repo").and_then(|v| v.as_str()).unwrap_or(""),
            m.get("path").and_then(|v| v.as_str()).unwrap_or("")
        );
    }
    Ok(CommandResult {
        text: out,
        json: serde_json::json!({"task": task, "chatId": data.get("chatId")}),
    })
}

fn cmd_tasks_list(project: Option<&str>) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let names: Vec<String> = match project {
        Some(p) => vec![p.to_string()],
        None => client
            .trpc_query_no_input("projects.list")?
            .get("projects")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
            .filter_map(|p| p.get("id").and_then(|v| v.as_str()).map(str::to_string))
            .collect(),
    };
    let mut tasks: Vec<serde_json::Value> = Vec::new();
    let mut rows: Vec<[String; 5]> = Vec::new();
    for name in &names {
        let data = client.trpc_query("projectTasks.list", &serde_json::json!({"project": name}))?;
        for t in data
            .get("tasks")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            let text = |key: &str| {
                t.get(key)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            let repos: Vec<String> = t
                .get("members")
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
                .filter_map(|m| m.get("repo").and_then(|v| v.as_str()).map(str::to_string))
                .collect();
            rows.push([
                text("name"),
                text("project"),
                text("branch"),
                text("hostId"),
                repos.join(","),
            ]);
            tasks.push(t.clone());
        }
    }
    Ok(CommandResult {
        text: format_table(&["NAME", "PROJECT", "BRANCH", "HOST", "REPOS"], &rows),
        json: serde_json::json!({"tasks": tasks}),
    })
}

fn cmd_tasks_add_repo(
    task: &str,
    repo: &str,
    role: Option<&str>,
    project: Option<&str>,
) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let mut body = serde_json::json!({"task": task, "repo": repo});
    if let Some(v) = role {
        body["role"] = serde_json::json!(v);
    }
    if let Some(v) = project {
        body["project"] = serde_json::json!(v);
    }
    let data = client.trpc_mutate("projectTasks.addRepo", &body)?;
    let member = data.get("member").cloned().unwrap_or_default();
    Ok(CommandResult {
        text: format!(
            "Added repo {repo} to task {task}: {}\n",
            member.get("path").and_then(|v| v.as_str()).unwrap_or("")
        ),
        json: serde_json::json!({"member": member}),
    })
}

fn cmd_tasks_remove_repo(
    task: &str,
    repo: &str,
    project: Option<&str>,
) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let mut body = serde_json::json!({"task": task, "repo": repo});
    if let Some(v) = project {
        body["project"] = serde_json::json!(v);
    }
    client.trpc_mutate("projectTasks.removeRepo", &body)?;
    Ok(CommandResult {
        text: format!("Removed repo {repo} from task {task}\n"),
        json: serde_json::json!({"removed": true, "task": task, "repo": repo}),
    })
}

fn cmd_tasks_remove(
    task: &str,
    project: Option<&str>,
    force: bool,
) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let mut body = serde_json::json!({"task": task});
    if let Some(v) = project {
        body["project"] = serde_json::json!(v);
    }
    if force {
        body["force"] = serde_json::json!(true);
    }
    client.trpc_mutate("projectTasks.remove", &body)?;
    Ok(CommandResult {
        text: format!("Removed task {task}\n"),
        json: serde_json::json!({"removed": true, "task": task}),
    })
}

fn cmd_projects_list() -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_query_no_input("projects.list")?;
    let projects = data
        .get("projects")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let rows: Vec<[String; 5]> = projects
        .iter()
        .map(|p| {
            let text = |key: &str| p.get(key).and_then(|v| v.as_str()).unwrap_or("");
            let repos = project_repos_text(p);
            let worktrees = p
                .get("worktrees")
                .and_then(|v| v.as_array())
                .map_or(0, Vec::len);
            [
                text("name").to_string(),
                if repos.is_empty() {
                    "-".to_string()
                } else {
                    repos
                },
                text("coordinatorModel").to_string(),
                text("contextName").to_string(),
                worktrees.to_string(),
            ]
        })
        .collect();
    Ok(CommandResult {
        text: format_table(&["NAME", "REPOS", "MODEL", "CONTEXT", "WORKTREES"], &rows),
        json: serde_json::json!({"projects": projects}),
    })
}

fn cmd_projects_get(project: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_query("projects.get", &serde_json::json!({"project": project}))?;
    let p = data.get("project").cloned().unwrap_or_default();
    let text = |key: &str| p.get(key).and_then(|v| v.as_str()).unwrap_or("");
    let mut out = format!(
        "{}\n  id: {}\n  context: {}\n  coordinator: {}{}\n  repos: {}\n",
        text("name"),
        text("id"),
        text("contextName"),
        text("coordinatorModel"),
        match p.get("coordinatorAgent").and_then(|v| v.as_str()) {
            Some(a) => format!(" ({a})"),
            None => String::new(),
        },
        project_repos_text(&p),
    );
    if !text("description").is_empty() {
        out.push_str("  description: ");
        out.push_str(text("description"));
        out.push('\n');
    }
    for w in p
        .get("worktrees")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        out.push_str("  worktree: ");
        out.push_str(w.get("worktreeId").and_then(|v| v.as_str()).unwrap_or(""));
        out.push('\n');
    }
    Ok(CommandResult {
        text: out,
        json: serde_json::json!({"project": p}),
    })
}

#[allow(clippy::too_many_arguments)]
fn cmd_projects_create(
    name: &str,
    description: Option<&str>,
    repos: &[String],
    context: Option<&str>,
    remote_url: Option<&str>,
    remote_vault_item: Option<&str>,
    model: Option<&str>,
    agent: Option<&str>,
    labels: Option<&str>,
) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let mut body = serde_json::json!({"name": name});
    if let Some(v) = description {
        body["description"] = serde_json::json!(v);
    }
    if !repos.is_empty() {
        let list: Vec<serde_json::Value> = repos
            .iter()
            .map(|spec| match spec.split_once(':') {
                Some((repo, role)) => serde_json::json!({"repo": repo, "role": role}),
                None => serde_json::json!({"repo": spec}),
            })
            .collect();
        body["repos"] = serde_json::json!(list);
    }
    if let Some(v) = context {
        body["contextName"] = serde_json::json!(v);
    }
    if let Some(v) = remote_url {
        body["remoteUrl"] = serde_json::json!(v);
    }
    if let Some(v) = remote_vault_item {
        body["remoteVaultItemId"] = serde_json::json!(v);
    }
    if let Some(v) = model {
        body["coordinatorModel"] = serde_json::json!(v);
    }
    if let Some(v) = agent {
        body["coordinatorAgent"] = serde_json::json!(v);
    }
    if let Some(v) = labels {
        body["labels"] = serde_json::json!(split_list(v));
    }
    let data = client.trpc_mutate("projects.create", &body)?;
    let context_name = data
        .get("project")
        .and_then(|p| p.get("contextName"))
        .and_then(|v| v.as_str())
        .unwrap_or(name);
    Ok(CommandResult {
        text: format!("Created project {name} with context {context_name}\n"),
        json: serde_json::json!({"project": data.get("project")}),
    })
}

fn cmd_projects_update(
    project: &str,
    description: Option<&str>,
    model: Option<&str>,
    agent: Option<&str>,
    labels: Option<&str>,
) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let mut body = serde_json::json!({"project": project});
    if let Some(v) = description {
        body["description"] = serde_json::json!(v);
    }
    if let Some(v) = model {
        body["coordinatorModel"] = serde_json::json!(v);
    }
    if let Some(v) = agent {
        body["coordinatorAgent"] = serde_json::json!(v);
    }
    if let Some(v) = labels {
        body["labels"] = serde_json::json!(split_list(v));
    }
    let data = client.trpc_mutate("projects.update", &body)?;
    Ok(CommandResult {
        text: format!("Updated project {project}\n"),
        json: serde_json::json!({"project": data.get("project")}),
    })
}

fn cmd_projects_remove(project: &str, remove_context: bool) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let mut body = serde_json::json!({"project": project});
    if remove_context {
        body["removeContext"] = serde_json::json!(true);
    }
    client.trpc_mutate("projects.remove", &body)?;
    Ok(CommandResult {
        text: format!("Removed project {project}\n"),
        json: serde_json::json!({"removed": true, "project": project}),
    })
}

fn cmd_projects_add_repo(
    project: &str,
    repo: &str,
    role: Option<&str>,
) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let mut body = serde_json::json!({"project": project, "repo": repo});
    if let Some(v) = role {
        body["role"] = serde_json::json!(v);
    }
    let data = client.trpc_mutate("projects.addRepo", &body)?;
    Ok(CommandResult {
        text: format!("Added repo {repo} to project {project}\n"),
        json: serde_json::json!({"project": data.get("project")}),
    })
}

fn cmd_projects_remove_repo(project: &str, repo: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_mutate(
        "projects.removeRepo",
        &serde_json::json!({"project": project, "repo": repo}),
    )?;
    Ok(CommandResult {
        text: format!("Removed repo {repo} from project {project}\n"),
        json: serde_json::json!({"project": data.get("project")}),
    })
}

fn cmd_projects_attach_worktree(project: &str, worktree_id: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    let data = client.trpc_mutate(
        "projects.attachWorktree",
        &serde_json::json!({"project": project, "worktreeId": worktree_id}),
    )?;
    Ok(CommandResult {
        text: format!("Put worktree {worktree_id} in project {project}\n"),
        json: serde_json::json!({"project": data.get("project")}),
    })
}

fn cmd_projects_detach_worktree(worktree_id: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    client.trpc_mutate(
        "projects.detachWorktree",
        &serde_json::json!({"worktreeId": worktree_id}),
    )?;
    Ok(CommandResult {
        text: format!("Took worktree {worktree_id} out of its project\n"),
        json: serde_json::json!({"detached": true, "worktreeId": worktree_id}),
    })
}

fn cmd_mcp_remove(name: &str) -> Result<CommandResult, String> {
    let client = api::ApiClient::from_settings()?;
    client.trpc_mutate("mcp.remove", &serde_json::json!({"name": name}))?;
    Ok(CommandResult {
        text: format!("Removed MCP server {name}\n"),
        json: serde_json::json!({"removed": true, "name": name}),
    })
}

/// Resolve an explicit worktree ID, or auto-detect it from the current
/// working directory by matching `git rev-parse --show-toplevel` against
/// registered worktree paths.
fn resolve_worktree_id(client: &api::ApiClient, worktree: Option<&str>) -> Result<String, String> {
    if let Some(ws) = worktree {
        return Ok(ws.to_string());
    }

    detect_worktree_from_cwd(client)
}

/// Resolve a panel ID for a chat / terminal / browser. When `panel_id` is
/// `Some`, returns it as-is. When `None`, auto-detects the worktree from
/// the current working directory, queries `list_proc`, and returns the
/// `id_field` of the first panel returned by the server.
///
/// This gives every panel-targeted command (`chats send`, `terminals output`,
/// `browsers navigate`, …) a uniform "default panel" behavior so the user
/// rarely has to type IDs when working inside a worktree.
fn resolve_default_panel(
    client: &api::ApiClient,
    panel_id: Option<&str>,
    list_proc: &str,
    list_field: &str,
    id_field: &str,
    domain_label: &str,
) -> Result<String, String> {
    if let Some(id) = panel_id {
        return Ok(id.to_string());
    }
    let ws = resolve_worktree_id(client, None)?;
    let data = client.trpc_query(list_proc, &serde_json::json!({"worktreeId": ws}))?;
    let panels = data
        .get(list_field)
        .and_then(|v| v.as_array())
        .ok_or_else(|| format!("Server returned no {list_field} array"))?;
    let first = panels.first().ok_or_else(|| {
        format!(
            "No {domain_label} found in worktree '{ws}'. Create one first or pass an explicit id."
        )
    })?;
    let id = first
        .get(id_field)
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("First {domain_label} has no {id_field} field"))?;
    Ok(id.to_string())
}

/// Detect the current worktree by matching `git rev-parse --show-toplevel`
/// against the `path` field of all registered worktrees.
fn detect_worktree_from_cwd(client: &api::ApiClient) -> Result<String, String> {
    let git_output = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;

    if !git_output.status.success() {
        return Err("Not in a git repository. Specify --worktree.".to_string());
    }

    let toplevel = String::from_utf8_lossy(&git_output.stdout)
        .trim()
        .to_string();

    let data = client.trpc_query_no_input("repos.list")?;
    let repos = data
        .get("repos")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();

    for proj in &repos {
        let worktrees = proj
            .get("worktrees")
            .and_then(|w| w.as_array())
            .cloned()
            .unwrap_or_default();
        for wt in &worktrees {
            let path = wt.get("path").and_then(|p| p.as_str()).unwrap_or("");
            if path == toplevel {
                let ws_id = wt.get("worktreeId").and_then(|w| w.as_str()).unwrap_or("");
                if !ws_id.is_empty() {
                    return Ok(ws_id.to_string());
                }
            }
        }
    }

    Err(format!(
        "No worktree found for '{toplevel}'. Specify --worktree."
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

// --- Open command ---

/// Split a `path:line[:column]` / `path:line-lineEnd` suffix off the tail
/// of a user-supplied file argument. Mirrors `parseFileLocation` in
/// `packages/dashboard-core/src/lib/file-location.ts` — the server speaks
/// the same syntax on the wire, but we have to strip it before resolving
/// the path against the filesystem because a colon in the middle of a
/// real Unix filename is rare-but-legal.
///
/// Returns `(filePath, line, lineEnd, column)`. Numeric components are
/// `None` when the input doesn't carry that piece.
fn split_file_location(raw: &str) -> (String, Option<u32>, Option<u32>, Option<u32>) {
    // Try :line-lineEnd
    if let Some(idx) = raw.rfind(':') {
        let tail = &raw[idx + 1..];
        if let Some(dash) = tail.find('-') {
            let (a, b) = (&tail[..dash], &tail[dash + 1..]);
            if let (Ok(line), Ok(end)) = (a.parse::<u32>(), b.parse::<u32>()) {
                // Reject inverted ranges like `:10-5` — letting them through
                // would forward a backwards `(line=10, lineEnd=5)` pair to
                // the server, which round-trips through `formatFileLocation`
                // and reaches the editor as a malformed selection. Falls
                // through to the other suffix branches; none of them match
                // a `digit-digit` tail, so the suffix is treated as part of
                // the filename and the server returns a clean "File not
                // found" error.
                if line > 0 && end > 0 && line <= end {
                    return (raw[..idx].to_string(), Some(line), Some(end), None);
                }
            }
        }
    }

    // Try :line:column (two trailing numeric components).
    //
    // The `> 0` guards match the server's `z.number().int().positive()`
    // validators — 1-based, no zero. This means `file.rs:42:0` /
    // `file.rs:0` / `file.rs:0:5` deliberately fall through every
    // suffix branch and the raw colon-string ends up as the filename.
    // The server then surfaces a clean "File not found" rather than
    // silently treating `:0` as "no column" or "no line." It's a
    // surprising edge case for the user but the alternative —
    // accepting zero as a sentinel — would let a typo silently
    // suppress positioning. Errs on the side of visibility.
    // `rsplitn` walks right-to-left, so name the bindings to match the
    // iterator order (rightmost = col, middle = line, head = path).
    // Otherwise a future reader skimming `last`/`middle`/`head`
    // left-to-right will swap line and col in their mental model.
    let mut parts = raw.rsplitn(3, ':');
    let rightmost = parts.next();
    let middle = parts.next();
    let head = parts.next();
    if let (Some(head), Some(middle), Some(rightmost)) = (head, middle, rightmost) {
        if let (Ok(line), Ok(col)) = (middle.parse::<u32>(), rightmost.parse::<u32>()) {
            if line > 0 && col > 0 {
                return (head.to_string(), Some(line), None, Some(col));
            }
        }
    }

    // Try :line (single trailing numeric component). Same `> 0`
    // policy as above.
    //
    // The `!contains(':')` guard on the head is load-bearing: without
    // it, an input like `file.rs:0:5` that fails the `:line:col` guard
    // above would re-enter this branch, find the final `:5`, parse 5
    // as the line, and return `path="file.rs:0", line=5` — which the
    // server then surfaces as a confusing "File not found: file.rs:0".
    // The guard skips this branch whenever a colon survives in the
    // candidate path, so unmatched colon-suffix inputs keep the full
    // raw string as the filename.
    if let Some(idx) = raw.rfind(':') {
        let head = &raw[..idx];
        let tail = &raw[idx + 1..];
        if !head.contains(':') {
            if let Ok(line) = tail.parse::<u32>() {
                if line > 0 {
                    return (head.to_string(), Some(line), None, None);
                }
            }
        }
    }

    (raw.to_string(), None, None, None)
}

fn cmd_open(file_path: &str, worktree: Option<&str>, focus: bool) -> Result<CommandResult, String> {
    let (path_only, line, line_end, column) = split_file_location(file_path);
    if path_only.is_empty() {
        return Err("File path is empty".to_string());
    }

    // Resolve relative paths against cwd so the server sees an absolute
    // path it can validate against the worktree root. Absolute paths are
    // passed through unchanged.
    let resolved: std::path::PathBuf = if std::path::Path::new(&path_only).is_absolute() {
        std::path::PathBuf::from(&path_only)
    } else {
        let cwd = std::env::current_dir()
            .map_err(|e| format!("Failed to read current directory: {e}"))?;
        cwd.join(&path_only)
    };
    // Canonicalize when possible so the server sees the real on-disk path
    // (e.g. resolves `./foo` and `..`). When the file doesn't exist yet,
    // fall back to the joined path so the server can produce a clear
    // "file not found" error rather than a generic IO failure here.
    let absolute = std::fs::canonicalize(&resolved).unwrap_or(resolved);
    let absolute_str = absolute.to_string_lossy().into_owned();

    let client = api::ApiClient::from_settings()?;

    let mut input = serde_json::json!({
        "filePath": absolute_str,
        "focus": focus,
    });
    if let Some(ws) = worktree {
        input["worktreeId"] = serde_json::json!(ws);
    }
    if let Some(line) = line {
        input["line"] = serde_json::json!(line);
    }
    if let Some(end) = line_end {
        input["lineEnd"] = serde_json::json!(end);
    }
    if let Some(col) = column {
        input["column"] = serde_json::json!(col);
    }

    let data = client.trpc_mutate("editor.openFile", &input)?;
    // Surface a clear error rather than printing "Opened <path> in " if
    // the server's response shape ever drifts — the three fields below
    // are part of the editor.openFile contract; an empty string here
    // would be a silent bug.
    let worktree_id = data
        .get("worktreeId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "server response missing worktreeId".to_string())?;
    let resolved_path = data
        .get("filePath")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "server response missing filePath".to_string())?;
    let external = data
        .get("external")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| "server response missing external".to_string())?;

    let where_label = if external {
        format!("{worktree_id} (external)")
    } else {
        worktree_id.to_string()
    };

    Ok(CommandResult {
        text: format!("Opened {resolved_path} in {where_label}\n"),
        json: serde_json::json!({
            "ok": true,
            "worktreeId": worktree_id,
            "filePath": resolved_path,
            "external": external,
        }),
    })
}

// --- Notify command ---

fn cmd_notify(agent: Option<&str>) -> Result<CommandResult, String> {
    use std::io::Read;

    // The CLI is intentionally agent-agnostic: it forwards the raw hook
    // payload to the server and lets the server dispatch to the relevant
    // coding-agent adapter to decide the worktree status. Adding hook
    // support for a new agent therefore never requires changing this command.

    let ok = || {
        Ok(CommandResult {
            text: String::new(),
            json: serde_json::json!({"ok": true}),
        })
    };

    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .map_err(|e| format!("Failed to read stdin: {e}"))?;

    let payload: serde_json::Value = serde_json::from_str(&input)
        .map_err(|e| format!("Failed to parse JSON from stdin: {e}"))?;

    // `cwd` tells the server which worktree this notification is for — that's
    // about routing, not about interpreting the agent's behavior. Prefer the
    // payload's cwd (agents include it), falling back to the process cwd.
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
    // because this runs from agent hooks and must not break the agent.
    let Ok(client) = api::ApiClient::from_settings() else {
        return ok();
    };

    let mut body = serde_json::json!({
        "cwd": cwd,
        "payload": payload,
    });
    // Who sent the hook, so the server reads it with that agent's rules and
    // keeps one status per agent session. `BAND_DISPATCH` is `chat` inside a
    // chat pane's agent and `terminal` inside a Band terminal, which also
    // sets `BAND_TERMINAL_ID`.
    if let Some(agent) = agent {
        body["agent"] = serde_json::json!(agent);
    }
    for (env_var, field) in [
        ("BAND_DISPATCH", "dispatch"),
        ("BAND_TERMINAL_ID", "terminalId"),
    ] {
        if let Ok(value) = std::env::var(env_var) {
            if !value.is_empty() {
                body[field] = serde_json::json!(value);
            }
        }
    }

    let _ = client.trpc_mutate("statuses.notify", &body);

    ok()
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
            "name": "repos list",
            "description": "List registered repos",
            "parameters": [],
            "notes": "Text output: `name\\tpath\\tN worktree(s)` (tab-separated).\nJSON output: `{\"repos\": [{\"name\": \"...\", \"path\": \"...\", \"worktreeCount\": N}]}`"
        }),
        serde_json::json!({
            "name": "repos add",
            "description": "Register an existing repository as a repo",
            "parameters": [
                {"name": "path", "type": "string", "required": true, "positional": true, "description": "Path to the git repository"},
                {"name": "--label", "type": "string", "required": false, "description": "Label for the repo"},
            ],
            "notes": "Registers an existing git repository. Detects the default branch automatically. Returns the repo name."
        }),
        serde_json::json!({
            "name": "repos remove",
            "description": "Unregister a repo",
            "parameters": [
                {"name": "name", "type": "string", "required": true, "positional": true, "description": "Repo name"},
            ],
            "notes": "Removes the repo from Band's registry (does not delete the repository)."
        }),
        serde_json::json!({
            "name": "worktrees list",
            "description": "List worktrees, optionally filtered by repo",
            "parameters": [
                {"name": "repo", "type": "string", "required": false, "positional": true, "description": "Repo name (optional filter)"},
            ],
            "notes": "Text output: `repo\\tbranch\\tpath` (tab-separated, one per line).\nJSON output: `{\"worktrees\": [{\"repo\": \"...\", \"branch\": \"...\", \"path\": \"...\"}]}`"
        }),
        serde_json::json!({
            "name": "worktrees create",
            "description": "Create a new worktree (git worktree + state registration)",
            "parameters": [
                {"name": "repo", "type": "string", "required": true, "positional": true, "description": "Repo name"},
                {"name": "branch", "type": "string", "required": true, "positional": true, "description": "Branch name"},
                {"name": "--base", "type": "string", "required": false, "description": "Base branch to create from (defaults to repo's default branch)"},
                {"name": "--prompt", "type": "string", "required": false, "description": "Prompt to pass to the coding agent"},
                {"name": "--mode", "type": "string", "required": false, "description": "Agent mode (e.g. 'plan', 'edit')"},
                {"name": "--model", "type": "string", "required": false, "description": "Model to use for the coding agent (e.g. 'claude-opus-4-20250514')"},
                {"name": "--agent", "type": "string", "required": false, "description": "Coding agent ID to use (overrides worktree default)"},
                {"name": "--via", "type": "string", "required": false, "description": "Where to dispatch --prompt: 'chat' (chat pane) or 'terminal' (vendor CLI in a PTY). Defaults to 'terminal' from the CLI."},
                {"name": "--project", "type": "string", "required": false, "description": "Put the worktree in this project (name or ID). The repo must be one of the project's."},
            ],
            "notes": "Returns the worktree path and the dispatch target. Idempotent — creating an existing worktree returns its path. Runs `.band/config.json` `setup` script if present (non-fatal).\n\n**Always use `--prompt` when the user wants work to begin immediately.** This submits a task to the coding agent right after worktree creation, so the agent starts working without a separate step. Only omit `--prompt` when the user explicitly wants to create the worktree for manual/later use.\n\n**Dispatch target (`--via`, issue #551).** With `--prompt`, the prompt is dispatched to either:\n- `terminal` (CLI default) — spawns the vendor CLI in a fresh terminal pane with the prompt as the first positional argument (cmux-style: `claude \"<prompt>\"`, `codex \"<prompt>\"`, …). Returns a `terminalId` in the JSON output.\n- `chat` — submits a streaming task to the worktree's chat pane (the web UI default).\n\nPrecedence, highest first: `--via` flag → `BAND_DISPATCH` env var → `.band/config.json` `workspace.defaultVia` → `~/.band/settings.json` `cli.defaultVia` → `terminal`.\n\nWhen to use `--prompt` (most cases):\n```sh\n# User says \"create a worktree and implement X\" or \"start working on X\"\nband worktrees create my-app feat/auth --prompt \"Implement GitHub issue #42: Add JWT authentication\"\n\n# User says \"create a worktree for issue #99 and start implementing\"\nband worktrees create my-app fix/bug-99 --prompt \"Fix issue #99: login redirect loop. See https://github.com/org/repo/issues/99\"\n\n# Force chat dispatch when terminal is the user-level default\nband worktrees create my-app feat/auth --prompt \"...\" --via chat\n```\n\nWhen to omit `--prompt` (rare — user explicitly wants no task):\n```sh\n# User says \"just create a worktree, I'll work on it myself\"\nband worktrees create my-app feat/experiment\n```\n\n**Do NOT create a worktree without `--prompt` and then separately run `band chat`.** That is two steps for what `--prompt` does in one."
        }),
        serde_json::json!({
            "name": "worktrees remove",
            "description": "Remove a worktree (git worktree + state cleanup)",
            "parameters": [
                {"name": "repo", "type": "string", "required": true, "positional": true, "description": "Repo name"},
                {"name": "name", "type": "string", "required": true, "positional": true, "description": "Worktree name (the branch it was created on — its stable identity)"},
            ],
            "notes": "Runs the `.band/config.json` `teardown` command in a terminal tab of the worktree first and waits for it (up to 60s; a failure does not stop the removal). Cleans up all associated files."
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
            "name": "cronjobs list",
            "description": "List cronjobs, optionally filtered by repo or worktree",
            "parameters": [
                {"name": "--repo", "type": "string", "required": false, "description": "Filter by repo name"},
                {"name": "--worktree", "type": "string", "required": false, "description": "Filter by worktree ID"},
            ]
        }),
        serde_json::json!({
            "name": "cronjobs create",
            "description": "Create a new scheduled cronjob",
            "parameters": [
                {"name": "key", "type": "string", "required": true, "positional": true, "description": "Storage key: repo name or worktree ID"},
                {"name": "--name", "type": "string", "required": true, "description": "Human-readable name for the job"},
                {"name": "--prompt", "type": "string", "required": true, "description": "Prompt text to send to the coding agent"},
                {"name": "--cron", "type": "string", "required": true, "description": "Cron expression (e.g. \"0 */6 * * *\")"},
                {"name": "--scope", "type": "string", "required": false, "description": "Scope: repo (default) or worktree"},
                {"name": "--worktree-id", "type": "string", "required": false, "description": "Worktree ID (required when scope is worktree)"},
                {"name": "--via", "type": "string", "required": false, "description": "Where each fire dispatches the prompt: 'chat' (chat pane) or 'terminal' (vendor CLI in a fresh self-closing PTY). Defaults via the same precedence as 'worktrees create' (--via > BAND_DISPATCH > config > settings > terminal)."},
                {"name": "--disabled", "type": "boolean", "required": false, "description": "Create the job in disabled state"},
            ]
        }),
        serde_json::json!({
            "name": "cronjobs update",
            "description": "Update an existing cronjob",
            "parameters": [
                {"name": "key", "type": "string", "required": true, "positional": true, "description": "Storage key (repo name or worktree ID)"},
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
                {"name": "key", "type": "string", "required": true, "positional": true, "description": "Storage key (repo name or worktree ID)"},
                {"name": "id", "type": "string", "required": true, "positional": true, "description": "Cronjob ID (e.g. cj_1234567890)"},
            ]
        }),
        serde_json::json!({
            "name": "cronjobs trigger",
            "description": "Manually trigger a cronjob now",
            "parameters": [
                {"name": "key", "type": "string", "required": true, "positional": true, "description": "Storage key (repo name or worktree ID)"},
                {"name": "id", "type": "string", "required": true, "positional": true, "description": "Cronjob ID (e.g. cj_1234567890)"},
            ]
        }),
        serde_json::json!({
            "name": "subscriptions list",
            "description": "List what a chat listens for",
            "parameters": [
                {"name": "--chat", "type": "string", "required": false, "description": "Chat ID (defaults to $BAND_CHAT_ID)"},
                {"name": "--worktree", "type": "string", "required": false, "description": "List every subscription in this worktree instead of one chat's"},
            ],
            "notes": "Text output: `ID  SOURCE  WATCHES  WAKEUPS  EXPIRES` (space-padded table).\nJSON output: `{\"subscriptions\": [{\"id\": \"...\", \"source\": \"github|timer|webhook\", \"filterKey\": \"...\", \"wakeups\": 0, \"maxWakeups\": 10, \"expiresAt\": 0}]}`."
        }),
        serde_json::json!({
            "name": "subscriptions create",
            "description": "Subscribe a chat to events; the chat is woken with a short message when one arrives",
            "parameters": [
                {"name": "--chat", "type": "string", "required": false, "description": "Chat ID (defaults to $BAND_CHAT_ID)"},
                {"name": "--worktree", "type": "string", "required": false, "description": "Worktree ID (defaults to $BAND_WORKTREE_ID, then the chat's worktree)"},
                {"name": "--pr", "type": "string", "required": false, "description": "Watch a pull request, as owner/repo#N"},
                {"name": "--branch", "type": "string", "required": false, "description": "Watch a branch's CI, as owner/repo@branch"},
                {"name": "--reviews", "type": "boolean", "required": false, "description": "With --pr: deliver reviews"},
                {"name": "--comments", "type": "boolean", "required": false, "description": "With --pr: deliver comments"},
                {"name": "--ci", "type": "boolean", "required": false, "description": "With --pr: also watch CI on the PR's head branch (looked up with gh)"},
                {"name": "--webhook", "type": "boolean", "required": false, "description": "Create a webhook; prints its path and token once"},
                {"name": "--cron", "type": "string", "required": false, "description": "Recurring timer, as a cron expression"},
                {"name": "--at", "type": "string", "required": false, "description": "One-off timer: epoch milliseconds or a delay such as 90s, 10m, 2h, 1d"},
                {"name": "--max-wakeups", "type": "number", "required": false, "description": "Stop after this many wakeups (default 10 for CI, 50 otherwise; a one-off timer always 1)"},
                {"name": "--coalesce", "type": "number", "required": false, "description": "Seconds to hold events before waking the chat (default 30)"},
            ],
            "notes": "Exactly one of --pr, --branch, --webhook, --cron, --at. PR activity (reviews and comments) is one subscription; --ci adds a second one on the PR's head branch. Subscriptions last at most 180 days.\nJSON output: `{\"subscriptions\": [...]}`."
        }),
        serde_json::json!({
            "name": "subscriptions remove",
            "description": "Remove a subscription",
            "parameters": [
                {"name": "id", "type": "string", "required": true, "positional": true, "description": "Subscription ID"},
            ]
        }),
        serde_json::json!({
            "name": "env validate",
            "description": "Validate .band/environment.json, printing OK or each problem with its path",
            "parameters": [
                {"name": "path", "type": "string", "required": false, "positional": true, "description": "Repository directory, or the environment.json file (default: the current directory)"},
            ],
            "notes": "The hub reads the file, so the path must exist on the hub's machine. Exits 0 when the file is valid and 1 when it has problems or does not exist. Text output: `OK <file>`, or `<file> has N problems:` followed by `  <key path>: <message>` lines on stderr.\nJSON output: `{\"ok\": false, \"source\": \"/repo/.band/environment.json\", \"issues\": [{\"path\": \"isolation\", \"message\": \"...\"}]}`."
        }),
        serde_json::json!({
            "name": "env build",
            "description": "Build the repo's environment image at its default branch, or report a cache hit",
            "parameters": [
                {"name": "repo", "type": "string", "required": true, "positional": true, "description": "Repo name (from `band repos list`)"},
                {"name": "force", "type": "boolean", "required": false, "description": "Build again even when an image for the same key exists"},
                {"name": "no-wait", "type": "boolean", "required": false, "description": "Return once the build has started instead of waiting for it to finish"},
            ],
            "notes": "Admin only. The hub builds on its builder host (settings `environmentBuilder.hostId`, default the hub's machine), from the default branch's `.band/environment.json`. An image for the same key (environment file, what it references, lockfiles, worker base) is reused. Text output follows the build log, then `ready <image>` or `failed: <reason>`. Exits 0 for a ready image or a cache hit, 1 for a failed build.\nJSON output: `{\"cacheHit\": false, \"build\": {\"id\": \"...\", \"status\": \"ready\", \"image\": \"band-env/api:0123456789abcdef\", \"key\": \"...\"}}`."
        }),
        serde_json::json!({
            "name": "env status",
            "description": "Show a repo's current environment image and its latest build, with the log",
            "parameters": [
                {"name": "repo", "type": "string", "required": true, "positional": true, "description": "Repo name (from `band repos list`)"},
            ],
            "notes": "The current image is the newest ready build. A failed build never replaces it.\nJSON output: `{\"builder\": {...}, \"current\": {...} | null, \"latest\": {..., \"log\": \"...\"} | null, \"builds\": [...]}`."
        }),
        serde_json::json!({
            "name": "hosts list",
            "description": "List the hosts worktrees can run on",
            "parameters": [],
            "notes": "Text output: `ID  NAME  STATUS  LABELS  AGENTS  ROOTS  LAST SEEN` (space-padded table). STATUS is online, offline, lost or disposed. AGENTS are the coding agents the host can start, ROOTS the directories it serves worktrees from (`-` when none).\nJSON output: `{\"hosts\": [{\"id\": \"local\", \"name\": \"Local\", \"status\": \"online\", \"labels\": [], \"agents\": [], \"roots\": [], \"capabilities\": [], \"home\": null, \"lastSeenAt\": null}]}`."
        }),
        serde_json::json!({
            "name": "hosts remove",
            "description": "Remove an offline worker host that has no worktrees, and revoke its tokens",
            "parameters": [
                {"name": "id", "type": "string", "required": true, "positional": true, "description": "Host ID (from `band hosts list`)"},
            ],
            "notes": "Needs an admin token. Refused for the local host, a host that is online or lost, and a host that still has worktrees."
        }),
        serde_json::json!({
            "name": "vault list",
            "description": "List the credentials the hub stores encrypted (never their values)",
            "parameters": [],
            "notes": "Needs an admin token. Text output: `ID  NAME  KIND  SCOPE  LAST USED`.\nJSON output: `{\"items\": [{\"id\": \"v-...\", \"name\": \"...\", \"kind\": \"api_key|env|oauth|git\", \"scope\": \"global\", \"metadata\": {}, \"createdAt\": 0, \"updatedAt\": 0, \"lastUsedAt\": null}]}`."
        }),
        serde_json::json!({
            "name": "vault put",
            "description": "Store an API key, environment value or git access token encrypted on the hub",
            "parameters": [
                {"name": "name", "type": "string", "required": true, "positional": true, "description": "Credential name (an env item's name is the variable name)"},
                {"name": "kind", "type": "string", "required": false, "description": "api_key (default), env or git"},
                {"name": "scope", "type": "string", "required": false, "description": "global (default) or repo:<name>"},
                {"name": "description", "type": "string", "required": false, "description": "Short note shown in the list"},
                {"name": "host", "type": "string", "required": false, "description": "For --kind git: the remote's host, such as github.com"},
                {"name": "path", "type": "string", "required": false, "description": "For --kind git: a pattern over the repository path, such as 'owner/*'"},
                {"name": "username", "type": "string", "required": false, "description": "For --kind git: the username git sends with the token (default x-access-token)"},
                {"name": "value", "type": "string", "required": false, "description": "The value. Without it the value is read from stdin."},
            ],
            "notes": "Needs an admin token. Replaces a value stored under the same name and scope. The value is never printed or returned."
        }),
        serde_json::json!({
            "name": "vault delete",
            "description": "Delete a stored credential (an OAuth connection is revoked at its server first)",
            "parameters": [
                {"name": "id", "type": "string", "required": true, "positional": true, "description": "Credential ID (from `band vault list`)"},
            ],
            "notes": "Needs an admin token."
        }),
        serde_json::json!({
            "name": "vault rotate-key",
            "description": "Re-encrypt every stored credential under a new key",
            "parameters": [],
            "notes": "Needs an admin token. Only for a key file in BAND_HOME; a key from BAND_VAULT_KEY is changed in the environment."
        }),
        serde_json::json!({
            "name": "mcp list",
            "description": "List the HTTP MCP servers the hub proxies for agents",
            "parameters": [],
            "notes": "Needs an admin token. Text output: `NAME  URL  CREDENTIAL  TOOLS  MODE`.\nJSON output: `{\"servers\": [{\"id\": \"m-...\", \"name\": \"...\", \"url\": \"...\", \"vaultItemId\": null, \"allowTools\": null, \"readOnly\": false, \"readOnlyTools\": [], \"enabled\": true}]}`."
        }),
        serde_json::json!({
            "name": "mcp add",
            "description": "Add an HTTP MCP server the hub proxies at /mcp-proxy/<name>, injecting a vault credential",
            "parameters": [
                {"name": "name", "type": "string", "required": true, "positional": true, "description": "Server name: lowercase letters, digits, hyphens and underscores"},
                {"name": "url", "type": "string", "required": true, "positional": true, "description": "The server's streamable HTTP endpoint (https, or http on loopback)"},
                {"name": "vault-item", "type": "string", "required": false, "description": "Credential ID from `band vault list` (API key or OAuth connection)"},
                {"name": "header", "type": "string", "required": false, "description": "Header that carries an API key (default Authorization)"},
                {"name": "prefix", "type": "string", "required": false, "description": "Text before an API key in the header (default `Bearer `)"},
                {"name": "allow-tools", "type": "string", "required": false, "description": "Comma-separated tools agents may see and call (default: all)"},
                {"name": "read-only", "type": "boolean", "required": false, "description": "Keep only read-only tools"},
                {"name": "read-only-tools", "type": "string", "required": false, "description": "Comma-separated tools to treat as read-only"},
                {"name": "disabled", "type": "boolean", "required": false, "description": "Add the server switched off"},
            ],
            "notes": "Needs an admin token. Agents get a per-session token for the server and never see the credential."
        }),
        serde_json::json!({
            "name": "mcp remove",
            "description": "Remove a proxied MCP server",
            "parameters": [
                {"name": "name", "type": "string", "required": true, "positional": true, "description": "Server name (from `band mcp list`)"},
            ],
            "notes": "Needs an admin token."
        }),
        serde_json::json!({
            "name": "context list",
            "description": "List the context repos the hub holds",
            "parameters": [],
            "notes": "Needs an admin token. Text output: `NAME  KIND  REMOTE  LABELS  SYNC`.\nJSON output: `{\"contexts\": [{\"id\": \"ctx-...\", \"name\": \"...\", \"kind\": \"user|project\", \"remoteUrl\": null, \"labels\": [], \"workerAccess\": \"read-write\", \"syncError\": null}]}`."
        }),
        serde_json::json!({
            "name": "context create",
            "description": "Create a context repo on the hub, with a scaffold or mirroring an existing remote repo",
            "parameters": [
                {"name": "name", "type": "string", "required": true, "positional": true, "description": "Context name. `user` is the user context."},
                {"name": "remote", "type": "string", "required": false, "description": "Existing repo to mirror both ways (https, ssh or scp-style URL)"},
                {"name": "vault-item", "type": "string", "required": false, "description": "Credential ID from `band vault list` for an https remote"},
                {"name": "labels", "type": "string", "required": false, "description": "Comma-separated key=value host labels a worker needs to pull this context (default: any worker)"},
                {"name": "read-only", "type": "boolean", "required": false, "description": "Workers may pull but not push"},
            ],
            "notes": "Needs an admin token. Clients clone `<hub>/git/context/<name>.git` with a Bearer token."
        }),
        serde_json::json!({
            "name": "context remove",
            "description": "Remove a context and its repo on the hub",
            "parameters": [
                {"name": "name", "type": "string", "required": true, "positional": true, "description": "Context name (from `band context list`)"},
            ],
            "notes": "Needs an admin token. A linked remote is left as it is."
        }),
        serde_json::json!({
            "name": "context link-remote",
            "description": "Link a context to a remote repo and mirror it now, or drop the link",
            "parameters": [
                {"name": "name", "type": "string", "required": true, "positional": true, "description": "Context name"},
                {"name": "remote", "type": "string", "required": false, "positional": true, "description": "Remote URL (https, ssh or scp-style)"},
                {"name": "vault-item", "type": "string", "required": false, "description": "Credential ID from `band vault list` for an https remote"},
                {"name": "unlink", "type": "boolean", "required": false, "description": "Drop the remote link"},
            ],
            "notes": "Needs an admin token. The hub fetches the remote's branches and pushes its own, never forcing. A branch that moved on both sides is left alone and shown in the SYNC column."
        }),
        serde_json::json!({
            "name": "tasks create",
            "description": "Create a task: a folder on one host with BRIEF.md, a worktree per repo and a chat",
            "parameters": [
                {"name": "project", "type": "string", "required": true, "positional": true, "description": "Project name or ID"},
                {"name": "branch", "type": "string", "required": true, "positional": true, "description": "Branch every repo's worktree is made on, from its default branch"},
                {"name": "repo", "type": "string", "required": false, "description": "A repo of the project to start with, as `name` or `name:role` (repeatable). None starts an empty task."},
                {"name": "brief", "type": "string", "required": false, "description": "A file with the task's brief (markdown)"},
                {"name": "name", "type": "string", "required": false, "description": "Task folder name (default: the branch with `/` replaced by `-`)"},
                {"name": "title", "type": "string", "required": false, "description": "Title of the task's chat"},
                {"name": "host", "type": "string", "required": false, "description": "Host ID to create the task on"},
                {"name": "labels", "type": "string", "required": false, "description": "Comma-separated key=value host labels the host must have"},
                {"name": "agent", "type": "string", "required": false, "description": "Coding agent ID of the task's chat"},
                {"name": "model", "type": "string", "required": false, "description": "Model of the task's chat"},
                {"name": "no-start", "type": "boolean", "required": false, "description": "Make the task and its chat without sending the first prompt"},
            ],
            "notes": "Needs an admin token. A task runs on one host, so the call fails with the reason when no host fits every repo. JSON output: `{\"task\": {\"id\": \"tsk-...\", \"name\": \"...\", \"folder\": \"...\", \"hostId\": \"...\", \"members\": [{\"repo\": \"api\", \"worktreeId\": \"api-feat-x\", \"path\": \"...\"}]}, \"chatId\": \"...\"}`."
        }),
        serde_json::json!({
            "name": "tasks list",
            "description": "List a project's tasks, or every project's",
            "parameters": [
                {"name": "project", "type": "string", "required": false, "positional": true, "description": "Project name or ID"},
            ],
            "notes": "Text output: `NAME  PROJECT  BRANCH  HOST  REPOS`. Worktrees made before tasks show as one-member tasks."
        }),
        serde_json::json!({
            "name": "tasks add-repo",
            "description": "Add a repo of the task's project to a task",
            "parameters": [
                {"name": "task", "type": "string", "required": true, "positional": true, "description": "Task ID, or its name with --project"},
                {"name": "repo", "type": "string", "required": true, "positional": true, "description": "Repo name"},
                {"name": "role", "type": "string", "required": false, "description": "Role of the repo in the task"},
                {"name": "project", "type": "string", "required": false, "description": "Project name or ID, when `task` is a name"},
            ],
            "notes": "Needs an admin token. Makes a git worktree on the task's branch in the task folder."
        }),
        serde_json::json!({
            "name": "tasks remove-repo",
            "description": "Remove a repo from a task",
            "parameters": [
                {"name": "task", "type": "string", "required": true, "positional": true, "description": "Task ID, or its name with --project"},
                {"name": "repo", "type": "string", "required": true, "positional": true, "description": "Repo name"},
                {"name": "project", "type": "string", "required": false, "description": "Project name or ID, when `task` is a name"},
            ],
            "notes": "Needs an admin token. Refused while the repo's worktree has commits that are not on the default branch or uncommitted changes."
        }),
        serde_json::json!({
            "name": "tasks remove",
            "description": "Remove a task with its worktrees, chats and folder",
            "parameters": [
                {"name": "task", "type": "string", "required": true, "positional": true, "description": "Task ID, or its name with --project"},
                {"name": "project", "type": "string", "required": false, "description": "Project name or ID, when `task` is a name"},
                {"name": "force", "type": "boolean", "required": false, "description": "Remove it even when a worktree has commits or uncommitted changes"},
            ],
            "notes": "Needs an admin token."
        }),
        serde_json::json!({
            "name": "projects list",
            "description": "List the projects (cross-repo bodies of work)",
            "parameters": [],
            "notes": "Text output: `NAME  REPOS  MODEL  CONTEXT  WORKTREES`.\nJSON output: `{\"projects\": [{\"id\": \"prj-...\", \"name\": \"...\", \"description\": \"\", \"contextName\": \"...\", \"coordinatorAgent\": null, \"coordinatorModel\": \"opus\", \"labels\": [], \"policy\": {}, \"repos\": [{\"repo\": \"api\", \"role\": \"api\"}], \"worktrees\": []}]}`."
        }),
        serde_json::json!({
            "name": "projects get",
            "description": "Show one project with its repos, context and worktrees",
            "parameters": [
                {"name": "project", "type": "string", "required": true, "positional": true, "description": "Project name or ID"},
            ],
            "notes": "JSON output: `{\"project\": {...}}` with the same fields as `projects list` plus `context`."
        }),
        serde_json::json!({
            "name": "projects create",
            "description": "Create a project and its context repo",
            "parameters": [
                {"name": "name", "type": "string", "required": true, "positional": true, "description": "Project name: lowercase letters, digits, hyphens and underscores"},
                {"name": "description", "type": "string", "required": false, "description": "What the project is for"},
                {"name": "repo", "type": "string", "required": false, "description": "A repo the project may touch, as `name` or `name:role` (repeatable)"},
                {"name": "context", "type": "string", "required": false, "description": "Use this existing project context instead of creating one"},
                {"name": "remote-url", "type": "string", "required": false, "description": "Mirror the new context repo with this remote"},
                {"name": "remote-vault-item", "type": "string", "required": false, "description": "Credential ID from `band vault list` for an https remote"},
                {"name": "model", "type": "string", "required": false, "description": "Model of the project's coordinator (default: opus)"},
                {"name": "agent", "type": "string", "required": false, "description": "Coding agent ID of the coordinator"},
                {"name": "labels", "type": "string", "required": false, "description": "Comma-separated key=value host labels for the project's worktrees"},
            ],
            "notes": "Needs an admin token. Without `--context` the hub creates a context repo named like the project, with the project scaffold."
        }),
        serde_json::json!({
            "name": "projects update",
            "description": "Change a project's description, coordinator or labels",
            "parameters": [
                {"name": "project", "type": "string", "required": true, "positional": true, "description": "Project name or ID"},
                {"name": "description", "type": "string", "required": false, "description": "New description"},
                {"name": "model", "type": "string", "required": false, "description": "Coordinator model"},
                {"name": "agent", "type": "string", "required": false, "description": "Coordinator coding agent ID"},
                {"name": "labels", "type": "string", "required": false, "description": "Comma-separated key=value host labels (replaces the list)"},
            ],
            "notes": "Needs an admin token."
        }),
        serde_json::json!({
            "name": "projects remove",
            "description": "Remove a project",
            "parameters": [
                {"name": "project", "type": "string", "required": true, "positional": true, "description": "Project name or ID"},
                {"name": "remove-context", "type": "boolean", "required": false, "description": "Also delete the project's context repo"},
            ],
            "notes": "Needs an admin token. Refused while worktrees belong to the project."
        }),
        serde_json::json!({
            "name": "projects add-repo",
            "description": "Add a repo to a project, or change its role",
            "parameters": [
                {"name": "project", "type": "string", "required": true, "positional": true, "description": "Project name or ID"},
                {"name": "repo", "type": "string", "required": true, "positional": true, "description": "Repo name"},
                {"name": "role", "type": "string", "required": false, "description": "Role of the repo, such as `api` or `client`"},
            ],
            "notes": "Needs an admin token."
        }),
        serde_json::json!({
            "name": "projects remove-repo",
            "description": "Remove a repo from a project",
            "parameters": [
                {"name": "project", "type": "string", "required": true, "positional": true, "description": "Project name or ID"},
                {"name": "repo", "type": "string", "required": true, "positional": true, "description": "Repo name"},
            ],
            "notes": "Needs an admin token. Refused while worktrees of that repo belong to the project."
        }),
        serde_json::json!({
            "name": "projects attach-worktree",
            "description": "Put an existing worktree in a project",
            "parameters": [
                {"name": "project", "type": "string", "required": true, "positional": true, "description": "Project name or ID"},
                {"name": "worktree_id", "type": "string", "required": true, "positional": true, "description": "Worktree ID"},
            ],
            "notes": "Needs an admin token. The worktree's repo must be one of the project's."
        }),
        serde_json::json!({
            "name": "projects detach-worktree",
            "description": "Take a worktree out of its project",
            "parameters": [
                {"name": "worktree_id", "type": "string", "required": true, "positional": true, "description": "Worktree ID"},
            ],
            "notes": "Needs an admin token."
        }),
        serde_json::json!({
            "name": "runners list",
            "description": "List the runners that start workers for worktrees waiting on a host",
            "parameters": [],
            "notes": "Text output: `ID  SPAWN  LABELS  RUNNING  TIMEOUT` (space-padded table), then one `Invalid runner: ...` line per entry of `runners` in settings.json that the hub skips. RUNNING is `<in flight>/<maxConcurrent>`.\nJSON output: `{\"runners\": [{\"id\": \"local\", \"spawn\": \"bundled:local\", \"labels\": {}, \"maxConcurrent\": 1, \"timeoutSec\": 120, \"running\": 0}], \"runs\": [...], \"errors\": []}`."
        }),
        serde_json::json!({
            "name": "runners log",
            "description": "Show what a runner's hooks printed for a host request",
            "parameters": [
                {"name": "request_id", "type": "string", "required": true, "positional": true, "description": "Host request ID"},
            ],
            "notes": "Prints the hub's log of the request's spawn and destroy hooks, with tokens replaced by `[redacted]`. Fails when there is no log for the request."
        }),
        serde_json::json!({
            "name": "tokens list",
            "description": "List the hub's tokens (never their secrets)",
            "parameters": [],
            "notes": "Text output: `ID  KIND  LABEL  STATE  LAST USED` (space-padded table). KIND is device, worker_bootstrap or worker_session; STATE is active, revoked, expired or used.\nJSON output: `{\"tokens\": [{\"id\": \"...\", \"kind\": \"device\", \"label\": \"...\", \"admin\": true, \"state\": \"active\", \"lastUsedAt\": null}]}`. Needs an admin token."
        }),
        serde_json::json!({
            "name": "tokens create-device",
            "description": "Create a device token for a UI or script",
            "parameters": [
                {"name": "--label", "type": "string", "required": false, "description": "What the token is for (default \"CLI device\")"},
                {"name": "--admin", "type": "boolean", "required": false, "description": "Let the token manage tokens; without it every `band tokens` command gets 403"},
            ],
            "notes": "The token is printed once; the hub keeps only a hash. Only an admin token can run `band tokens`; the shared token in settings.json is one.\nJSON output: `{\"id\": \"...\", \"label\": \"...\", \"admin\": false, \"token\": \"...\"}`."
        }),
        serde_json::json!({
            "name": "tokens revoke",
            "description": "Revoke a token; whatever uses it stops authenticating",
            "parameters": [
                {"name": "id", "type": "string", "required": true, "positional": true, "description": "Token ID (from `band tokens list`)"},
            ],
            "notes": "The shared token in settings.json cannot be revoked."
        }),
        serde_json::json!({
            "name": "chats list",
            "description": "List chat panes for a worktree",
            "parameters": [
                {"name": "worktree_id", "type": "string", "required": false, "positional": true, "description": "Worktree ID (auto-detected from cwd if omitted)"},
            ],
            "notes": "Text output: `ID\\tNAME\\tAGENT\\tSTATUS\\tLABELS` (space-padded table; LABELS renders as `k=v,k=v` and is empty when the chat has no labels).\nJSON output: `{\"chats\": [{\"id\": \"...\", \"name\": \"...\", \"agent\": \"...\", \"status\": \"...\", \"labels\": {\"k\": \"v\"}}]}`. The `band:` key prefix is reserved for server-internal labels (e.g. `band:cronId` set by the cronjob scheduler when it owns a chat) and is not user-settable."
        }),
        serde_json::json!({
            "name": "chats create",
            "description": "Create a new chat pane in a worktree",
            "parameters": [
                {"name": "worktree_id", "type": "string", "required": false, "positional": true, "description": "Worktree ID (auto-detected from cwd if omitted)"},
                {"name": "--name", "type": "string", "required": false, "description": "Display name for the chat pane"},
                {"name": "--agent", "type": "string", "required": false, "description": "Coding agent ID (e.g. 'claude-code')"},
                {"name": "--model", "type": "string", "required": false, "description": "Model override"},
                {"name": "--mode", "type": "string", "required": false, "description": "Mode (e.g. 'plan', 'edit')"},
                {"name": "--label", "type": "string", "required": false, "repeatable": true, "description": "Label in the form `key=value` (repeatable). Keys with the reserved `band:` prefix are rejected."},
            ],
            "notes": "Creates a new independent chat pane with its own agent process. Returns the chat ID.\nJSON output: `{\"chat\": {\"id\": \"...\", \"name\": \"...\", \"agent\": \"...\", \"status\": \"idle\", \"labels\": {\"k\": \"v\"}}}`"
        }),
        serde_json::json!({
            "name": "chats send",
            "description": "Send a message to a worktree chat (defaults to the worktree's active chat panel)",
            "parameters": [
                {"name": "chat_id", "type": "string", "required": false, "positional": true, "description": "Chat pane ID (defaults to the worktree's active chat panel)"},
                {"name": "--message", "type": "string", "required": true, "description": "Message text to send"},
                {"name": "--worktree", "type": "string", "required": false, "description": "Worktree ID (auto-detected from cwd if omitted)"},
                {"name": "--mode", "type": "string", "required": false, "description": "Agent mode (e.g. 'plan', 'edit')"},
                {"name": "--model", "type": "string", "required": false, "description": "Model to use for the coding agent (e.g. 'claude-opus-4-20250514')"},
                {"name": "--agent", "type": "string", "required": false, "description": "Coding agent ID to use (overrides worktree default)"},
            ],
            "notes": "Sends a message to a worktree chat via `tasks.submit`. When `chat_id` is omitted, the server resolves the worktree's *active* chat panel (the tab the user last focused in the dashboard), falling back to the first panel in the saved layout, then to the first chat in the registry, and finally creating a new \"Chat\" panel if the worktree has none. This means CLI prompts land in the same conversation the user is looking at.\n\nReturns the task ID. When the chat is busy (a turn is running, or earlier messages are still queued), the message is queued instead and runs in order once the turns ahead of it finish; the command then prints `queued <queue entry id>`. Queued messages show in the chat pane, where they can be edited, reordered or cancelled.\nJSON output: `{\"id\": \"tsk_...\", \"queued\": false, \"worktreeId\": \"...\", \"chatId\": \"chat_...\"}`, or `{\"id\": null, \"queued\": true, \"queuedMessageId\": \"...\", \"worktreeId\": \"...\", \"chatId\": \"chat_...\"}` when queued.\n\nReplaces the removed `tasks` subcommand. Use the positional `chat_id` to target a specific chat pane (look it up with `band chats list`)."
        }),
        serde_json::json!({
            "name": "chats watch",
            "description": "Stream a chat pane's running task as raw NDJSON",
            "parameters": [
                {"name": "chat_id", "type": "string", "required": false, "positional": true, "description": "Chat pane ID (defaults to the cwd worktree's first chat pane)"},
            ],
            "notes": "Connects to the chat's task SSE stream and dumps each event as one JSON object per line on stdout. Output is always raw JSON regardless of `--output`. Exits 0 immediately when the chat has no running task."
        }),
        serde_json::json!({
            "name": "chats stop",
            "description": "Stop a running chat pane",
            "parameters": [
                {"name": "chat_id", "type": "string", "required": false, "positional": true, "description": "Chat pane ID (defaults to the cwd worktree's first chat pane)"},
            ],
            "notes": "Aborts the running task and sets chat status to stopped."
        }),
        serde_json::json!({
            "name": "chats remove",
            "description": "Remove a chat pane (kills agent, cleans up state)",
            "parameters": [
                {"name": "chat_id", "type": "string", "required": false, "positional": true, "description": "Chat pane ID (defaults to the cwd worktree's first chat pane)"},
            ],
            "notes": "Removes the chat pane, kills the associated agent process, and cleans up state."
        }),
        serde_json::json!({
            "name": "chats label",
            "description": "Add or overwrite labels on a chat pane (additive merge)",
            "parameters": [
                {"name": "chat_id", "type": "string", "required": true, "positional": true, "description": "Chat pane ID"},
                {"name": "labels", "type": "string", "required": true, "positional": true, "repeatable": true, "description": "One or more `key=value` pairs"},
            ],
            "notes": "Reads the chat's current labels, merges the new pairs in (later wins for duplicate keys, other labels untouched), and persists via `chats.update`. Keys with the reserved `band:` prefix are rejected by the server. Two callers labeling the same chat concurrently can race; intended for single-user workflows.\n\nText output: the chat's final labels rendered as `k=v,k=v` with sorted keys.\nJSON output: `{\"chat\": {...}}` — the full chat record after the update."
        }),
        serde_json::json!({
            "name": "chats unlabel",
            "description": "Remove labels from a chat pane by key",
            "parameters": [
                {"name": "chat_id", "type": "string", "required": true, "positional": true, "description": "Chat pane ID"},
                {"name": "keys", "type": "string", "required": true, "positional": true, "repeatable": true, "description": "One or more label keys to remove"},
            ],
            "notes": "Reads the chat's current labels, drops the listed keys (unknown keys are ignored), and persists via `chats.update`. Other labels are preserved.\n\nText output: the chat's final labels rendered as `k=v,k=v` with sorted keys.\nJSON output: `{\"chat\": {...}}` — the full chat record after the update."
        }),
        serde_json::json!({
            "name": "browsers list",
            "description": "List browser tabs for a worktree",
            "parameters": [
                {"name": "worktree_id", "type": "string", "required": false, "positional": true, "description": "Worktree ID (auto-detected from cwd if omitted)"},
            ],
            "notes": "Text output: `ID\\tNAME\\tURL\\tSTATUS` (tab-separated table).\nJSON output: `{\"browsers\": [{\"id\": \"...\", \"name\": \"...\", \"url\": \"...\", \"status\": \"...\"}]}`"
        }),
        serde_json::json!({
            "name": "browsers create",
            "description": "Create a new browser tab in a worktree",
            "parameters": [
                {"name": "worktree_id", "type": "string", "required": false, "positional": true, "description": "Worktree ID (auto-detected from cwd if omitted)"},
                {"name": "--url", "type": "string", "required": false, "description": "Initial URL to navigate to"},
                {"name": "--name", "type": "string", "required": false, "description": "Display name for the browser tab"},
            ],
            "notes": "Text output: the new browser tab ID.\nJSON output: `{\"browser\": {\"id\": \"...\", ...}}`"
        }),
        serde_json::json!({
            "name": "browsers navigate",
            "description": "Navigate a browser tab to a URL",
            "parameters": [
                {"name": "browser_id", "type": "string", "required": false, "positional": true, "description": "Browser tab ID (defaults to the cwd worktree's first browser tab)"},
                {"name": "--url", "type": "string", "required": true, "description": "URL to navigate to"},
            ],
            "notes": "Updates the browser tab's URL in the server state. When `browser_id` is omitted, auto-detects the worktree from cwd and targets that worktree's first browser tab. Mirrors the shape of `chats send [chat_id] --message ...` and `terminals send [terminal_id] --data ...` — panel ID is positional, data is a flag."
        }),
        serde_json::json!({
            "name": "browsers get",
            "description": "Get a browser tab's current state",
            "parameters": [
                {"name": "browser_id", "type": "string", "required": false, "positional": true, "description": "Browser tab ID (defaults to the cwd worktree's first browser tab)"},
            ],
            "notes": "Text output: formatted key-value pairs.\nJSON output: `{\"browser\": {\"id\": \"...\", \"name\": \"...\", \"url\": \"...\", \"status\": \"...\"}}`"
        }),
        serde_json::json!({
            "name": "browsers remove",
            "description": "Remove a browser tab",
            "parameters": [
                {"name": "browser_id", "type": "string", "required": false, "positional": true, "description": "Browser tab ID (defaults to the cwd worktree's first browser tab)"},
            ],
            "notes": "Removes the browser tab and cleans up state."
        }),
        serde_json::json!({
            "name": "agents list",
            "description": "List the running agent sessions of a worktree",
            "parameters": [
                {"name": "worktree_id", "type": "string", "required": false, "positional": true, "description": "Worktree ID (auto-detected from cwd if omitted)"},
            ],
            "notes": "An agent session is one run of a coding agent: `gui` in a chat pane, `tui` as the agent's CLI in a terminal. Ended sessions are not listed.\nText output: `SESSION ID\\tAGENT\\tMODE\\tSTATE\\tPANE\\tPROVIDER SESSION` (tab-separated table). PANE is the chat ID for gui sessions and the terminal ID for tui sessions.\nJSON output: `{\"agentSessions\": [{\"id\": \"...\", \"worktreeId\": \"...\", \"agentDefinitionId\": \"...\", \"providerSessionId\": \"...\" | null, \"mode\": \"gui\" | \"tui\", \"chatId\": \"...\" | null, \"terminalId\": \"...\" | null, \"state\": \"starting\" | \"running\", \"createdAt\": N, \"updatedAt\": N}]}`"
        }),
        serde_json::json!({
            "name": "agents launch",
            "description": "Start a coding agent as a chat (gui) or as its CLI in a terminal (tui)",
            "parameters": [
                {"name": "worktree_id", "type": "string", "required": false, "positional": true, "description": "Worktree ID (auto-detected from cwd if omitted)"},
                {"name": "--agent", "type": "string", "required": false, "description": "Coding agent ID from settings (default agent if omitted)"},
                {"name": "--mode", "type": "string", "required": false, "description": "gui (chat) or tui (terminal); chat / terminal also accepted. Falls back to BAND_DISPATCH, then .band/config.json workspace.defaultVia, then the server's agents.defaultMode"},
                {"name": "--prompt", "type": "string", "required": false, "description": "First prompt for the agent"},
            ],
            "notes": "`gui` opens a chat pane and submits the prompt to the agent. `tui` opens a terminal running the agent's CLI (`claude \"<prompt>\"`, `codex \"<prompt>\"`, ...). Mode precedence, highest first: `--mode` → `BAND_DISPATCH` env var (set in every Band terminal and chat agent) → `.band/config.json` `workspace.defaultVia` → the server's `agents.defaultMode` setting. An agent with no terminal mode (Cursor CLI) starts as a chat, and the output carries a notice.\nText output: `<mode>\\t<chat or terminal ID>`, plus a `note:` line after a fallback.\nJSON output: `{\"agentSession\": {...}, \"mode\": \"gui\" | \"tui\", \"chatId\": \"...\", \"terminalId\": \"...\", \"notice\": \"...\"}` (chatId for gui, terminalId for tui, notice only after a fallback).\nExample: band agents launch --agent codex --mode tui --prompt \"Fix the failing test\""
        }),
        serde_json::json!({
            "name": "terminals list",
            "description": "List terminal sessions for a worktree",
            "parameters": [
                {"name": "worktree_id", "type": "string", "required": false, "positional": true, "description": "Worktree ID (auto-detected from cwd if omitted)"},
            ],
            "notes": "Text output: `TERMINAL ID\\tTITLE\\tPID\\tSCROLLBACK` (tab-separated table).\nJSON output: `{\"terminals\": [{\"terminalId\": \"...\", \"worktreeId\": \"...\", \"pid\": N, \"scrollbackLength\": N, \"title\": \"...\"}]}`"
        }),
        serde_json::json!({
            "name": "terminals create",
            "description": "Create a new terminal session in a worktree",
            "parameters": [
                {"name": "worktree_id", "type": "string", "required": false, "positional": true, "description": "Worktree ID (auto-detected from cwd if omitted)"},
                {"name": "--command", "type": "string", "required": false, "description": "Shell command to auto-run after spawn"},
                {"name": "--cwd", "type": "string", "required": false, "description": "Working directory (relative to worktree root)"},
            ],
            "notes": "Creates a new terminal session with its own PTY process. Returns the terminal ID.\nJSON output: `{\"terminalId\": \"...\", \"worktreeId\": \"...\", \"pid\": N}`"
        }),
        serde_json::json!({
            "name": "terminals send",
            "description": "Send input to a terminal session",
            "parameters": [
                {"name": "terminal_id", "type": "string", "required": false, "positional": true, "description": "Terminal ID (defaults to the cwd worktree's first terminal)"},
                {"name": "--data", "type": "string", "required": true, "description": "Text to send (supports \\n for newline, \\t for tab)"},
            ],
            "notes": "Writes text to the terminal's PTY stdin. Use \\n to send a newline (execute command).\nExample: band terminals send <id> --data \"ls -la\\n\""
        }),
        serde_json::json!({
            "name": "terminals output",
            "description": "Get terminal output (scrollback buffer)",
            "parameters": [
                {"name": "terminal_id", "type": "string", "required": false, "positional": true, "description": "Terminal ID (defaults to the cwd worktree's first terminal)"},
                {"name": "--lines", "type": "integer", "required": false, "description": "Number of lines to show (from end of buffer)"},
                {"name": "--follow", "type": "boolean", "required": false, "description": "Stream live output (like tail -f)"},
            ],
            "notes": "Without --follow: fetches the current scrollback buffer (up to 100KB).\nWith --follow: streams live terminal output via SSE. Press Ctrl+C to stop."
        }),
        serde_json::json!({
            "name": "terminals kill",
            "description": "Kill a terminal session",
            "parameters": [
                {"name": "terminal_id", "type": "string", "required": false, "positional": true, "description": "Terminal ID (defaults to the cwd worktree's first terminal)"},
            ],
            "notes": "Kills the terminal's PTY process and cleans up the session."
        }),
        serde_json::json!({
            "name": "terminals attach",
            "description": "Attach to a terminal (stream output + send input interactively)",
            "parameters": [
                {"name": "terminal_id", "type": "string", "required": false, "positional": true, "description": "Terminal ID (defaults to the cwd worktree's first terminal)"},
            ],
            "notes": "Streams terminal output to stdout while reading stdin line-by-line and sending it to the terminal.\nPress Ctrl+C to detach. Best for running commands, not full TUI interaction (use web UI for that)."
        }),
        serde_json::json!({
            "name": "terminals restart-daemon",
            "description": "Restart the terminal daemon, ending every terminal it hosts",
            "parameters": [],
            "notes": "Ends every terminal hosted by the current-build terminal daemon; panes show the process exited and can be reopened, with their scrollback and working directory restored. Sessions from a previous version of Band, on a retired daemon, are left running."
        }),
        serde_json::json!({
            "name": "open",
            "description": "Open a file in the active Band worktree's editor pane",
            "parameters": [
                {"name": "file_path", "type": "string", "required": true, "positional": true, "description": "Path to the file (absolute, or relative to cwd). Optionally suffixed with ':line', ':line:col', or ':line-lineEnd'."},
                {"name": "--worktree", "type": "string", "required": false, "description": "Worktree ID (overrides the dashboard's active worktree)"},
                {"name": "--no-focus", "type": "boolean", "required": false, "description": "Don't raise the dashboard window to the foreground after opening"},
            ],
            "notes": "Opens the file in the dashboard's currently focused worktree. When `--worktree` is omitted, the server uses the worktree most recently focused in the Band dashboard — exits non-zero if no worktree is active. Relative paths are resolved against the current working directory. Paths inside the worktree open as normal editor tabs; paths outside any worktree root open as external tabs (same surface as desktop Cmd+O / \"Open File…\"). Line/column suffixes (`src/main.rs:42:5`, `src/main.rs:5-10`) are supported and dropped into the editor's cursor position.\n\nExample:\n```sh\n# Open the file in whichever worktree the dashboard is currently focused on\nband open src/main.rs\n\n# Jump to line 42, column 5\nband open src/main.rs:42:5\n\n# Override the active-worktree fallback\nband open src/main.rs --worktree my-app/feat/auth\n\n# An out-of-worktree file opens as an external tab (worktree-relative\n# routing is bypassed; the FileViewer reads via the server's\n# readExternalFile capability).\nband open ~/Downloads/v3.js\n```"
        }),
        serde_json::json!({
            "name": "notify",
            "description": "Receive coding-agent hook notifications (reads JSON from stdin)",
            "parameters": [
                {"name": "--agent", "type": "string", "required": false, "description": "Agent type that sent the hook (e.g. `claude-code`). Omit to let the server work it out from the payload or the worktree."},
            ],
            "notes": "Not called directly — registered as a coding-agent hook by the Band dashboard (`band notify --agent claude-code`). Forwards the raw payload, plus `BAND_DISPATCH` and `BAND_TERMINAL_ID` from the environment, to the server, which reads it with the sending agent's rules to derive that agent session's status."
        }),
        serde_json::json!({
            "name": "schema",
            "description": "Show command schemas as JSON",
            "parameters": [
                {"name": "command", "type": "string", "required": false, "positional": true, "description": "Command name (omit to list all commands)"},
            ]
        }),
        serde_json::json!({
            "name": "skills install",
            "description": "Install (or refresh) skills into ~/.agents/skills and symlink each detected coding agent's skills/ folder",
            "parameters": [
                {"name": "--home", "type": "string", "required": false, "description": "Override the destination home dir (advanced; mostly for tests). Defaults to $HOME."},
                {"name": "--filter", "type": "string", "required": false, "description": "Filter which skills to install by name (substring match)"},
            ],
            "notes": "Idempotent: leaves a correct existing symlink alone; surfaces a clear conflict (without overwriting) when a different symlink or a real directory occupies the target path. Supported agents: claude-code, codex, gemini-cli, opencode. cursor-cli is excluded (no skills dir)."
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
