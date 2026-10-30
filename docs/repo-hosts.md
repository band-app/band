---
title: Repo workers
description: Limit a repo to some workers, choose its primary worker, and learn why a branch lives on one worker at a time.
section: workers
order: 40
---

A repo can be limited to some workers, and a branch of a repo has a Band worktree on at most one worker. Both rules hold for every way of creating a worktree: the New worktree dialog, `band worktrees create`, an agent in a chat, and automatic placement.

## Allowed workers

A repo runs on all workers by default, or only on the workers you list. An empty list is refused.

| How the repo was added | Allowed workers | Primary worker |
| --- | --- | --- |
| From a worker's folder | only that worker | that worker |
| By URL | all workers | the first worker that clones it |
| By path on the hub | all workers | chosen by the hub |

You can change the defaults in the Add repo dialog ("Available on" and "Primary worker"), and later on the repo's page in Settings > Repos or with the CLI:

```sh
band repos set atlas --workers mac,contabo --primary mac
band repos set atlas --workers all --primary auto
```

`--workers` takes worker ids or names from `band workers list`. Changing the allowed workers or the primary worker needs an admin token.

The rule has no override. A worktree, a clone or a folder on a worker that is not allowed fails with `<repo> is only available on <worker names>` and creates nothing on that worker. This covers:

- Creating a worktree on a named worker.
- Creating a worktree with labels or requirements (`--labels`, `--requires`). Placement chooses among the allowed workers only and never asks a runner for a new machine. When no allowed worker fits, the error adds "and none of them is online and fits the placement".
- Adding a folder from a worker the repo is not allowed on, for a repo that already exists.

The New worktree dialog lists the allowed workers only. A worktree that already exists on a worker that is no longer allowed is kept and never deleted. The sidebar card says "Not allowed on this worker", and the worktree opens like any other. Nothing new can be created there.

A repo limited to chosen workers does not get [checkpoints](checkpoints.md) unless you turn them on, and a restore or move to a worker outside the list is refused unless an admin adds the worker in the same call.

## One worker per branch

Creating a worktree for a repo and branch that already has a Band worktree on another worker fails with `<branch> is already on <worker name>`. The CLI prints `(worktree <id>)` after the message, an agent's tool call returns the worktree id, and the New worktree dialog shows an "Open it" button that opens that worktree.

Asking again for the same branch on the worker that already has it is not an error. It returns the existing worktree.

Worktrees that were created before this rule and share a branch across workers keep working. Their ids carry the worker (`<repo>-<branch>@<worker-id>`), so they stay two worktrees.

## Default branch and the primary worker

Every worker that holds a clone of the repo has the default branch checked out there. Only the primary worker's default-branch worktree is listed. The checkouts on other workers are hidden caches that new worktrees are created from. They stay resolvable by id and are never deleted.

With no primary worker set, or when the set worker is no longer allowed, the hub uses its own machine if it holds a default-branch checkout, and otherwise the worker with the lowest id. Changing the primary worker changes which checkout is listed. Nothing moves on disk.

On a repo's page in Settings > Repos, the Workers section chooses "All workers" or "Only these". Each change saves at once. To connect more workers, see [Add a worker](adding-workers.md).
