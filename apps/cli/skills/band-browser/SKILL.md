---
name: band-browser
version: 0.1.0
description: Manage Band browser tabs via the CLI. Use when the user wants to create, list, navigate, inspect, or remove a browser tab inside a Band workspace. Triggers include "open browser", "navigate to URL", "browser tab", "browser pane", "remove browser tab".
allowed-tools: Bash
argument-hint: browsers [list|create|navigate|get|remove] [args...]
commands: browsers
---

# Band Browser Tabs

Browser tabs are web views attached to a Band workspace. Each tab has its own URL and status, and can be driven from the CLI.

This skill is focused on **browser tab management only**. For broader operations see the sibling skills:

- **`band`** — workspaces, projects, cronjobs, tunnel, settings.
- **`band-chat`** — agent chat panes inside a workspace.
- **`band-terminal`** — terminal sessions inside a workspace.

## Prerequisites

The Band server must be running (started by the Band dashboard app). Connects to `http://localhost:3456` by default. See the `band` skill for general setup and the workspace lifecycle.

## JSON Output

All commands support `--output json` (or `BAND_OUTPUT=json` env var) for structured output.

- **Success**: JSON object to stdout, exit code 0
- **Error**: `{"error": "message"}` to stderr, exit code 1

## Commands

### List browser tabs for a workspace

```sh
band browsers list [workspace_id]
```

Text output: `ID\tNAME\tURL\tSTATUS` (tab-separated table).
JSON output: `{"browsers": [{"id": "...", "name": "...", "url": "...", "status": "..."}]}`

### Create a new browser tab in a workspace

```sh
band browsers create [workspace_id] [--url <string>] [--name <string>]
```

Text output: the new browser tab ID.
JSON output: `{"browser": {"id": "...", ...}}`

### Navigate a browser tab to a URL

```sh
band browsers navigate [browser_id] --url <string>
```

Updates the browser tab's URL in the server state. When `browser_id` is omitted, auto-detects the workspace from cwd and targets that workspace's first browser tab. Mirrors the shape of `chats send [chat_id] --message ...` and `terminals send [terminal_id] --data ...` — panel ID is positional, data is a flag.

### Get a browser tab's current state

```sh
band browsers get [browser_id]
```

Text output: formatted key-value pairs.
JSON output: `{"browser": {"id": "...", "name": "...", "url": "...", "status": "..."}}`

### Remove a browser tab

```sh
band browsers remove [browser_id]
```

Removes the browser tab and cleans up state.

## Default workspace and browser resolution

Every `band browsers` subcommand auto-detects the workspace from the current working directory (matched against registered workspace paths) when `[workspace_id]` is omitted, and resolves to the workspace's first browser tab when `[browser_id]` is omitted. So the typical flow from inside a workspace is just `band browsers navigate --url <url>` — no IDs to type.

You only need to pass an explicit ID when you're outside the workspace's cwd or you want to target a specific tab among several.

## Workflows

### Open a tab and inspect its state

```sh
# Create a new tab pre-loaded with a URL (workspace auto-detected from cwd)
bid=$(band browsers create --url https://example.com --name "docs" --output json | jq -r .browser.id)

# Read the current state — no browser_id needed if it's the only tab
band browsers get
```

### Navigate the active tab

```sh
# Panel ID positional, URL via --url (matches `chats send --message ...`
# and `terminals send --data ...`).
band browsers navigate --url https://example.com/changelog

# Or target a specific tab:
band browsers navigate "$bid" --url https://example.com/changelog
```

### List and clean up tabs

```sh
band browsers list --output json | jq '.browsers[].id' | \
  xargs -n1 band browsers remove
```

## Cross-references

- To find the workspace ID explicitly, use `band workspaces list` (see the `band` skill).
- For shell access, see `band-terminal`. For agent chats, see `band-chat`.

## Configuration

See the `band` skill for environment variables (`BAND_SERVER_URL`, `BAND_TOKEN`, `BAND_OUTPUT`, `BAND_HOME`).
