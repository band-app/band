# Repo workers and branch uniqueness

A repo can be limited to some workers, and a branch of a repo has a Band worktree on at most one worker. Both rules hold for every way of creating a worktree: the New Worktree dialog, `band worktrees create`, the `worktrees_create` MCP tool (the `band_worktrees_create` tool of the hub's `/mcp` endpoint and the `worktrees_create` tool every chat gets), an origin child started by an agent, and automatic placement.

## Allowed workers

`repos.allowed_host_ids` lists the workers a repo may run on. `null` means every worker. An empty list is refused.

| How the repo was added | Allowed workers | Primary worker |
| --- | --- | --- |
| From a worker's folder | only that worker | that worker |
| By URL | all workers | the first worker that clones it |
| By path on the hub (`repos.add`) | all workers | chosen by the hub |

The defaults are editable in the Add repo dialog ("Available on: All workers | Only: [workers]" and "Primary worker"), and later in Settings > Repos or with the CLI:

```sh
band repos set epic --workers mac,contabo --primary mac
band repos set epic --workers all --primary auto
```

`--workers` takes worker ids or names from `band workers list`. Changing the allowed workers or the primary worker needs an admin token.

The rule has no override. A worktree, a clone or a folder mapping on a worker that is not allowed fails with `<repo> is only available on <worker names>` and creates nothing on that worker:

- `worktrees.create` with a `hostId` (and `hostRepoPath`) on another worker.
- `worktrees.create` with `placement`. Placement chooses among the allowed workers only, never asks a runner for a new machine, and fails with the same message followed by "and none of them is online and fits the placement" when no allowed worker fits.
- `repos.addFromWorker` for a repo that exists, when the folder is on a worker the repo is not allowed on.

The New Worktree dialog lists the allowed workers only. A worktree that already exists on a worker that is no longer allowed is kept and is never deleted. `repos.list` marks it `hostNotAllowed`, the sidebar card says "Not allowed on this worker", and it opens like any other worktree. Nothing new can be created there.

A repo limited to chosen workers does not get [checkpoints](checkpoints.md) unless you turn them on, and a restore or move to a worker outside the list is refused unless an admin adds the worker in the same call.

## One worker per branch

Creating a worktree for a repo and branch that already has a Band worktree on another worker fails with `<branch> is already on <worker name>`. The tRPC error is `CONFLICT` and carries `data.existingWorktreeId` and `data.existingHostId`. The CLI prints `(worktree <id>)` after the message, the MCP tools return `worktreeId`, and the New Worktree dialog shows an "Open it" button that opens that worktree.

Asking again for the same branch on the worker that already has it is not an error. It returns the existing worktree.

Worktrees that were created before this rule and share a branch across workers keep working. Their ids carry the worker (`<repo>-<branch>@<hostId>`), so they stay two worktrees.

## Default branch and the primary worker

Every worker that holds a clone of the repo has the default branch checked out there. Only the primary worker's default-branch worktree is listed. The checkouts on other workers are hidden caches that new worktrees are created from. They stay resolvable by id and are never deleted.

The primary worker is `repos.primary_host_id`. With none stored, or when the stored worker is no longer allowed, the hub uses the hub's own machine if it holds a default-branch checkout, otherwise the worker with the lowest id. Changing the primary worker changes which checkout is listed. Nothing moves on disk.

All three sidebar groupings (Repo, Origin, Worker) show the same list.

## Tests

`apps/hub/tests/repo-allowed-hosts.test.ts` (a real hub and two real workers), `repo-primary-host.test.ts`, `apps/web/e2e/repo-allowed-hosts.spec.ts`, and `repos_set_hosts_limits_the_repo_and_refuses_other_hosts` in `apps/cli/tests/integration.rs`.
