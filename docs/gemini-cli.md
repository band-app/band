---
title: Gemini CLI
description: Set up Gemini CLI in Band, add it to your agent list, and know what works in a chat or a terminal.
section: agents
order: 50
---

Gemini CLI is Google's coding agent. It speaks ACP itself, so Band starts it with `gemini --acp` and needs no adapter. See [coding agents](coding-agents.md) for the shared setup.

## Install and log in

Install Gemini CLI on every machine that runs it, either the hub's machine or a worker:

```sh
npm install -g @google/gemini-cli
gemini
```

Run `gemini` once to sign in. Band finds `gemini` on the worker's `PATH`. To use another binary, set `command` on the agent's entry, or per worker in Settings > Workers.

Band counts Gemini CLI as logged in only when `GEMINI_API_KEY` is set in the worker's environment. It cannot check a sign-in made with `gemini`. A machine without a key can use an [agent login](agent-logins.md) with a Gemini API key.

## Add it to the agent list

Settings > Coding Agents has no switch for Gemini CLI yet. Add an entry to `codingAgents` in `~/.band/settings.json` on the hub:

```json
{
  "codingAgents": [
    { "id": "gemini-cli", "type": "gemini-cli", "label": "Gemini CLI" }
  ]
}
```

Keep the entries for the other agents in the array. Use `"command": "/path/to/gemini"` in the entry to run another binary.

## Chat and terminal mode

In a chat, Band shows messages, tool calls and plans. In a terminal tab you get Gemini CLI's own interface, and a prompt arrives after `--`. Gemini CLI has no way to resume a session by id, so "Continue in terminal" is not available for a Gemini chat.

## Hooks and skills

Band installs no hooks for Gemini CLI, so a terminal session reports no status to the sidebar. A chat reports its status without hooks.

`band skills install` links the Band skills into `~/.gemini/skills` when `~/.gemini` exists. See [agent skills](agent-skills.md).

## Limits

- No hooks for terminal sessions.
- No session resume in a terminal.
