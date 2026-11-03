---
paths:
  - "**/hub-choice.ts"
  - "**/relay-scope.ts"
  - "apps/desktop/src/main/services/secret-store.ts"
  - "apps/desktop/tests/hub-choice.test.ts"
  - "apps/hub/src/server/api/mcp-proxy/band-tools.ts"
  - "apps/hub/src/server/services/cross-host-policy.ts"
  - "apps/hub/tests/cross-host-worktrees.test.ts"
  - "apps/web/e2e-desktop/desktop-hub-picker.spec.ts"
  - "apps/web/e2e/settings-page.spec.ts"
  - "docs/agent-host-access.md"
---

# Architecture: agents across workers

An agent on a worker may name another worker in `worktrees.create` (guide: `docs/agent-host-access.md`). `crossHostRefusal` (`services/cross-host-policy.ts`) is the one check, used by the relay (`relay-scope.ts`, `ScopeLookups.crossHostRefusal`, which also stops `pinWorktreeHost` from overwriting an approved `hostId`) and by the built-in `band` MCP server (`api/mcp-proxy/band-tools.ts`). It refuses unless `agents.crossHostWorktrees` is not false, the target is an online worker that is not ephemeral, not started by a runner (`runner_machines`) and not `local`, and the repo allows it (`isHostAllowed`). `WorktreeService.create` still enforces the allowed-worker rule. `workers.list` is in `RELAY_PROCEDURES` and the relay replaces its reply with `redactHostsReply` (`agentHostView` lists the kept fields, so a field added later stays hidden), `workers.forAgents` is the same view for MCP, and the rest of `hosts.*` stays out of agent reach. The desktop app keeps the remote hub's token in `desktop-hub.enc` through `safeStorage` (`apps/desktop/src/main/services/secret-store.ts`, `hub-choice.ts`) and deletes an older `desktop-hub.json`; `BAND_DESKTOP_SECRET_STORE=test` swaps in a fixed-key store for e2e. Tests: `apps/hub/tests/cross-host-worktrees.test.ts` (two real workers), `apps/desktop/tests/hub-choice.test.ts`, `apps/web/e2e-desktop/desktop-hub-picker.spec.ts` (migration and a scan for the token), `apps/web/e2e/settings-page.spec.ts` (the toggle).
