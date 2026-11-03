---
paths:
  - "**/cross-host-policy.ts"
  - "**/host-trust-migration.test.ts"
  - "**/relay-scope.ts"
  - "apps/hub/src/server/services/host-trust-service.ts"
  - "apps/hub/tests/host-trust-levels.test.ts"
  - "apps/web/e2e/settings-hosts-trust.spec.ts"
  - "docs/agent-host-access.md"
  - "packages/shared/src/host-trust.ts"
---

# Architecture: worker trust levels

Each worker has a trust level, `restricted`, `standard` or `admin` (`workers.trust`, `packages/shared/src/host-trust.ts`, `services/host-trust-service.ts`). `workers.setTrust` and `workers.audit` are admin-device-token procedures (`band workers trust | audit`, the selector and "Cross-worker activity" in Settings > Workers). The relay reads the level on every call (`ScopeLookups.trustOf`, absent means `standard`), so a lowered level applies at once. Guide: `docs/agent-host-access.md#trust-levels`.

- `relay-scope.ts` keeps the allowlist style: `RESTRICTED_PROCEDURES` is `RELAY_PROCEDURES` without worktree creation and removal, `repos.*` writes, cronjobs and `workers.list`; `standard` is `RELAY_PROCEDURES`; `admin` adds `ADMIN_EXTRA_PROCEDURES` (`settings.get`, `settings.update`, the latter limited to `AGENT_SETTABLE_SETTINGS` and neither over `/mcp`). `NEVER_FOR_AGENTS` (`tokens.*`, `vault.*`, `workers.setTrust`, `workers.audit`) is refused first at every level. `checkNamed` lets an admin worker name worktrees, chats, terminals and browsers on any worker that exists (a `cwd` stays on the caller's worker); the other scope checks are unchanged. A refusal on a restricted worker ends with "(this worker's trust level is restricted)". `checkRelayRequest` returns the level it used and the `audit` entries (`RelayAudit`) of an allowed call, which `WorkerRelayService` records and uses to shape the call (`pinWorktreeHost` keeps an admin's `hostId` on `worktrees.remove` too) and the reply (`repos.list` and `workers.list` stay unredacted for admin, `settings.get` is cut to `AGENT_SETTABLE_SETTINGS`).
- `crossHostRefusal` (`cross-host-policy.ts`) answers for the built-in `band` MCP tool as well: a restricted worker may not create worktrees at all (`restrictedHostRefusal`), an admin worker skips the `agents.crossHostWorktrees` setting, but no level may target `local`, and `checkNamed`, `worktrees.create` and `remove`, cronjob keys, origins and subscriptions refuse the hub's own machine (`HUB_HOST_ID`). Static-worker, online and repo-allowed-worker rules still hold.
- Defaults: the migration `host_trust` makes every existing worker `standard` and leaves the column null for new rows. A null level is `restricted` for a worker whose mode is ephemeral and `standard` otherwise (`defaultHostTrust`), and `RunnerService` stores `restricted` on the workers it starts. `workers.list` returns the effective `trust`. An unknown worker is `restricted`.
- Tests: `apps/hub/tests/host-trust-levels.test.ts` (real hub, two real workers, a shell on A), `host-trust-migration.test.ts`, `apps/web/e2e/settings-hosts-trust.spec.ts`.
