---
title: Introduction
description: What Band is, the terms the docs use, and the three ways to run it.
section: get-started
order: 10
---

Band runs coding agents in parallel, each in its own git worktree, and shows them all in one window. You start an agent on a branch, watch its chat or terminal, review its changes, and move on to the next one. It works with Claude Code, Codex, OpenCode, Gemini CLI and Cursor CLI. Band does not install these agents or log in for you. Install the ones you want on the machine that runs them.

![The Band dashboard: a sidebar of repos, groups and worktrees, and an open chat](/docs/screenshots/dashboard.png)

A normal session looks like this:

1. Add a repo.
2. Create a worktree on a new branch. Your main checkout stays untouched.
3. Start an agent in the worktree, as a chat or as the agent's own CLI in a terminal.
4. Watch the status dot in the sidebar, read the changes, and merge or remove the worktree.

Worktrees are isolated, so several agents can work on one repo at once without touching each other's files.

## Concepts

- A **hub** is the server that keeps Band's data: repos, worktrees, chats, settings and tokens. The desktop app starts its own hub. You can also run one on a server.
- A **worker** is a computer that runs worktrees and agents. The hub's own machine is the built-in worker `local`. Other machines connect to the hub as workers.
- A **repo** is a repository Band knows about. The hub stores its remote URL and default branch. Each worker keeps its own clone.
- A **worktree** is one working copy of a repo on its own branch, where an agent and you work. Its id is `<repo>-<branch>`, for example `my-app-feat-login`.
- A **chat** is an agent session shown in a chat pane. Band talks to the agent over the Agent Client Protocol.
- A **terminal** is a shell in a worktree. An agent can also run in a terminal as its own CLI. Terminals keep running when you restart Band.
- A **device** is a browser, the desktop app, the iOS app or the CLI that signs in to the hub with its own token.

[Architecture](architecture.md) shows how the parts connect.

## Three ways to run Band

**Desktop app on one Mac.** The app bundles a hub and uses your Mac as the worker. This is the shortest path. It needs macOS on Apple Silicon. See [Install](install.md#1-desktop-app-only).

**A hub on a server.** Run the hub from a Docker image on a home server or a VPS. You reach it from a browser, the desktop app, the iOS app or the CLI. Worktrees run on workers you connect to it. See [Install](install.md#2-a-server-hub) and [Run the hub on a server](run-the-hub-on-a-server.md).

**Add a worker.** A worker is a Mac or Linux machine, a container or a VM that dials the hub and runs worktrees and agents there. It needs no inbound port. See [Install](install.md#3-workers-and-runners) and [Adding workers](adding-workers.md).

The desktop app, the hub and the workers can be mixed. The desktop app can connect to a remote hub (Settings > Hub), and then offer to use your Mac as a worker for it.

## Next steps

1. [Install Band](install.md).
2. [Add your first repo](first-repo.md).
3. [Create your first worktree](first-worktree.md).
4. [Run your first task](first-task.md).
