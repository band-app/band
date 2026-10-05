---
name: band
version: 0.1.0
description: Programmatic workspace management for Band. Use when the user wants to create, list, or remove Band workspaces or projects, start a coding agent in a workspace or list its agent sessions, manage tunnels, manage cronjobs, or check settings via the Band CLI. Triggers include "create workspace", "list projects", "band workspace", "band project", "start an agent", "list agent sessions", "schedule a job". For sending chat messages to coding agents, see the `band-chat` skill.
allowed-tools: Bash
argument-hint: "[command] [args...]"
---

# Band CLI

Thin client for the Band web server. All state, git operations, and script execution happen server-side.

This skill covers **core workspace, project, agent, cronjob, and tunnel** management. For domain-specific commands, see the sibling skills:

- **`band-chat`** — chat panes (`band chats list/create/send/watch/stop/remove/label/unlabel`)
- **`band-terminal`** — terminal sessions (`band terminals list/create/send/output/kill/attach`)
- **`band-browser`** — browser tabs (`band browsers list/create/navigate/get/remove`)

## Prerequisites

The Band server must be running (started by the Band dashboard app). Connects to `http://localhost:3456` by default.

## JSON Output

All commands support `--output json` (or `BAND_OUTPUT=json` env var) for structured output.

- **Success**: JSON object to stdout, exit code 0
- **Error**: `{"error": "message"}` to stderr, exit code 1

## Schema Introspection

```sh
# List all commands with parameters and types
band schema

# Show a specific command's schema
band schema "workspaces create"
```

## Commands

### List registered projects

```sh
band projects list
```

Text output: `name\tpath\tN worktree(s)` (tab-separated).
JSON output: `{"projects": [{"name": "...", "path": "...", "worktreeCount": N}]}`

### Register an existing repository as a project

```sh
band projects add <path> [--label <string>]
```

Registers an existing git repository. Detects the default branch automatically. Returns the project name.

### Unregister a project

```sh
band projects remove <name>
```

Removes the project from Band's registry (does not delete the repository).

### List workspaces, optionally filtered by project

```sh
band workspaces list [project]
```

Text output: `project\tbranch\tpath` (tab-separated, one per line).
JSON output: `{"workspaces": [{"project": "...", "branch": "...", "path": "..."}]}`

### Create a new workspace (git worktree + state registration)

```sh
band workspaces create <project> <branch> [--base <string>] [--prompt <string>] [--mode <string>] [--model <string>] [--agent <string>] [--via <string>] [--labels <k=v,...>] [--requires <k=constraint>...] [--any-host] [--isolation worktree|container|vm] [--host-project-path <string>]
```

Returns the worktree path and the dispatch target. Idempotent — creating an existing workspace returns its path. Runs `.band/config.json` `setup` script if present (non-fatal).

**Always use `--prompt` when the user wants work to begin immediately.** This submits a task to the coding agent right after workspace creation, so the agent starts working without a separate step. Only omit `--prompt` when the user explicitly wants to create the workspace for manual/later use.

**Dispatch target (`--via`, issue #551).** With `--prompt`, the prompt is dispatched to either:
- `terminal` (CLI default) — spawns the vendor CLI in a fresh terminal pane with the prompt as the first positional argument (cmux-style: `claude "<prompt>"`, `codex "<prompt>"`, …). Returns a `terminalId` in the JSON output.
- `chat` — submits a streaming task to the workspace's chat pane (the web UI default).

Precedence, highest first: `--via` flag → `BAND_DISPATCH` env var → `.band/config.json` `workspace.defaultVia` → `~/.band/settings.json` `cli.defaultVia` → `terminal`.

When to use `--prompt` (most cases):
```sh
# User says "create a workspace and implement X" or "start working on X"
band workspaces create my-app feat/auth --prompt "Implement GitHub issue #42: Add JWT authentication"

# User says "create a workspace for issue #99 and start implementing"
band workspaces create my-app fix/bug-99 --prompt "Fix issue #99: login redirect loop. See https://github.com/org/repo/issues/99"

# Force chat dispatch when terminal is the user-level default
band workspaces create my-app feat/auth --prompt "..." --via chat
```

When to omit `--prompt` (rare — user explicitly wants no task):
```sh
# User says "just create a workspace, I'll work on it myself"
band workspaces create my-app feat/experiment
```

**Placement (`--labels`, `--requires`, `--any-host`, `--isolation`).** These pick the host by criteria instead of by id. `--labels zone=home,gpu=a100` needs an online host carrying every label. `--requires node=>=24 --requires os=linux` needs host facts (`node`, `git`, `os`, `arch`). The hub uses the least loaded host that fits. When none fits, the command prints `provisioning (host request <id>)` and the JSON output has `provisioning.requestId`: the workspace appears once a runner starts a matching host, or fails with a reason after `BAND_PLACEMENT_TIMEOUT_MS` (10 minutes by default). `--isolation container` or `vm` asks for a worker of its own for that workspace, started by a runner that offers the level (`worktree`, the default, may share a worker). With no such runner configured the command fails at once with `No runner offers isolation <level>`. `--host-project-path` says where the repository is on the chosen host the first time the project is used there.

**Do NOT create a workspace without `--prompt` and then separately run `band chat`.** That is two steps for what `--prompt` does in one.

### Remove a workspace (git worktree + state cleanup)

```sh
band workspaces remove <project> <name>
```

`<name>` is the workspace's stable identity — the branch it was created on (unchanged even if the git branch was later switched).

Runs the `.band/config.json` `teardown` command in a terminal tab of the workspace first and waits for it (up to 60s; a failure does not stop the removal). Cleans up all associated files.

### Start a coding agent in a workspace

```sh
band agents launch [workspace_id] [--agent <string>] [--mode <string>] [--prompt <string>]
```

Starts an agent session. `--mode gui` opens a chat pane and submits the prompt to the agent. `--mode tui` opens a terminal running the agent's CLI with the prompt pre-loaded (`claude "<prompt>"`, `codex "<prompt>"`, ...). `chat` and `terminal` are accepted as aliases. Mode precedence, highest first: `--mode` → `BAND_DISPATCH` env var (set in every Band terminal and chat agent, so an agent starts new agents the way it runs itself) → `.band/config.json` `workspace.defaultVia` → the server's `agents.defaultMode` setting (Settings > Coding Agents > "Open programmatically created agents in"). `--agent` picks a coding agent ID from settings; the default agent is used when omitted. The workspace is auto-detected from the cwd when `workspace_id` is omitted.

An agent with no terminal mode (Cursor CLI) starts as a chat, and the output carries a notice.

Text output: `<mode>\t<chat or terminal ID>`, plus a `note:` line after a fallback.
JSON output: `{"agentSession": {...}, "mode": "gui" | "tui", "chatId": "...", "terminalId": "...", "notice": "..."}`. `chatId` is set for gui, `terminalId` for tui, `notice` only after a fallback.

```sh
# Start the default agent in the cwd's workspace, in the server's default mode
band agents launch --prompt "Fix the failing test in auth.test.ts"

# Start Codex in a terminal
band agents launch my-app-feat-auth --agent codex --mode tui --prompt "Review the diff"
```

To start an agent in a new workspace, use `band workspaces create --prompt` instead.

### List the running agent sessions of a workspace

```sh
band agents list [workspace_id]
```

An agent session is one run of a coding agent, in a chat (`gui`) or in a terminal (`tui`). A session keeps its mode for its whole life. Ended sessions are not listed.

Text output: `SESSION ID\tAGENT\tMODE\tSTATE\tPANE\tPROVIDER SESSION` (tab-separated table). PANE is the chat ID for gui sessions and the terminal ID for tui sessions; PROVIDER SESSION is the agent's own session ID once it is known.
JSON output: `{"agentSessions": [{"id": "...", "workspaceId": "...", "agentDefinitionId": "...", "providerSessionId": "..." | null, "mode": "gui" | "tui", "chatId": "..." | null, "terminalId": "..." | null, "state": "starting" | "running", "createdAt": N, "updatedAt": N}]}`

### Show current settings

```sh
band settings
```

Pretty-prints the current settings as JSON. With `--output json`, outputs compact JSON.

### Show tunnel status

```sh
band tunnel status
```

Shows whether the tunnel is running and its URL.

### Start the remote tunnel

```sh
band tunnel start
```

Starts the remote tunnel. Returns the tunnel URL.

### Stop the remote tunnel

```sh
band tunnel stop
```

Stops the remote tunnel.

### List the hosts workspaces can run on

```sh
band hosts list
```

Shows each host's id, name, status (`online`, `offline`, `lost`, `disposed`), labels, agents, roots and last contact. The local host is always listed. With `--output json` it is `{"hosts": [...]}`, and each host also carries `capabilities` and `home`.

### Remove a worker host

```sh
band hosts remove <id>
```

Removes an offline worker host that has no workspaces and revokes its tokens, so the worker cannot dial in again. Needs an admin token. The local host, an online or lost host, and a host with workspaces are refused.

### List the runners and read their logs

```sh
band runners list
band runners log <request-id>
```

A runner is a pair of scripts the hub runs to start a worker when `band workspaces create --labels ...` finds no host. `list` shows each runner's id, spawn script, labels, running count against its limit and timeout, and any entry of `runners` in `settings.json` that the hub skips as invalid. `log` prints what the hooks printed for one host request (the id comes from the provisioning result), with tokens removed. Runners are set up in `settings.json`; see `docs/runner-hooks.md` in the Band repository.

### Validate a repository's environment file

```sh
band env validate [path]
```

Checks `.band/environment.json` in the repository at `path` (default: the current directory), or the file itself. The path must exist on the hub's machine. Prints `OK <file>` and exits 0, or prints each problem with its key path and exits 1. With `--output json` it prints the parsed environment and the issues. Needs an admin token.

### Build a project's environment image

```sh
band env build <project> [--force] [--no-wait]
band env status <project>
```

Builds the image for the project's `.band/environment.json` at the default branch: the worker base, the toolchain from `build`, then the result of `install`. An image for the same key (environment file, what it references, lockfiles, worker base) is reused and reported as a cache hit. `build` follows the log and exits 0 for a ready image or a cache hit, 1 for a failed build. `--no-wait` returns once the build has started. `status` prints the current image (the newest ready build; a failed build never replaces it) and the latest build with its log. The hub builds on its builder host (settings `environmentBuilder.hostId`, default the hub's machine). `build` needs an admin token.

### List, create and revoke the hub's tokens

```sh
band tokens list
band tokens create-device [--label <string>] [--admin]
band tokens revoke <id>
```

`list` shows each token's id, kind, label, state and last use, never its secret. `create-device` prints a new device token once, for a UI or script. Add `--admin` only for a token that must manage tokens too; without it the token gets 403 on `band tokens`. These commands need an admin token, which the shared token in `settings.json` is. `revoke` stops a token from authenticating. The shared token in `settings.json` cannot be revoked. These commands change who can reach the hub, so run them only when the user asks.

### Store credentials in the hub's vault

```sh
band vault list
printf '%s' "$VALUE" | band vault put <name> [--kind api_key|env] [--scope global|project:<name>] [--description <string>]
band vault delete <id>
band vault rotate-key
```

The hub keeps credentials encrypted and never shows a value again: `list` prints id, name, kind, scope and last use. `put` reads the value from stdin (`--value` also works, but shows in the process list). OAuth connections are made in Settings > Credentials, and `delete` revokes one at its server. These commands need an admin token. Run them only when the user asks, and never print or log a value.

### List cronjobs, optionally filtered by project or workspace

```sh
band cronjobs list [--project <string>] [--workspace <string>]
```

### Create a new scheduled cronjob

```sh
band cronjobs create <key> --name <string> --prompt <string> --cron <string> [--scope <string>] [--workspace-id <string>] [--via <string>] [--disabled]
```

`--via` picks where each fire dispatches the prompt: `chat` (submits a task to the cronjob's dedicated chat pane — the default and backward-compatible behavior) or `terminal` (spawns the agent's vendor CLI in a fresh self-closing PTY pane; if the agent has no vendor CLI it silently falls back to chat). When omitted it resolves via the same precedence as `workspaces create`: `--via` flag → `BAND_DISPATCH` env → `.band/config.json` `workspace.defaultVia` → `~/.band/settings.json` `cli.defaultVia` → `terminal`. A terminal fire is skipped (recorded `skipped`) when the previous run's pane is still active, so an agent that runs longer than the interval is never interrupted.

### Update an existing cronjob

```sh
band cronjobs update <key> <id> [--name <string>] [--prompt <string>] [--cron <string>] [--enable] [--disable]
```

### Delete a cronjob

```sh
band cronjobs delete <key> <id>
```

### Manually trigger a cronjob now

```sh
band cronjobs trigger <key> <id>
```

### Open a file in the active Band workspace's editor pane

```sh
band open <file_path> [--workspace <string>] [--no-focus]
```

Opens the file in the dashboard's currently focused workspace. When `--workspace` is omitted, the server uses the workspace most recently focused in the Band dashboard — exits non-zero if no workspace is active. Relative paths are resolved against the current working directory. Paths inside the workspace open as normal editor tabs; paths outside any workspace root open as external tabs (same surface as desktop Cmd+O / "Open File…"). Line/column suffixes (`src/main.rs:42:5`, `src/main.rs:5-10`) are supported and dropped into the editor's cursor position.

Example:
```sh
# Open the file in whichever workspace the dashboard is currently focused on
band open src/main.rs

# Jump to line 42, column 5
band open src/main.rs:42:5

# Override the active-workspace fallback
band open src/main.rs --workspace my-app/feat/auth

# An out-of-workspace file opens as an external tab (workspace-relative
# routing is bypassed; the FileViewer reads via the server's
# readExternalFile capability).
band open ~/Downloads/v3.js
```

### Receive coding-agent hook notifications (reads JSON from stdin)

```sh
band notify [--agent <type>]
```

Not called directly — registered as a coding-agent hook by the Band dashboard (`band notify --agent claude-code`). Forwards the raw payload, plus `BAND_DISPATCH` and `BAND_TERMINAL_ID` from the environment, to the server, which reads it with the sending agent's rules to derive that agent session's status.

### Show command schemas as JSON

```sh
band schema [command]
```

### Install (or refresh) skills into ~/.agents/skills and symlink each detected coding agent's skills/ folder

```sh
band skills install [--home <string>] [--filter <string>]
```

Idempotent: leaves a correct existing symlink alone; surfaces a clear conflict (without overwriting) when a different symlink or a real directory occupies the target path. Supported agents: claude-code, codex, gemini-cli, opencode. cursor-cli is excluded (no skills dir).

## Workflows

### Feature branch workflow

```sh
# Create workspace, get path
path=$(band workspaces create my-app feat/login --output json | jq -r .path)
cd "$path"

# ... do work ...

# Clean up
band workspaces remove my-app feat/login
```

### Agent task submission

```sh
band workspaces create my-app feat/auth --prompt "Add JWT authentication to the API"
```

### Enumerate workspaces

```sh
band workspaces list --output json | jq '.workspaces[] | select(.project == "my-app") | .branch'
```

### Open a file in the dashboard

`band open <file>` routes a file to whichever workspace is currently
focused in the Band dashboard (the most recently active one). Use it
from grep / stack-trace output to drop yourself straight into the
editor without naming the workspace.

```sh
# Open the file in whichever workspace the dashboard is currently focused on
band open src/main.rs

# Jump to line 42, column 5
band open src/main.rs:42:5

# Override the active-workspace fallback
band open src/main.rs --workspace my-app/feat/auth

# Open an arbitrary file from outside any workspace — opens as an
# external editor tab (the same surface as desktop Cmd+O / "Open File…")
band open ~/Downloads/v3.js
```

Files inside the target workspace open as normal editor tabs.
Files outside any workspace root open as external tabs, hosted in
the active workspace's editor pane. Errors when no workspace is
active in the dashboard and no `--workspace` is supplied, or when
the file doesn't exist on disk.

### Drive a coding agent

To send a message to a workspace's chat (the primary way to drive the
coding agent), use `band chats send` — see the **`band-chat`** skill. Task
lifecycle (status, cancel, re-run) is managed inside the dashboard
rather than from the CLI.

### Project management

```sh
# Register a project
band projects add /Users/me/code/my-app

# List all projects
band projects list

# Remove a project
band projects remove my-app
```

## Invariants

- The CLI never modifies files directly — all operations go through the server API
- `workspaces create` is idempotent — creating an existing workspace returns its path
- `setup` runs in its own terminal tab after workspace creation, in parallel with the `--prompt` dispatch (the agent does not wait for it). `teardown` runs in a terminal tab before removal, and removal waits for it. Both are non-fatal
- Workspace file copying runs after `git worktree add` and before the `setup` script — see "Workspace file copying" below
- Project and branch names must not contain control characters or path traversals (`../`)
- Exit code 0 = success, 1 = error

## Workspace file copying

Workspaces are fresh git worktrees, so untracked files (`.env`, `.env.local`,
local credentials, IDE overrides) are missing by default. Band can copy a
declared set of those files from the project's main checkout into each new
worktree, driven by either of two sources at the project root:

**Option A — `.band/config.json::workspace.copyFiles`** (explicit list,
supports globs):

```json
{
  "workspace": {
    "copyFiles": [".env", ".env.local", "config/*.local.json", ".vscode/settings.json"]
  }
}
```

**Option B — `.worktreeinclude`** (gitignore-syntax, Claude Code parity):

```
.env*
config/*.local.json
```

Only entries that match a `.worktreeinclude` pattern AND are gitignored are
copied. Tracked files are never duplicated.

When both sources are present, the resulting file sets are UNIONed and
de-duped by absolute source path. Missing source files are skipped with a
warning (not fatal). Files are copied (not symlinked) so edits in the
worktree don't bleed back to the main checkout. Out of scope: per-user
overrides, copy-back on cleanup, variable substitution.

## Configuration

| Setting          | Env var           | Default                      |
| ---------------- | ----------------- | ---------------------------- |
| Server URL       | `BAND_SERVER_URL` | `http://localhost:3456`      |
| Auth token       | `BAND_TOKEN`      | from `~/.band/settings.json` |
| Output format    | `BAND_OUTPUT`     | `text`                       |
| Band home dir    | `BAND_HOME`       | `~/.band`                    |
| Dispatch target  | `BAND_DISPATCH`   | `terminal` (from CLI)        |

### `workspaces create --prompt` dispatch target (issue #551)

By default the CLI dispatches the `--prompt` value to a fresh **terminal**
pane running the vendor coding agent CLI (cmux-style: `claude "<prompt>"`,
`codex "<prompt>"`, `opencode "<prompt>"`, `gemini "<prompt>"`). The web
UI keeps its existing **chat** pane behavior.

Override precedence (highest first):

1. `--via {chat,terminal}` flag.
2. `BAND_DISPATCH` env var.
3. `.band/config.json` per-repo: `{"workspace": {"defaultVia": "chat"}}`.
4. `~/.band/settings.json` per-user: `{"cli": {"defaultVia": "chat"}}`.
5. Built-in CLI default: `terminal`.

When `via=terminal`, the JSON output includes a `terminalId` you can wire
into `band terminals attach <id>` or `band terminals output <id> -f`.
When the chosen coding agent doesn't expose a usable interactive CLI
(`cursor-cli` today), the server falls back to `chat` and the response's
`via` field reflects the actual dispatch.
