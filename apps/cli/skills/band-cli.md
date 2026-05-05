---
name: band-cli
version: 0.1.0
description: Programmatic workspace management for Band. Use when the user wants to create, list, or remove Band workspaces or projects, send chat messages to coding agents, manage tasks, manage tunnels, manage terminal sessions, or check settings via the Band CLI.
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

<!-- COMMANDS -->

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

### Chat / task management

```sh
# Send a message to the workspace's default chat panel (auto-detects
# the workspace from the current directory, picks the active chat tab)
band chat --message "Fix the failing tests"

# Same, but with an explicit workspace
band chat ws_abc123 --message "Fix the failing tests"

# Target a specific chat pane instead of the default one
band chat ws_abc123 --chat-id chat_abc --message "Investigate the perf regression"

# List running tasks
band tasks list --status running

# Watch task output
band tasks watch --workspace ws_abc123

# Cancel a stuck task
band tasks cancel tsk_1234567890

# Re-run a failed task
band tasks rerun tsk_1234567890
```

### Terminal management

```sh
# Create a terminal running a dev server
tid=$(band terminal create my-app-feat-auth --command "npm run dev" --output json | jq -r .terminalId)

# Check the output
band terminal output "$tid" --lines 20

# Stream live output
band terminal output "$tid" --follow

# Send a command to the terminal
band terminal send "$tid" --data "echo hello\n"

# Attach interactively
band terminal attach "$tid"

# Kill the terminal when done
band terminal kill "$tid"
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
