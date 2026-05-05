---
name: band-chat
version: 0.1.0
description: Send messages to coding agents and manage chat panes via the Band CLI. Use when the user wants to send a chat message to a workspace, list, create, stop, or remove agent chat panes. Triggers include "send message to chat", "chat with agent", "create chat pane", "list chats", "stop chat", "remove chat", "submit prompt to workspace".
allowed-tools: Bash
argument-hint: chat|chats [args...]
commands: chat, chats
---

# Band Chat

Two related surfaces share this skill:

- **`band chat`** — quick top-level command that sends a message to a workspace's *active* chat panel (auto-detects the workspace from the current directory). This is the primary way to drive a coding agent from the CLI.
- **`band chats ...`** — full chat-pane lifecycle: list, create, send, stop, and remove. Use this when you need to manage multiple chats per workspace or target a specific chat by ID.

Chat panes are agent processes attached to a Band workspace. Each chat pane has its own conversation history and can run a different agent, model, or mode.

This skill is focused on **chat pane management only**. For broader operations see the sibling skills:

- **`band`** — workspaces, projects, tasks, cronjobs, tunnel, settings.
- **`band-terminal`** — terminal sessions inside a workspace.
- **`band-browser`** — browser tabs inside a workspace.

## Prerequisites

The Band server must be running (started by the Band dashboard app). Connects to `http://localhost:3456` by default. See the `band` skill for general setup and the workspace lifecycle.

## JSON Output

All commands support `--output json` (or `BAND_OUTPUT=json` env var) for structured output.

- **Success**: JSON object to stdout, exit code 0
- **Error**: `{"error": "message"}` to stderr, exit code 1

<!-- COMMANDS -->

## Workflows

### Send a quick message to the active chat (most common)

```sh
# From inside a workspace directory: auto-detects the workspace and
# targets the active chat panel from the saved layout.
band chat --message "Fix the failing tests"

# With an explicit workspace
band chat ws_abc123 --message "Fix the failing tests"

# Target a specific chat pane instead of the active one
band chat ws_abc123 --chat-id chat_abc --message "Investigate the perf regression"
```

### Send a one-off message to a new chat pane

```sh
# Create a chat pane and capture its ID
chat=$(band chats create ws_abc123 --name "review" --output json | jq -r .chat.id)

# Send the prompt
band chats send "$chat" --message "Summarize the changes on this branch"
```

### List chats for a workspace

```sh
band chats list ws_abc123 --output json | jq '.chats[] | select(.status == "running")'
```

### Run a chat with a specific agent and model

```sh
band chats create ws_abc123 \
  --name "planning" \
  --agent claude-code \
  --model claude-opus-4-20250514 \
  --mode plan
```

### Stop and remove a chat

```sh
# Abort the running task without removing the chat
band chats stop "$chat"

# Permanently remove the chat (kills the agent process)
band chats remove "$chat"
```

## Cross-references

- To find the workspace ID, use `band workspaces list` (see the `band` skill).
- To watch the agent's task output, use `band tasks watch` (see the `band` skill).

## Configuration

See the `band` skill for environment variables (`BAND_SERVER_URL`, `BAND_TOKEN`, `BAND_OUTPUT`, `BAND_HOME`).
