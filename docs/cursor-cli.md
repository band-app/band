---
title: Cursor CLI
description: Set up Cursor CLI in Band, add it to your agent list, and know why it only runs in a chat.
section: agents
order: 60
---

Cursor CLI is Cursor's command line coding agent. It speaks ACP itself, so Band starts it with `cursor-agent acp` and needs no adapter. If there is no `cursor-agent` on the `PATH`, Band tries a command named `agent`. See [coding agents](coding-agents.md) for the shared setup.

## Install and log in

Install Cursor CLI on every machine that runs it, either the hub's machine or a worker:

```sh
curl https://cursor.com/install -fsS | bash
cursor-agent login
```

Band counts Cursor CLI as logged in only when `CURSOR_API_KEY` is set in the worker's environment. It cannot check a sign-in made with `cursor-agent login`. A machine without a key can use an [agent login](agent-logins.md) with a Cursor API key.

## Add it to the agent list

Settings > Coding Agents has no switch for Cursor CLI yet. Add an entry to `codingAgents` in `~/.band/settings.json` on the hub:

```json
{
  "codingAgents": [
    { "id": "cursor-cli", "type": "cursor-cli", "label": "Cursor CLI" }
  ]
}
```

Keep the entries for the other agents in the array. Use `"command": "/path/to/cursor-agent"` in the entry to run another binary.

## Chat only

Cursor CLI has no command line form that opens its interface with a prompt loaded, or that runs one prompt and exits. For that reason it has no terminal mode in Band. A request for a terminal session starts a chat, and `band agents launch` prints a note about the change. A cronjob with the terminal target does the same.

In a chat, Band shows messages, tool calls and plans, like any other agent.

## Hooks and skills

Band installs no hooks for Cursor CLI. A chat reports its status without hooks.

Cursor has no documented skills folder in a user's home directory, so `band skills install` does not link skills for it.

## Limits

- No terminal mode.
- No skills install.
