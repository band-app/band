---
title: Run your first task
description: Start a coding agent in a worktree as a chat or a terminal, send it a prompt, and watch its status.
section: get-started
order: 50
---

A task is a prompt you give a coding agent inside a worktree. Band runs the agent on the worker that holds the worktree. Before you start, you need a repo, a worktree, and at least one coding agent installed and logged in on the worker. Band does not install agents. The agents are Claude Code, Codex, OpenCode, Gemini CLI and Cursor CLI, and Settings > Coding Agents lists the ones Band knows about. [Coding agents](coding-agents.md) has the details.

## Chat or terminal

An agent session runs in one of two modes, and it keeps its mode for its whole life.

- **Chat.** The agent runs over the Agent Client Protocol and Band shows it in a chat pane, with tool calls, diffs, permission requests and a prompt box. The CLI calls this mode `gui`.
- **Terminal.** Band starts the agent's own command line interface in a terminal tab, with your prompt pre-loaded. The CLI calls this mode `tui`. Cursor CLI has no such mode, so Band opens a chat for it and says so.

Three settings decide which mode a new agent gets:

- Settings > Coding Agents, "Open agents on this device as" (Chat or Terminal). It applies to agents you start from this browser or app, and it is stored on the device.
- Settings > Coding Agents, "Open programmatically created agents in". It is the server-wide default, `agents.defaultMode` in `~/.band/settings.json`, and it is Chat unless you change it. The CLI, cronjobs and MCP use it, and so does a device with no mode set.
- The CLI flags below, which override both.

## Start a task in the dashboard

1. Open a worktree from the sidebar.
2. Click the plus button in the tab strip ("New tab") and choose New agent. Pick an agent. The default agent is marked "Default".
3. In a chat, type your prompt in the box and press Enter. The reply streams into the pane. In a terminal, the agent's CLI starts and you type to it as you would in any terminal.

You can also give the prompt when you create the worktree. See [Create your first worktree](first-worktree.md). A worktree can hold several chats and terminals at once, each with its own agent.

## Start a task from the CLI

`band agents launch` starts an agent in a worktree. Run it inside the worktree's folder, or pass the worktree id:

```sh
band agents launch my-app-feat-login --mode gui --prompt "Add input validation to all API endpoints"
```

It prints the mode and the id of the chat (`chat_...`) or the terminal that it started. Without `--mode`, the mode comes from `$BAND_DISPATCH`, then `workspace.defaultVia` in the repo's `.band/config.json`, then `agents.defaultMode`. `--agent` picks an agent by its id from Settings > Coding Agents.

To create a worktree and start the agent in one step, use `--prompt`:

```sh
band worktrees create my-app feat/validation --prompt "Add input validation to all API endpoints"
```

Here the CLI default is a terminal, not a chat. Add `--via chat` for a chat. The precedence is `--via`, then `$BAND_DISPATCH`, then `workspace.defaultVia` in `.band/config.json`, then `cli.defaultVia` in `~/.band/settings.json`, then the terminal.

To send a message to an existing chat, run this in the worktree's folder, or add `--worktree <id>`:

```sh
band chats send --message "Now add tests for the validation"
```

## Watch the status

Every chat and terminal has a status dot in the sidebar and on its tab. A worktree shows the strongest one. The states are:

- working: the agent is running a turn.
- monitoring: a loop or background task is still running after the turn.
- question: the agent waits for your answer or a permission.
- done: the last turn finished.
- failed: the last turn ended in an error.
- idle: nothing is running.

Chats report their status themselves. For Claude Code in a terminal, Band needs its hooks. The dashboard shows a banner offering to install them, and Settings > Agent hooks does the same per worker. See [Agent status](agent-status.md).

From the CLI:

```sh
band chats list                 # the chats of the worktree you are in
band chats watch                # stream the running task as NDJSON lines
band chats stop                 # abort the running task
```

`band chats watch` exits at once when no task is running, so run it right after a send. `band chats list` prints each chat's id and status (`running`, `idle`, `stopped` or `error`). Pass a chat id to target one chat. Terminals have their own commands, under `band terminals`. See the [chats reference](/docs/cli-chats) and the [terminals reference](/docs/cli-terminals).

## Run several tasks at once

Each worktree is isolated, so agents in different worktrees do not conflict:

```sh
band worktrees create my-app feat/auth --prompt "Implement OAuth2 login" --via chat
band worktrees create my-app feat/api --prompt "Add pagination to list endpoints" --via chat
band worktrees create my-app fix/tests --prompt "Fix the failing integration tests" --via chat
```

Check them all with `band worktrees list`, or watch the dots in the sidebar.

## Where next

- [Layout](layout.md) shows the tabs and panels around the chat.
- [Changes](changes.md) shows how to read what the agent changed.
- [Cronjobs](cronjobs.md) run a prompt on a schedule.
