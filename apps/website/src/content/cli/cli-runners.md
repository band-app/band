---
title: band runners
description: List the runners that start workers on demand and read what their hooks printed.
section: cli
order: 95
commands: [runners]
---

`band runners` is read-only. It shows the runners that start workers when a worktree waits for one. You configure runners in `~/.band/settings.json`; see [Runner hooks](runner-hooks.md).

## Concepts

When `band worktrees create` finds no worker that matches the placement, Band records a worker request and prints its id. A runner with a free slot and matching labels picks the request up and runs its hooks to start a worker. The log of those hooks is saved per request.

## Output

`list` prints one row per runner with the columns ID, SPAWN, LABELS, RUNNING and TIMEOUT. `RUNNING` is the number of workers running now out of the runner's concurrency limit, for example `1/2`. Settings that Band could not use print below the table as `Invalid runner: <reason>`.

`log <request-id>` prints what the runner's hooks printed for that request, with tokens replaced by `[redacted]`. It fails with `No runner log for request <id>` when none exists.

## Examples

```sh
band runners list
band runners log <request-id>
```
