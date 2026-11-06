# Quick commands

A quick command is text you save once on the hub and run with one tap in the current worktree, from the web or desktop UI or from the iOS app.

There are two kinds.

- **Terminal.** A command line. Running it opens a new terminal tab in the worktree. With Append Enter on, the shell runs the command as the terminal starts. With it off, the text waits at the prompt and does not run.
- **Agent.** A prompt and one of the agents from Settings > Agents. Running it starts that agent in the worktree with the prompt as its first message, in this device's mode: a chat, or a terminal when the browser's agent mode is `tui`. The phone always starts a chat.

## Scope

A command is available in every repo, or only in one repo. A worktree lists the global commands and those of its repo. A new command defaults to the repo of the worktree you add it from. Removing a repo deletes its repo-scoped commands, and the global ones stay.

## Where to find them

- The lightning bolt button beside the new-tab "+" in the tab bar. It lists the commands for the worktree, most recently run first, then by label, with a search box once there are more than five, and has "Add quick command…" and "Manage quick commands…".
- A terminal's right-click menu, under Quick Commands. It types a Terminal command into that terminal, and presses Enter when Append Enter is on. Agent commands are not listed there.
- Settings > Quick commands: every command with its scope and action, search, edit and delete.
- iOS: the worktree's "more" sheet, under Quick commands. Tap a row to run it. The pencil and trash icons edit and delete, and "Add quick command" opens the form.

## Limits

The label is at most 80 characters and the command or prompt at most 4000. The hub refuses an empty label or body, an unknown repo and an unknown agent id with a 400 and a message.

## Access

Any device token can list, create, update, delete and run commands. An agent cannot: `quickCommands.*` is left out of the MCP endpoint and the worker relay, because a saved command is text a person later runs in a shell.

## Not built

Default or imported commands (Orca's settings file), scope per worker or per worktree, variables in the text, running a command from an agent or a cronjob, and a `band quick-commands` CLI command.
