---
name: band
version: 0.1.0
description: Programmatic workspace management for Band. Use when the user wants to create, list, or remove Band workspaces or projects, manage tunnels, manage cronjobs, or check settings via the Band CLI. Triggers include "create workspace", "list projects", "band workspace", "band project", "schedule a job". For sending chat messages to coding agents, see the `band-chat` skill.
allowed-tools: Bash
argument-hint: [command] [args...]
commands: projects, workspaces, cronjobs, tunnel, settings, notify, schema, generate-skills
---

# Band CLI

Thin client for the Band web server. All state, git operations, and script execution happen server-side.

This skill covers **core workspace, project, cronjob, and tunnel** management. For domain-specific commands, see the sibling skills:

- **`band-chat`** — chat panes (`band chats chat/list/create/send/watch/stop/remove`)
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

### Drive a coding agent

To send a message to a workspace's chat (the primary way to drive the
coding agent), use `band chats chat` — see the **`band-chat`** skill. Task
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
- Project and branch names must not contain control characters or path traversals (`../`)
- Exit code 0 = success, 1 = error

## Configuration

| Setting       | Env var           | Default                      |
| ------------- | ----------------- | ---------------------------- |
| Server URL    | `BAND_SERVER_URL` | `http://localhost:3456`      |
| Auth token    | `BAND_TOKEN`      | from `~/.band/settings.json` |
| Output format | `BAND_OUTPUT`     | `text`                       |
| Band home dir | `BAND_HOME`       | `~/.band`                    |
