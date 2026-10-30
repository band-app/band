---
title: Architecture
description: How the hub, workers, agents and terminals fit together, and where Band keeps its state.
section: more
order: 10
---

Band has one hub and any number of workers. The hub holds your data and serves the UI. Workers are the machines that run your git commands, agents and terminals. On a single computer, the hub and the one worker run in the same app, and you never notice the split.

```text
  Desktop app / browser / iOS app / band CLI
              |  HTTPS + WebSocket
              v
  +---------------------------------------+
  |  Hub                                  |
  |  UI, API, chats, schedules, vault,    |
  |  SQLite database in ~/.band           |
  |  built-in worker "local"              |
  +---------------------------------------+
        ^                ^
        | one outbound WebSocket per worker
        |                |
  +-----------+    +-----------+
  | Worker A  |    | Worker B  |    (laptop, server, VM, container)
  | git, files|    | git, files|
  | agents    |    | agents    |
  | terminals |    | terminals |
  +-----------+    +-----------+
```

## The hub

The hub is the one place that stays on. It keeps repos, worktrees, chats and their history, settings, credentials, schedules and device tokens. It serves the UI and the API that the desktop app, the browser, the iOS app and the `band` CLI use. It also receives webhooks and runs timers for [subscriptions](subscriptions.md) and [cronjobs](cronjobs.md).

The hub keeps its state in `~/.band` (or the folder in `BAND_HOME`). The main file is a SQLite database. Credentials in it are encrypted with a key kept beside it. See [Credentials](credentials.md).

You can run the hub in three ways:

- Inside the desktop app. The app starts a hub on your Mac and shows its UI. This is the default.
- On a server, from the npm package or a Docker image. See [Run the hub on a server](run-the-hub-on-a-server.md).
- As a hub the desktop app connects to, instead of its own. Choose it in Settings > Hub.

## Workers

A worker is a computer connected to the hub. It runs the work for the worktrees placed on it: git, file access, search, language servers, coding agents and terminals. The hub never reads a worker's disk directly. It asks the worker.

The hub's own machine is a built-in worker named `local`. On a one-computer setup, it is the only worker.

You can add more workers: a laptop, a home server, a cloud VM, or a container that a [runner](runner-hooks.md) starts on demand. See [Adding workers](adding-workers.md) and [Provisioning](provisioning.md). Each worktree lives on one worker, and its id names that worker when it is not `local`.

## The link

A worker dials the hub. It opens one outbound WebSocket and keeps it open. So a worker needs no inbound port, and it works behind a NAT or a firewall without a VPN. The hub sends commands down that connection and the worker sends results and events back.

A worker first proves itself with a one-time bootstrap token, and then with a session token that the hub can revoke. A device token (for a browser, phone or the CLI) cannot connect as a worker. See [Devices](devices.md).

The hub and the worker must run compatible versions. See [Updates](updates.md#version-rule).

## Agents

Band runs coding agents over the Agent Client Protocol (ACP). Claude Code, Codex, OpenCode, Gemini CLI and Cursor CLI each run as a process that speaks ACP. A chat is a conversation with one of them.

The agent runs on the worktree's worker, next to the code. The hub keeps the conversation: the ACP connection, the event log and the message queue. So a chat can be replayed, queued and watched from any device no matter where the agent runs. A separate background process on the worker holds each agent, so a worker update does not stop a running turn. See [Updates](updates.md#what-a-worker-update-interrupts).

A worker can also run the chats of its own worktrees and copy them to the hub, when it is started with `--own-chats`. The desktop app's bundled worker does this.

## Terminals

A terminal pane is a real shell on the worker. A background process on the worker, the terminal daemon, owns the shells. So shells survive a restart of the hub, the worker or the desktop app. When you reconnect, Band replays the screen. Closing the terminal tab ends the shell. A reboot ends every shell.

An agent can also run in a terminal instead of a chat. A chat is a GUI session and a terminal is a TUI session. A session keeps its mode for its whole life.

## The direct path

When the desktop app uses a remote hub, a worktree on your own Mac would otherwise travel Mac to hub to Mac and back. If this Mac runs a worker for that hub, the app talks to the worker on `127.0.0.1` for terminals, the file tree, file reads and saves, diffs and searches. The hub still decides who may do what. It hands the app a short-lived token for one worktree, and the worker checks that token on every call. If the direct path fails, the app falls back to the hub and shows nothing. A browser tab never uses the direct path. See [Local direct path](local-direct-path.md).

## When things go offline

- If the hub is down, the UI stops. Shells keep running on their workers, and workers reconnect on their own.
- If a worker goes offline, its worktrees stay readable from the hub's [checkpoints](checkpoints.md), and you can [continue them on another worker](follow-the-work.md).
- A worker on a machine that a runner starts and stops puts its worktrees to sleep when idle. See [Ephemeral workers](ephemeral-workers.md).

## Where state lives

| What | Where |
| --- | --- |
| Repos, worktrees, chats, tasks, settings, tokens, credentials | The hub, in `~/.band` (`BAND_HOME`). |
| Worktree files, git history, agent processes, shells | The worker that holds the worktree. |
| Worker identity and repo folders | The worker's own state directory. |
| Open tabs, drafts, panel layout | The hub, so your phone and your desktop show the same thing. |
| The window's size and position | The desktop app, on your Mac. |

## Terms

The glossary in the repo has the exact definitions of [repo, worker, worktree and the old names](glossary.md). In code, a worker is still called a `Host` in many places, and a few CLI flags keep the old `host` spelling as hidden aliases.
