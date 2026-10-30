---
title: Claude Code
description: Set up Claude Code in Band, log in, install hooks for terminal sessions, and know what works in a chat or a terminal.
section: agents
order: 20
---

Claude Code is Anthropic's coding agent. Band runs it in a chat through the `claude-agent-acp` adapter, which ships with Band and drives your own `claude` binary. In a terminal tab Band runs `claude` itself. See [coding agents](coding-agents.md) for the shared setup.

## Install and log in

Install Claude Code on every machine that runs it, either the hub's machine or a worker:

```sh
npm install -g @anthropic-ai/claude-code
claude auth login
```

Band finds `claude` on the worker's `PATH`. To use another binary, set the command in Settings > Coding Agents, or per worker in Settings > Workers.

A worker counts Claude Code as logged in when `claude auth status` succeeds, or when `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is set in its environment.

A machine without a Claude login can use an [agent login](agent-logins.md). Two kinds exist: a setup token from `claude setup-token`, and an Anthropic API key. Read the warning in that guide before you store a setup token.

## Models

Settings > Coding Agents > Claude Code lists the models the agent reports. Pick a default model there, or choose one for a chat from the model menu. The "Default" choice hands the decision back to Claude Code, which resolves it from the `--model` flag, `ANTHROPIC_MODEL`, the `model` setting in its own settings files, and then your account's default. Band shows the model that resolved.

## Chat and terminal mode

In a chat, Band shows messages, tool calls, plans and permission questions. When Claude Code asks to run a tool, the chat shows a card with the options the agent offers.

In a terminal tab you get Claude Code's own interface. A prompt passed on the command line, such as `band agents launch --mode tui --prompt "..."`, arrives as the first message. When Band restores a terminal that ran a plain `claude` command after its shell was lost, it resumes the newest Claude Code session in that folder with `--resume`.

## Hooks

Hooks tell Band what a Claude Code session in a terminal is doing, so the sidebar shows working, question, done or failed. A chat needs no hooks, because Band sees the session itself.

Band installs hooks only when you ask:

- Click Install on the banner that says hooks need to be installed. It appears when an online worker has Claude Code and no current hooks, and you can dismiss it. A newer set of hooks shows it once more.
- Open Settings > Agent hooks. Each worker has Install (or Reinstall) and Remove. Remove deletes only Band's entries.

The install adds 11 events to `~/.claude/settings.json` on that worker:

```text
UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure,
PermissionRequest, Stop, StopFailure, SubagentStart, SubagentStop,
PostCompact, SessionEnd
```

Each event runs this command, with the path of the `band` binary on that worker:

```text
"/usr/local/bin/band" notify --agent claude-code >/dev/null 2>&1 || true
```

The entry is marked async with a 5 second timeout. The command discards its output and always succeeds, so a missing `band` or an unreachable hub never reaches Claude Code. Band keeps every other hook in the file and refuses to write if the file is not valid JSON. See [agent status](agent-status.md) for how the events map to states.

## Skills

`band skills install` links the Band skills into `~/.claude/skills` when `~/.claude` exists. See [agent skills](agent-skills.md).

## Limits

- Hooks work for Claude Code only. Codex, OpenCode and Gemini CLI sessions in a terminal show no status from hooks.
- A setup token login cannot use Remote Control or claude.ai connectors.
