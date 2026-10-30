---
title: band workers
description: List workers, set their trust level, remove them and move worktrees off them.
section: cli
order: 90
commands: [workers]
---

`band workers` shows and manages the machines that run your worktrees. To add a worker, see [Adding workers](adding-workers.md). Most subcommands that change a worker need an admin token.

## Concepts

A worker is a computer connected to the hub. The hub's own machine is the worker `local`. You can name a worker by its id or its name wherever a command takes `<worker>`.

Trust decides how far a worker's agents can reach through the hub:

- `restricted` limits agents to their own worktrees.
- `standard` lets agents act on their own worker, and on other workers when Settings allows it.
- `admin` lets agents reach any worker, settings, repos and cronjobs.

See [Agent access to other workers](agent-host-access.md) for what each level allows.

## Output

`list` prints one row per worker with the columns ID, NAME, STATUS, TRUST, VERSION, LABELS, AGENTS, ROOTS and LAST SEEN. The VERSION column shows the worker's version and flags a worker that needs attention: `(behind)` for an older one, `(update required)` when the hub refuses it, and `unknown (update)` when the worker reports no version. See [Updates](updates.md).

`trust` prints `Worker <id> is now <level>`. `remove` prints `Worker <id> removed`. `remove` works only for a worker that is offline and has no worktrees, and it revokes the worker's tokens.

`audit` prints what admin workers did on other workers, newest first, in the columns WHEN, FROM, CALL, TARGET WORKER and TARGET. `--limit` sets how many rows (default 50).

`set-agent-command` changes the binary an agent runs as on one worker. Pass an agent id from Settings > Coding Agents, such as `claude-code`, and a binary name or absolute path with no arguments. `--clear` goes back to the agent's global command.

`evacuate` moves every worktree off a worker, one after the other, using their [checkpoints](checkpoints.md). It prints one `ok` or `failed` line per worktree and a total, and exits with an error if any move failed. `--add-worker` adds the target to the allowed workers of repos that lack it.

## Examples

```sh
band workers list
band workers trust my-laptop restricted
band workers set-agent-command build-box claude-code /opt/claude/bin/claude
band workers audit --limit 20
band workers evacuate old-box --to new-box --add-worker
band workers remove <id>
```
