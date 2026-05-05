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

<!-- COMMANDS -->

## Workflows

### Open a tab and inspect its state

```sh
# Create a new tab pre-loaded with a URL
bid=$(band browsers create ws_abc123 --url https://example.com --name "docs" --output json | jq -r .browser.id)

# Read the current state
band browsers get "$bid"
```

### Navigate an existing tab

```sh
band browsers navigate "$bid" https://example.com/changelog
```

### List and clean up tabs

```sh
band browsers list ws_abc123 --output json | jq '.browsers[].id' | \
  xargs -n1 band browsers remove
```

## Cross-references

- To find the workspace ID, use `band workspaces list` (see the `band` skill).
- For shell access, see `band-terminal`. For agent chats, see `band-chat`.

## Configuration

See the `band` skill for environment variables (`BAND_SERVER_URL`, `BAND_TOKEN`, `BAND_OUTPUT`, `BAND_HOME`).
