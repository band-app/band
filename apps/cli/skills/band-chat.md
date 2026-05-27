---
name: band-chat
version: 0.1.0
description: Send messages to coding agents, stream their output, and manage chat panes via the Band CLI. Use when the user wants to send a chat message, watch a chat's running task, list, create, stop, remove, or label agent chat panes. Triggers include "send message to chat", "chat with agent", "watch chat", "stream chat output", "create chat pane", "list chats", "stop chat", "remove chat", "label chat", "tag chat", "submit prompt to workspace".
allowed-tools: Bash
argument-hint: chats [args...]
commands: chats
---

# Band Chats

All chat operations live under a single `band chats <subcommand>` group: `list/create/send/watch/stop/remove`.

The primary way to drive a coding agent from the CLI is `band chats send` — it sends a message to a workspace's *active* chat panel (auto-detected from cwd) and lazy-creates a "Chat" panel if the workspace has none.

Chat panes are agent processes attached to a Band workspace. Each chat pane has its own conversation history and can run a different agent, model, or mode.

This skill is focused on **chat pane management only**. For broader operations see the sibling skills:

- **`band`** — workspaces, projects, cronjobs, tunnel, settings.
- **`band-terminal`** — terminal sessions inside a workspace.
- **`band-browser`** — browser tabs inside a workspace.

## Prerequisites

The Band server must be running (started by the Band dashboard app). Connects to `http://localhost:3456` by default. See the `band` skill for general setup and the workspace lifecycle.

## JSON Output

All commands support `--output json` (or `BAND_OUTPUT=json` env var) for structured output.

- **Success**: JSON object to stdout, exit code 0
- **Error**: `{"error": "message"}` to stderr, exit code 1

<!-- COMMANDS -->

## Default workspace and chat resolution

Every `band chats` subcommand auto-detects the workspace from the current working directory (matched against registered workspace paths) when no workspace is given, and resolves to the workspace's *active* chat panel when no chat ID is given. So the typical flow from inside a workspace is just `band chats send --message "..."` — no IDs to type.

You only need to pass an explicit ID when:

- you're not inside the workspace's directory (use `--workspace <ws_id>` for `chats send`, or pass the workspace ID positionally for `chats list/create`), or
- the workspace has multiple chats and you want to target a specific one (pass the chat ID positionally to `chats send/watch/stop/remove`).

## Workflows

### Send a message (most common)

```sh
# From inside a workspace directory: workspace auto-detected from cwd,
# chat auto-resolved to the active panel from the saved dashboard layout.
# If the workspace has no chats yet, the server lazy-creates one.
band chats send --message "Fix the failing tests"

# With an explicit workspace (when not in its cwd)
band chats send --workspace ws_abc123 --message "Fix the failing tests"

# Target a specific chat pane instead of the active one
band chats send chat_abc --message "Investigate the perf regression"

# Override agent / model / mode for one-off prompts
band chats send --mode plan --model claude-opus-4-20250514 \
  --message "Plan the migration to v2 of the auth API"
```

### Send a message to a freshly-created chat

```sh
# Create a chat pane (workspace auto-detected) and capture its ID
chat=$(band chats create --name "review" --output json | jq -r .chat.id)

# Send the prompt to that specific chat
band chats send "$chat" --message "Summarize the changes on this branch"
```

### List chats in the current workspace

```sh
band chats list --output json | jq '.chats[] | select(.status == "running")'
```

### Run a chat with a specific agent and model

```sh
band chats create \
  --name "planning" \
  --agent claude-code \
  --model claude-opus-4-20250514 \
  --mode plan
```

### Watch a chat's running task as raw NDJSON

```sh
# No chat_id: stream the cwd workspace's first chat pane.
band chats watch

# Pipe through jq for live filtering — for example, only text deltas:
band chats watch | jq -r 'select(.type == "text-delta") | .delta'

# Exits immediately with no output if the chat has no running task,
# so it's safe to invoke speculatively after `band chats send`.
band chats send --message "Summarize the diff"
band chats watch
```

### Stop and remove a chat

```sh
# Abort the running task in the cwd workspace's first chat
band chats stop

# Permanently remove that chat (kills the agent process)
band chats remove

# Or target a specific chat by ID
band chats stop chat_abc
band chats remove chat_abc
```

### Tag chats with labels

Labels are free-form `key=value` metadata you can use to organize chats (e.g. a plan/implement/review pipeline, tagging by feature area, or marking chats owned by a particular workflow). They appear in the `LABELS` column of `band chats list` as `k=v,k=v` (sorted by key).

The `band:` key prefix is reserved for server-internal labels (e.g. `band:cronId` set automatically when the cronjob scheduler owns a chat) and is rejected from the CLI.

```sh
# Seed labels at creation time (repeat --label for each pair)
band chats create --name "Plan" --label phase=plan --label owner=alice

# Add or overwrite labels on an existing chat (additive merge — other labels are preserved)
band chats label chat_abc phase=implement priority=high

# Remove labels by key (other labels are preserved; unknown keys are ignored)
band chats unlabel chat_abc priority

# Filter the list client-side with jq
band chats list --output json | jq '.chats[] | select(.labels.phase == "plan")'
```

## Cross-references

- To find the workspace ID explicitly, use `band workspaces list` (see the `band` skill).
- `band chats watch` streams a chat's running task; `band chats stop` aborts it. Both default to the cwd workspace's first chat pane when no ID is given.

## Configuration

See the `band` skill for environment variables (`BAND_SERVER_URL`, `BAND_TOKEN`, `BAND_OUTPUT`, `BAND_HOME`).
