---
paths:
  - "**/repo-primary-host.test.ts"
  - "**/worktree-two-hosts.spec.ts"
  - "apps/cli/tests/integration.rs"
  - "apps/hub/src/server/api/trpc.ts"
  - "apps/hub/src/server/services/_utils/repo-host-policy.ts"
  - "apps/hub/tests/repo-allowed-hosts.test.ts"
  - "apps/web/e2e/repo-allowed-hosts.spec.ts"
  - "docs/repo-hosts.md"
  - "packages/shared/src/repo-workers.ts"
---

# Architecture: repo workers

A repo can be limited to workers and a branch lives on one worker (guide: `docs/repo-hosts.md`). `repos.allowed_host_ids` (JSON worker ids, null for all) and `repos.primary_host_id` are written only by `RepoQueries.setHostPolicy` (`saveAll` keeps what the database holds). `repos.update { name, allowedHostIds, primaryHostId }` (admin) and `band repos set --workers --primary` edit them, and `repos.addFromWorker` and `repos.addByUrl` take the same fields. A repo added from a worker starts with `[that worker]` and that primary, one added by URL with all workers, and `checkoutOn` sets the primary to the first worker that clones it.

- Enforcement is hard and central. `assertHostAllowed` (`services/_utils/repo-host-policy.ts`) runs in `WorktreeService.create` and `checkoutOn` and throws `RepoHostNotAllowedError` ("<repo> is only available on <names>", 412). `PlacementService.placeWorktree` places only among allowed workers and never queues a runner request for an allowed-workers repo. The shared helpers are in `packages/shared/src/repo-workers.ts`.
- `WorktreeService.create` refuses a branch that has a listed worktree on another worker with `BranchOnOtherHostError` ("<branch> is already on <worker>", 409). `api/trpc.ts` puts `existingWorktreeId` and `existingHostId` in the error's `data`.
- `repos.list` returns `allowedHostIds`, the effective `primaryHostId`, `hostNotAllowed` on a worktree whose worker is no longer allowed, and leaves out the default-branch worktree of every worker but the primary (`listedWorktrees`). Hidden rows stay in the database and resolve by id.
- Tests: `apps/hub/tests/repo-allowed-hosts.test.ts`, `repo-primary-host.test.ts`, `apps/web/e2e/repo-allowed-hosts.spec.ts`, `repos_set_hosts_*` in `apps/cli/tests/integration.rs`. `seedState` takes `hosts`, `hostId` on a worktree and the repo policy. `worktree-two-hosts.spec.ts` seeds B's copy of the branch with `seedHostWorktree`, because Band no longer creates it.
