---
title: band agents
description: Start a coding agent in a worktree as a chat or a terminal, and list its sessions.
section: cli
order: 40
commands: [agents]
---

An agent session is one run of a coding agent in a worktree. It has a mode. A `gui` session runs in a chat. A `tui` session runs the agent's own CLI in a terminal. A session keeps its mode for its whole life. See [Coding agents](/docs/coding-agents).

Both commands take an optional worktree id. Leave it out and the CLI uses the worktree that contains the current directory.

## Launching an agent

```sh
band agents launch
band agents launch --agent codex --mode tui
band agents launch my-app-feat-login --prompt "Fix the failing tests" --mode gui
```

- `--agent` is the id of an agent from Settings > Coding Agents. Without it the hub uses the default agent.
- `--prompt` is the first message. Without it the agent starts and waits.
- `--mode` is `gui` or `tui`. `chat` and `terminal` also work.

Without `--mode`, the CLI uses the first of these that is set:

1. the `BAND_DISPATCH` environment variable
2. `workspace.defaultVia` in the repo's `.band/config.json`
3. the hub's `agents.defaultMode` setting

The command prints the mode it started and the id of the chat or terminal, separated by a tab.

```text
gui	chat-7f3a91c2
```

When an agent cannot run as a terminal, the hub starts it as a chat and the output adds a line starting with `note:` with the reason. With `--output json` the output is the hub's reply, with `mode`, `chatId` or `terminalId`, and `notice` when there is one.

Use the id with the [chats](/docs/cli-chats) or [terminals](/docs/cli-terminals) commands, for example `band chats watch chat-7f3a91c2`.

## Listing sessions

```sh
band agents list
```

```text
SESSION ID  AGENT        MODE  STATE    PANE           PROVIDER SESSION
as-91c0d2   claude-code  gui   running  chat-7f3a91c2  5b2e0c8e-3a1f-4d0b-9c55-0e1c7f6a2b10
```

| Column | Meaning |
| --- | --- |
| `SESSION ID` | Band's id for the session. |
| `AGENT` | The agent's id. |
| `MODE` | `gui` or `tui`. |
| `STATE` | `starting`, `running` or `ended`. |
| `PANE` | The chat id for `gui`, the terminal id for `tui`. |
| `PROVIDER SESSION` | The agent's own session id, empty until it is known. |

JSON output is `{"agentSessions": [...]}`.
