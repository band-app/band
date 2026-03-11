---
name: band
version: 0.1.0
description: Programmatic workspace management for Band
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

Returns the worktree path. Idempotent — creating an existing workspace returns its path. Runs `.band/config.json` `setup` script if present (non-fatal). With `--prompt`, also submits a task to the coding agent.

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

| Setting | Env var | Default |
|---|---|---|
| Server URL | `BAND_SERVER_URL` | `http://localhost:3456` |
| Auth token | `BAND_TOKEN` | from `~/.band/settings.json` |
| Output format | `BAND_OUTPUT` | `text` |
| Band home dir | `BAND_HOME` | `~/.band` |
