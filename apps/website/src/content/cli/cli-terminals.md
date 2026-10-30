---
title: band terminals
description: Create terminals, send input, read or follow output, attach to a session, and restart the terminal daemon.
section: cli
order: 70
commands: [terminals]
---

A terminal is a shell session in a worktree. `band terminals` creates them, types into them and reads what they print. An agent can use it to run a dev server in the background and read its log. See [Terminals](/docs/terminals).

Commands that list or create take a worktree id. Leave it out and the CLI uses the worktree that contains the current directory. Commands that act on one terminal take a terminal id, and without it they use the worktree's first terminal.

## Listing and creating

```sh
band terminals list
band terminals create --command "pnpm dev"
band terminals create --cwd packages/api
```

```text
TERMINAL ID   TITLE   PID    SCROLLBACK
term-5d1e8a   zsh     48213  3120
```

`SCROLLBACK` is the length of the stored scrollback. `create` prints the new terminal's id. `--command` runs a shell command once the shell starts. `--cwd` sets the starting folder, relative to the worktree root. JSON output is `{"terminals": [...]}` for `list`, and the hub's reply with `terminalId` for `create`.

## Sending input

```sh
band terminals send --data "ls -la\n"
band terminals send term-5d1e8a --data "echo done\n"
```

`--data` is the text to type. The CLI turns the two characters `\n` into a newline and `\t` into a tab. End a command with `\n` to run it, because `send` types exactly what you give it. `send` prints `Sent to terminal <id>`.

## Reading output

`output` prints the stored scrollback as plain text. `--lines` keeps the last N lines.

```sh
band terminals output term-5d1e8a --lines 50
band terminals output term-5d1e8a --follow
band terminals output term-5d1e8a --lines 20 --follow
```

`--follow` keeps streaming new output until you press Ctrl+C. Combined with `--lines`, it prints the last N lines first and then streams. With `--output json` the stream is JSON, otherwise it is text.

## Attaching

```sh
band terminals attach term-5d1e8a
```

`attach` streams output and sends each line you type, so you can drive a shell from another terminal. It sends input one line at a time, which suits a shell prompt but not a full-screen program. Press Ctrl+C to detach. The terminal keeps running.

## Killing a terminal

```sh
band terminals kill term-5d1e8a
```

## The terminal daemon

Shells do not run inside the hub. A background process, the terminal daemon, holds them, so they survive a hub restart. If terminals stop responding, restart it:

```sh
band terminals restart-daemon
```

This ends every terminal the daemon holds. Their panes show as exited and you can open new ones. Terminals left by an older version of Band are kept. The command prints how many sessions it ended, or `{"ok":true,"killedCount":N}` in JSON mode.
