---
title: Other commands
description: Open files in the editor pane, forward agent hooks, print the CLI schema and install the Band skills.
section: cli
order: 130
commands: [open, notify, schema, skills]
---

Four small commands that do not belong to a larger group.

## band open

`band open <file>` opens a file in a worktree's editor pane. A relative path resolves against the current directory. Add `:line`, `:line:column` or `:line-lineEnd` to the path to jump to a place or select a range.

Band opens the file in the worktree that is active in the dashboard. Use `--worktree <id>` to choose another. The window comes to the front unless you pass `--no-focus`. It prints `Opened <path> in <worktree id>`, with `(external)` after the id for a file outside the worktree.

```sh
band open src/main.rs:42
band open src/main.rs:10-20 --worktree my-app-main --no-focus
```

## band notify

`band notify` is for agent hooks, not for typing. It reads a hook's JSON payload from stdin and forwards it to the hub, which updates the worktree's [agent status](agent-status.md). `--agent claude-code` says which agent sent it. Without `--agent`, the hub works it out from the payload or the worktree.

It never disturbs the agent. It prints nothing, always exits with 0, and returns within one second, even when the hub is down or stdin holds bad JSON. The hook that Band installs runs `band notify --agent claude-code >/dev/null 2>&1 || true`. Install and remove hooks in Settings > Agent hooks.

```text
echo '{"cwd": "/path/to/worktree"}' | band notify --agent claude-code
```

## band schema

`band schema` prints every command, its description and its parameters as JSON. `band schema "<command>"` prints one command, for example `band schema "cronjobs create"`. Scripts and agents use it to discover the CLI. The argument tables on these CLI pages come from the same data.

```sh
band schema
band schema "cronjobs create"
```

## band skills install

`band skills install` writes the Band skills (`band`, `band-chat`, `band-terminal`, `band-browser`, `band-start`, `band-loop` and `band-subscribe`) to `~/.agents/skills/`. It then links that folder into the skills folder of each coding agent it finds on the machine. The supported agents are Claude Code, Codex, Gemini CLI and OpenCode. See [Agent skills](agent-skills.md).

Running it again is safe. Band runs it on every hub start. It leaves correct links alone and reports a conflict when a real folder or another link already sits at a path. `--filter <text>` installs only skills whose name contains the text. `--home <path>` installs under another home folder.

The output lists how many skills were written, updated or unchanged, then which links were created.

```sh
band skills install
band skills install --filter chat
```
