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

A machine without a provider key can get one from a [worker profile](worker-profiles.md): store the key in the vault and map it to the variable OpenCode reads for that provider, such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` or `GEMINI_API_KEY`.

## Models

OpenCode lists the models of the providers you configured. Settings > Coding Agents > OpenCode shows them. Pick a default model there, or choose one for a chat from the model menu. Use Refresh to read the list again.

## Chat and terminal mode

In a chat, Band shows messages, tool calls and plans. In a terminal tab you get OpenCode's own interface. A prompt arrives through `opencode --prompt`.

## Hooks and skills

OpenCode has no hook configuration, so Band installs a plugin: one file, `band-status.js`, in `$XDG_CONFIG_HOME/opencode/plugins` (`~/.config/opencode/plugins` by default). Install it from the banner or Settings > Agent hooks (an OpenCode row appears under each worker that has the OpenCode CLI). The plugin turns session events into `band notify --agent opencode` calls: busy is working, a permission or question request is a question, idle is done, an error is failed, and a deleted session ends its status. Subagent sessions are ignored. Remove deletes the file only when it is Band's; Band refuses to overwrite a `band-status.js` that is not.

The plugin reports with the environment of the process that runs it. Where OpenCode runs the plugin in a background service instead of the terminal's own process, the status has no terminal to attach to. The event names follow OpenCode's plugin API; they were not recorded from a live run of opencode v2.1.1, because a standalone turn did not finish on the test machine.

`band skills install` links the Band skills into `~/.config/opencode/skills` when `~/.config/opencode` exists. See [agent skills](agent-skills.md).

## Limits

- OpenCode hooks were not recorded from a live run (see Hooks).
- Band does not check the login. If the provider key is missing, the first prompt fails with OpenCode's own error.
