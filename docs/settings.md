---
title: Settings
description: Every section of the Settings page, what it controls and where to read more.
section: using-band
order: 80
---

Settings holds the options that apply to the whole hub or to this device. Open it with the gear button at the bottom of the sidebar, with Cmd+, in the desktop app, or with "Open Settings" in the command palette.

![The Settings page](/docs/screenshots/settings.png)

A list of sections runs down the left, grouped under five headings. The "Search settings" box above it filters the list. "Back to app" returns to your worktree.

Most sections share one Save button at the bottom, which is active only while you have unsaved changes. The Repos pages have no Save button, because every change there applies at once. Some sections, such as Workers and Agent hooks, act on a button click as well.

Settings are kept in `~/.band/settings.json` on the hub's machine. `band settings` prints them.

## Interface

- **Appearance.** Mode (light, dark or system), a theme preset, colors, fonts and font sizes. See [Appearance](appearance.md).
- **Notifications.** A switch for a sound when an agent asks a question, finishes or fails, and the choice of sound. See [Agent status and notifications](agent-status.md).

## Set up

- **General.** The folder where new worktrees are created (empty means the default), code intelligence for TypeScript and JavaScript (hover types and go-to-definition, at the cost of memory per worktree), and preview tabs that a single click opens and a double click keeps.
- **Hub.** Desktop app only. Chooses the hub the app talks to: Local runs the hub bundled with the app, Remote connects to a hub on another machine and starts nothing here. See [Run the hub on a server](run-the-hub-on-a-server.md).
- **Web Server.** The port the hub listens on for mobile and browser access (default 3456, needs a restart) and whether the server and tunnel start when the app launches. See [Remote access](remote-access.md).
- **Terminal.** GPU-accelerated rendering and the "Restart terminal service" button. See [Terminals](terminals.md).
- **Browser.** Browser profiles (separate cookie jars) and a switch that streams the desktop app's browser tabs to web clients, marked experimental. See [Browser](browser.md).

## AI capabilities

- **Coding Agents.** Enable the agents you have installed, pick the default agent for new worktrees, choose whether new agents open as a chat or in a terminal on this device, set the same choice for agents started by the CLI, cronjobs and MCP, refresh each agent's model list on a worker, and allow agents on a worker to start worktrees on other workers. See [Coding agents](coding-agents.md).
- **MCP.** MCP servers the hub proxies to agents, with their tools, scope and audit log. See [MCP servers](mcp-servers.md).
- **Voice.** Dictation into the chat composer through a speech-to-text endpoint. Admin only. See [Voice dictation](voice-dictation.md).
- **Agent hooks.** Install or remove the Claude Code hooks that report what an agent in a terminal is doing, per worker. See [Agent status and notifications](agent-status.md).
- **Agent logins.** Credentials Band gives an agent when it starts one. See [Agent logins](agent-logins.md).
- **Credentials.** Keys and OAuth connections that the hub stores encrypted. See [Credentials](credentials.md).

## Infrastructure

- **Workers.** The computers that run worktrees and agents, and the tokens they use to connect. Also installs, updates and removes workers. See [Adding workers](adding-workers.md) and [Updates](updates.md).
- **Devices.** Phones, tablets and browsers signed in to the hub. Admin only. See [Devices](devices.md).
- **Runners.** How the hub starts workers on demand. See [Runner hooks](runner-hooks.md).

## Worktree

- **Groups.** Create, rename, color and reorder the groups that sort worktrees in the sidebar. See [Groups](groups.md).
- **Usage report.** Whether Band scans your agents' session files in the background to fill the Usage dialog, and how many days it keeps the history (default 365, at most 3650).
- **Repos.** An overview of every repo on the hub, and one page per repo with its remote, default branch, workers, agent logins, environment, checkpoints, default browser profile and more. Add a repo from the Repos panel in the sidebar. See [Repos](repos.md).

## Who sees what

A section marked admin only is hidden from a device token that is not an admin. Voice and Devices are hidden that way. Other admin-only actions, such as managing hooks or tokens, show a notice when your token lacks the right.
