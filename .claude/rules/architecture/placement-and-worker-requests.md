---
paths:
  - "**/placement-timeout.test.ts"
  - "apps/hub/src/server/services/placement-service.ts"
  - "apps/hub/tests/placement.test.ts"
  - "apps/web/e2e/provisioning-worktree.spec.ts"
---

# Architecture: placement and worker requests

`worktrees.create` takes `placement: { labels?, requires?, environment? }` instead of `hostId` (passing both is an error). `PlacementService` (`services/placement-service.ts`) picks the least loaded online worker (fewest worktrees) whose `k=v` labels include every requested label and whose facts (`versions`, `os`, `arch` from `host.info`) satisfy `requires` (`>=24`, `>`, `<=`, `<`, `=`, or a plain `24` prefix). The local worker is a candidate when it is enabled. Version constraints use the environment package's range matcher (`>=24`, `^3.12`, `24.x`, `>=20 <23`), and a non-version value such as `os=linux` must match exactly. Facts include the worker's `tools`.

- With no match, the hub inserts a `host_requests` row (`pending`, with the create call in `input`) and `worktrees.create` answers `{ path: "", provisioning: { requestId } }`. Asking again for the same worktree returns the open request. No worktree exists yet; the UI lists `hostRequests.list` as provisioning cards under the repo (`ProvisioningWorktreeCard`).
- Runner side, admin token only: `hostRequests.lease { runnerId, filter: { labels }, ttlMs }` takes the oldest leasable request whose labels are all in the filter (a request without a filter is taken whatever its labels). A guarded SQL `UPDATE` makes the lease atomic, and a lease past `lease_expires_at` is leasable again (the 1 s sweep also returns it to `pending`). `renew` and `fulfil` need the holder's `runnerId`, else 409. `fulfil { requestId, runnerId, hostId, hostRepoPath? }` records the worker; once that worker is online (the worker's hello, or the sweep) the hub replays the stored create call on it and sets `completed_at`. A failed replay fails the request with the error.
- `BAND_PLACEMENT_TIMEOUT_MS` (default 10 minutes, read on every sweep) fails a request that is not completed in time: "No worker matched the placement within Ns", or "Worker X did not connect within Ns" after a fulfil. `hostRequests.cancel` cancels a waiting request or dismisses a failed one; a worktree created while the cancel raced is removed again. `hostRequests.*` is left out of the MCP endpoint and the worker relay.
- CLI: `band worktrees create ... --labels k=v,k=v --requires node=>=24 --any-worker --worker-repo-path <path>`; a provisioning result prints the request id. Tests: `apps/hub/tests/placement.test.ts`, `placement-timeout.test.ts`, `apps/web/e2e/provisioning-worktree.spec.ts`.
- Not done yet: a placement picker in the New Worktree dialog. The runner service (3.4) is below.
