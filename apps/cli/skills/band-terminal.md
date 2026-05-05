---
name: band-terminal
version: 0.1.0
description: Manage Band terminal sessions via the CLI. Use when the user wants to create, list, send input to, read output from, attach to, or kill a terminal session inside a Band workspace. Triggers include "run command in terminal", "create terminal", "send to terminal", "terminal output", "attach terminal", "terminal pane".
allowed-tools: Bash
argument-hint: terminals [list|create|send|output|kill|attach] [args...]
commands: terminals
---

# Band Terminal Sessions

Terminal sessions are PTY processes attached to a Band workspace. Each terminal has its own scrollback buffer and shell process.

This skill is focused on **terminal management only**. For broader operations see the sibling skills:

- **`band`** — workspaces, projects, cronjobs, tunnel, settings.
- **`band-chat`** — agent chat panes inside a workspace.
- **`band-browser`** — browser tabs inside a workspace.

## Prerequisites

The Band server must be running (started by the Band dashboard app). Connects to `http://localhost:3456` by default. See the `band` skill for general setup and the workspace lifecycle.

## JSON Output

All commands support `--output json` (or `BAND_OUTPUT=json` env var) for structured output.

- **Success**: JSON object to stdout, exit code 0
- **Error**: `{"error": "message"}` to stderr, exit code 1

<!-- COMMANDS -->

## Workflows

### Run a dev server and watch the output

```sh
# Create a terminal running a dev server
tid=$(band terminals create ws_abc123 --command "npm run dev" --output json | jq -r .terminalId)

# Check the last 20 lines
band terminals output "$tid" --lines 20

# Stream live output
band terminals output "$tid" --follow
```

### Send a command to an existing terminal

```sh
# Note the trailing \n — it presses enter
band terminals send "$tid" --data "echo hello\n"
```

### Attach interactively

```sh
band terminals attach "$tid"
# Type commands; Ctrl+C detaches.
```

### Kill a terminal when done

```sh
band terminals kill "$tid"
```

## Cross-references

- To find the workspace ID, use `band workspaces list` (see the `band` skill).
- For agent-driven work in a workspace, use `band-chat` instead of running the agent in a terminal.

## Configuration

See the `band` skill for environment variables (`BAND_SERVER_URL`, `BAND_TOKEN`, `BAND_OUTPUT`, `BAND_HOME`).
