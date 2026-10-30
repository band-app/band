---
title: Codex
description: Set up Codex in Band, log in or use an API key, and know what works in a chat or a terminal.
section: agents
order: 30
---

Codex is OpenAI's coding agent. Band runs it in a chat through the `codex-acp` adapter, which ships with Band and drives your own `codex` binary. In a terminal tab Band runs `codex` itself. See [coding agents](coding-agents.md) for the shared setup.

## Install and log in

Install Codex on every machine that runs it, either the hub's machine or a worker:

```sh
npm install -g @openai/codex
codex login
```

Band finds `codex` on the worker's `PATH`. To use another binary, set the command in Settings > Coding Agents, or per worker in Settings > Workers.

A worker counts Codex as logged in when `codex login status` succeeds, or when `OPENAI_API_KEY` is set in its environment.

A machine without a Codex login can use an [agent login](agent-logins.md) with an OpenAI API key. A login or model provider already configured for Codex on the machine takes priority over that key, so the key helps mainly on a fresh worker.

## Models

Settings > Coding Agents > Codex lists the models the agent reports. Pick a default model there, or choose one for a chat from the model menu. Use Refresh to read the list again.

## Chat and terminal mode

In a chat, Band shows messages, tool calls and plans. When Codex asks to run a tool, the chat shows a card with the options the agent offers, and you answer there. In a terminal tab you get Codex's own interface, and a prompt passed on the command line arrives as the first message.

## Hooks and skills

Band installs no hooks for Codex, so a Codex session in a terminal reports no status to the sidebar. A chat reports its status without hooks.

`band skills install` links the Band skills into `~/.codex/skills` when `~/.codex` exists. `CODEX_HOME` is honored. See [agent skills](agent-skills.md).

## Limits

- No hooks for terminal sessions.
- A Codex API key login does not override a Codex login or provider already on the machine.
