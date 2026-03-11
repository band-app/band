---
name: band
version: 0.1.0
description: Programmatic workspace management for Band. Use when the user wants to create, list, or remove Band workspaces or projects, manage tasks, manage tunnels, or check settings via the Band CLI.
allowed-tools: Bash
argument-hint: [command] [args...]
---

# Band CLI

Thin client for the Band web server. All state, git operations, and script execution happen server-side.

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

### List projects

```sh
band projects list
```

Text output: `name\tpath\tN worktree(s)` (tab-separated).
JSON output: `{"projects": [{"name": "...", "path": "...", "worktreeCount": N}]}`

### Register a project

```sh
band projects add <path> [--label <label>]
```

Registers an existing git repository. Detects the default branch automatically. Returns the project name.

### Unregister a project

```sh
band projects remove <name>
```

Removes the project from Band's registry (does not delete the repository).

### List workspaces

```sh
band workspaces list [project]
```

Text output: `project\tbranch\tpath` (tab-separated, one per line).
JSON output: `{"workspaces": [{"project": "...", "branch": "...", "path": "..."}]}`

### Create a workspace

```sh
band workspaces create <project> <branch> [--base <branch>] [--prompt <text>]
```

Returns the worktree path. Idempotent — creating an existing workspace returns its path. Runs `.band/config.json` `setup` script if present (non-fatal).

**Always use `--prompt` when the user wants work to begin immediately.** This submits a task to the coding agent right after workspace creation, so the agent starts working without a separate step. Only omit `--prompt` when the workspace is being created for manual/later use.

### Remove a workspace

```sh
band workspaces remove <project> <branch>
```

Runs `.band/config.json` `teardown` script before removal (non-fatal). Cleans up all associated files.

### Show settings

```sh
band settings
```

Pretty-prints the current settings as JSON. With `--output json`, outputs compact JSON.

### Tunnel status

```sh
band tunnel status
```

Shows whether the tunnel is running and its URL.

### Start tunnel

```sh
band tunnel start [--subdomain <name>]
```

Starts the remote tunnel. Returns the tunnel URL.

### Stop tunnel

```sh
band tunnel stop
```

Stops the remote tunnel.

### List tasks

```sh
band tasks list [--project <name>] [--status <running|completed|failed>]
```

Text output: `ID\tSTATUS\tWORKSPACE\tPROMPT` (tab-separated table).
JSON output: `{"tasks": [{"id": "...", "status": "...", "project": "...", "branch": "...", "prompt": "..."}]}`

### Create a task

```sh
band tasks create <workspace_id> --prompt <text>
```

Submits a new task to the coding agent. Returns the task ID.
JSON output: `{"id": "...", "workspaceId": "..."}`

### Cancel a task

```sh
band tasks cancel <task_id>
```

Cancels a running task.
JSON output: `{"cancelled": true, "taskId": "..."}`

### Re-run a task

```sh
band tasks rerun <task_id>
```

Re-runs a completed or failed task.

### Watch a task

```sh
band tasks watch [<task_id>] [--workspace <workspace_id>]
```

Streams task output in real-time. Either provide a task ID or `--workspace` to watch the latest task for that workspace.

### Hook notifications

```sh
echo '{"hook_event_name":"Stop","cwd":"/path"}' | band notify
```

Not called directly — registered as a Claude Code hook by the Band dashboard.

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

### Task management

```sh
# List running tasks
band tasks list --status running

# Submit a task to a workspace
band tasks create ws_abc123 --prompt "Fix the failing tests"

# Watch task output
band tasks watch --workspace ws_abc123

# Cancel a stuck task
band tasks cancel tsk_1234567890

# Re-run a failed task
band tasks rerun tsk_1234567890
```

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
- Project and branch names must not contain control characters or path traversals (`../`)
- Exit code 0 = success, 1 = error

## Configuration

| Setting       | Env var           | Default                      |
| ------------- | ----------------- | ---------------------------- |
| Server URL    | `BAND_SERVER_URL` | `http://localhost:3456`      |
| Auth token    | `BAND_TOKEN`      | from `~/.band/settings.json` |
| Output format | `BAND_OUTPUT`     | `text`                       |
| Band home dir | `BAND_HOME`       | `~/.band`                    |
