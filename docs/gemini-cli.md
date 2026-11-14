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

Band counts Gemini CLI as logged in only when `GEMINI_API_KEY` is set in the worker's environment. It cannot check a sign-in made with `gemini`. A machine without a key can get one from a [worker profile](worker-profiles.md): store it in the vault and map it to `GEMINI_API_KEY`.

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

Install hooks from the banner or Settings > Agent hooks (a Gemini CLI row appears under each worker that has the CLI). The install adds six events (`BeforeAgent`, `AfterAgent`, `BeforeTool`, `AfterTool`, `Notification`, `SessionEnd`) to `~/.gemini/settings.json`, each running `"<band>" notify --agent gemini-cli >/dev/null 2>&1 || true` with a 5000 ms timeout. Gemini CLI has no async flag, so the command runs before Gemini continues; `band notify` returns within about a second. A tool permission notification is a question, `AfterAgent` is done, and `SessionEnd` ends the status. Gemini reports no failed turn, so it never shows failed. Your own hooks stay, and Band refuses to write a settings file that is not JSON.

`SessionStart` and `SessionEnd` payloads were recorded against Gemini CLI 0.61.0. The others follow the CLI's hook reference, because the Google account used for testing is not eligible for the CLI any more, so no model turn ran.

`band skills install` links the Band skills into `~/.gemini/skills` when `~/.gemini` exists. See [agent skills](agent-skills.md).

## Limits

- Hooks show no failed state.
- No session resume in a terminal.
