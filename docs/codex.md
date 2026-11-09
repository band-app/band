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

Hooks tell Band what a Codex session in a terminal is doing, so the sidebar shows working, question or done. A chat needs no hooks. Band installs them only when you ask, from the banner or Settings > Agent hooks (a Codex row appears under each worker that has the Codex CLI).

The install adds six events (`UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`, `Interrupt`) to `hooks.json` in `CODEX_HOME` (`~/.codex` by default), each running `"<band>" notify --agent codex >/dev/null 2>&1 || true`. Codex runs a hook only after its hash is in `config.toml`, so the install also writes one `[hooks.state."<path>:<event>:<group>:0"]` table per event with `enabled = true` and the `trusted_hash`. Your own hooks and tables stay as they are. Band refuses to write when `hooks.json` is not JSON or `config.toml` is not TOML. Remove deletes Band's hooks and tables only.

A permission prompt shows as a question, `Stop` and `Interrupt` as done. Codex has no failed-turn hook, so Codex never shows failed. Payloads were recorded against codex-cli 0.153.4. Codex keys trust by the hook's position in the event. A hook of yours added after Band's changes nothing; one placed before it moves Band's position, and the row in Settings > Agent hooks reads Outdated until you reinstall.

`band skills install` links the Band skills into `~/.codex/skills` when `~/.codex` exists. `CODEX_HOME` is honored. See [agent skills](agent-skills.md).

## Limits

- Hooks show no failed state.
- A Codex API key login does not override a Codex login or provider already on the machine.
