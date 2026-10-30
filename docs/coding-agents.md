---
title: Coding agents
description: How Band runs Claude Code, Codex, OpenCode, Gemini CLI and Cursor CLI, in a chat or a terminal, and how to configure them.
section: agents
order: 10
---

Band runs five coding agents: [Claude Code](claude-code.md), [Codex](codex.md), [OpenCode](opencode.md), [Gemini CLI](gemini-cli.md) and [Cursor CLI](cursor-cli.md). The agents run on a worker, in the worktree's folder. The worker can be your hub's own machine or any other [worker](adding-workers.md).

## How agents run

Every chat talks to its agent over the Agent Client Protocol (ACP). The worker starts the agent as a subprocess and the hub exchanges messages with it. Band does not parse any agent's own session files to build a chat.

| Agent | How Band starts it |
| --- | --- |
| Claude Code | The `claude-agent-acp` adapter, which drives your `claude` binary. |
| Codex | The `codex-acp` adapter, which drives your `codex` binary. |
| OpenCode | `opencode acp` |
| Gemini CLI | `gemini --acp` |
| Cursor CLI | `cursor-agent acp`, or `agent acp` if there is no `cursor-agent` |

The adapters for Claude Code and Codex ship with Band. The other three agents, and the `claude` and `codex` binaries, must be installed on the worker. Band looks for them on the worker's `PATH` and in the folders agent installers use under the home directory, such as `~/.local/bin` and `~/.opencode/bin`.

## Chat and terminal mode

An agent session has one of two modes, and it keeps its mode for its whole life.

- Chat (`gui`) is a chat tab. Band talks to the agent over ACP and draws messages, tool calls, plans and questions. When the agent asks for permission to run a tool, the chat shows a card with the agent's own options as buttons.
- Terminal (`tui`) runs the agent's command line program in a terminal tab. You get the agent's own interface. Band cannot read the conversation, so it learns what the agent is doing from [hooks](claude-code.md#hooks) where the agent supports them.

Cursor CLI has no terminal mode in Band. A request for a terminal session starts a chat instead, and the CLI prints a note.

Two settings choose the mode for new sessions, both in Settings > Coding Agents:

- "Open agents on this device as" applies to agents you start from this browser or app. It is saved on this device only.
- "Open programmatically created agents in" is `agents.defaultMode` in `~/.band/settings.json`. The CLI, cronjobs and MCP use it, and so does a device with no mode set. The default is Chat.

`band agents launch --mode tui` and `band worktrees create --via terminal` override both for one command. See [agents in the CLI](/docs/cli-agents).

A chat has a "Continue in terminal" action that reopens its session in a terminal, for the agents that can resume a session by id.

## Configure agents

Open Settings > Coding Agents.

- Default agent. The agent that new worktrees use. You can switch a worktree's agent from its chat.
- Switch. One row per agent, with a switch. Turning it on adds the agent to the list the chat menus offer. The list is saved as `codingAgents` in `~/.band/settings.json`.
- Command. Open a row to set the command Band runs, as a path or a name on `PATH`. Leave it empty for the default (`claude`, `codex`, `opencode`). A command that resolves to nothing counts as not installed.
- Models. Open a row to see the models Band last read from the agent, pick a default model, and refresh the list.

On first start Band enables every agent whose command it finds on `PATH`. A hub on a server has no agents of its own. It enables the agents that its first worker reports. This applies to Claude Code, Codex and OpenCode.

Settings > Coding Agents has no switch for Gemini CLI or Cursor CLI yet. Add them to `codingAgents` in `~/.band/settings.json` by hand. The agent pages show the entry.

### Models

Band reads each agent's model list from the agent itself and keeps it, so the pickers fill before a chat starts. Refresh re-reads it. With more than one worker online, a menu next to Refresh chooses which worker to ask. The chat's model menu lists the same models. A model set in a chat applies to that chat. The default model in Settings applies to new chats.

### Workers

An agent can be installed on some workers and not others. With two or more workers, the open row of an agent in Settings > Coding Agents lists each worker as available or not available, with the reason.

To run an agent from a different command on one worker, open that worker in Settings > Workers and set the agent's command there. Band checks that the command exists on the worker. A per-worker command wins over the command in Settings > Coding Agents.

A worker that reports an agent as not logged in still counts as able to run it if you have an [agent login](agent-logins.md) for that agent.

## Logging in

An agent uses the login on the machine it runs on, such as the result of `claude auth login` or `codex login`. A worker with no login can use an [agent login](agent-logins.md) instead, which the hub stores in its vault and hands to the agent when it starts.

## Updates do not stop chat agents

A chat agent on a remote worker runs under a small background process, the agent daemon. When the worker restarts, for example during an [update](updates.md), the agent keeps running and the hub reattaches to it. A turn in progress finishes. The update dialog lists only the agents that a restart would end.

Some agents still stop:

- Agents on the hub's own machine (the worker `local`).
- Chats that a worker owns (a worker started with `--own-chats`, which includes the desktop app's bundled worker).
- Every agent, when the hub stops. Only the hub holds the conversation state.

After a restart that was not clean, the next prompt starts a new agent process and loads the chat's session.

## Skills

`band skills install` links the seven Band skills into each agent whose config folder exists on the machine. See [agent skills](agent-skills.md).
