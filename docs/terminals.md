---
title: Terminals
description: Terminal tabs, split panes, how shells survive a restart of Band, and how to restart the terminal service.
section: using-band
order: 60
---

A terminal is a shell in a worktree's folder. It opens as a tab in the center area, next to chats, files and diffs. The shell runs on the worktree's worker. For a worktree on a remote worker, the shell runs on that machine.

## Open and arrange terminals

| Action | Shortcut on macOS |
| --- | --- |
| New terminal | Cmd+T |
| Show the terminal tab | Ctrl+` |
| Split right | Cmd+D |
| Split down | Cmd+Shift+D |
| Cycle panes | Cmd+[ and Cmd+] |

In a browser on Linux, split right is Ctrl+Shift+D and split down is Alt+Shift+D, because Ctrl+D ends a shell.

Each pane of a split is its own shell. A pane has Split right and Split down buttons in its corner. Each button splits that pane, not the active one. The panes' layout is saved per worktree.

Terminals are also available from the command palette ("New Terminal") and from the CLI. See [Terminal commands](/docs/cli-terminals).

A terminal tab shows the agent state of the agent that runs in it, such as Claude Code. See [Agent status and notifications](agent-status.md).

## Shells survive restarts

Shells do not run inside the hub process. A separate background process, the terminal daemon, holds them. The hub starts it on the first terminal and keeps it for as long as shells exist. When the desktop app relaunches, updates, or the hub restarts or crashes, your shells keep running. The restarted hub reattaches to them, and the browser shows each screen again.

A shell ends when you close its tab, delete its worktree, or exit it. The daemon exits by itself when it holds no shells and no hub is connected.

The daemon runs on each machine that runs terminals. Terminals on a remote worker follow the same rule. The worker runs its own daemon in its state directory, so shells there survive a restart or update of `band-worker`. For a service-managed worker, see [Updates](updates.md).

With `BAND_TERMINAL_DAEMON=0` set, terminals run inside the hub process and end when it stops. The same fallback applies if the daemon cannot start.

## Cold restore

A shell cannot outlive a reboot or a crash of the daemon. Band saves each terminal's screen content (scrollback) and working folder on the machine while the shell runs. When a terminal ends in any way other than closing its tab or deleting its worktree, the next open of that terminal starts a fresh shell in the saved folder and shows the saved screen above it.

If the terminal was running a plain `claude` command, Band looks for the newest Claude Code session in that folder and starts `claude --resume <session id>` so the conversation continues. Other commands are not started again.

## Restart the terminal service

If a terminal freezes or misbehaves, restart the service. Every terminal ends, and the panes show that the process exited. You can reopen them. Saved screens and folders stay, so cold restore applies.

- In the app: Settings > Terminal > "Restart terminal service", then confirm "Restart the terminal service?".
- From the CLI:

```sh
band terminals restart-daemon
```

The restart ends the terminals of the hub's own machine. It does not touch a terminal service that belongs to an older build of Band, which keeps its shells until they end.

## Other settings

Settings > Terminal has one more option, "GPU-accelerated rendering". It renders the terminal with WebGL for continuous box-drawing and powerline glyphs, and falls back to the DOM renderer when WebGL is unavailable. Reopen a terminal after you change it.

## Terminals a repo opens for you

A repo's `.band/environment.json` can list `terminals`. Band opens one terminal per entry after the worktree's setup succeeds. See [Agent environments](agent-environments.md).

## Control a terminal from the CLI

An agent or a script can create a terminal, send it input and read its output:

```sh
band terminals create --command "pnpm dev"
band terminals list
band terminals send --data "q\n"
band terminals output --lines 50
band terminals output --follow
band terminals attach
band terminals kill
```

Each command finds the worktree from the folder you run it in. Pass a worktree id or a terminal id to name one yourself.
