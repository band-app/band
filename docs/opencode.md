---
title: OpenCode
description: Set up OpenCode in Band, choose a provider key, and know what works in a chat or a terminal.
section: agents
order: 40
---

OpenCode is an open source coding agent that works with many model providers. It speaks ACP itself, so Band starts it with `opencode acp` and needs no adapter. See [coding agents](coding-agents.md) for the shared setup.

## Install and log in

Install OpenCode on every machine that runs it, either the hub's machine or a worker:

```sh
npm install -g opencode-ai
opencode auth login
```

Band finds `opencode` on the worker's `PATH` and in `~/.opencode/bin`. To use another binary, set the command in Settings > Coding Agents, or per worker in Settings > Workers.

Band cannot check whether OpenCode is logged in, so it reports the agent as installed when the binary exists.

A machine without a provider key can use an [agent login](agent-logins.md). The kinds are an Anthropic, OpenAI, OpenRouter or Gemini API key. Band puts the key in the environment variable OpenCode reads for that provider.

## Models

OpenCode lists the models of the providers you configured. Settings > Coding Agents > OpenCode shows them. Pick a default model there, or choose one for a chat from the model menu. Use Refresh to read the list again.

## Chat and terminal mode

In a chat, Band shows messages, tool calls and plans. In a terminal tab you get OpenCode's own interface. A prompt arrives through `opencode --prompt`.

## Hooks and skills

Band installs no hooks for OpenCode, so an OpenCode session in a terminal reports no status to the sidebar. A chat reports its status without hooks.

`band skills install` links the Band skills into `~/.config/opencode/skills` when `~/.config/opencode` exists. See [agent skills](agent-skills.md).

## Limits

- No hooks for terminal sessions.
- Band does not check the login. If the provider key is missing, the first prompt fails with OpenCode's own error.
