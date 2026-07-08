---
name: band
version: 0.1.0
description: Programmatic workspace management for Band. Use when the user wants to create, list, or remove Band workspaces or projects, manage tunnels, manage cronjobs, or check settings via the Band CLI. Triggers include "create workspace", "list projects", "band workspace", "band project", "schedule a job". For sending chat messages to coding agents, see the `band-chat` skill.
allowed-tools: Bash
argument-hint: "[command] [args...]"
---

# Band CLI

Thin client for the Band web server. All state, git operations, and script execution happen server-side.

This skill covers **core workspace, project, cronjob, and tunnel** management. For domain-specific commands, see the sibling skills:

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
band workspaces create <project> <branch> [--base <string>] [--prompt <string>] [--mode <string>] [--model <string>] [--agent <string>] [--via <string>]
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

**Do NOT create a workspace without `--prompt` and then separately run `band chat`.** That is two steps for what `--prompt` does in one.

### Remove a workspace (git worktree + state cleanup)

```sh
band workspaces remove <project> <name>
```

`<name>` is the workspace's stable identity — the branch it was created on (unchanged even if the git branch was later switched).

Runs `.band/config.json` `teardown` script before removal (non-fatal). Cleans up all associated files.

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
band notify
```

Not called directly — registered as a coding-agent hook by the Band dashboard. Forwards the raw payload to the server, which dispatches to the agent's adapter to derive the workspace status.

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
- `setup` scripts run after workspace creation, `teardown` before removal (both non-fatal)
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
