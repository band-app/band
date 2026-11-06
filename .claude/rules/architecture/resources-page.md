---
paths:
  - "**/ResourcesPage.tsx"
  - "**/remote-relay.test.ts"
  - "**/resources-model.ts"
  - "**/resources.spec.ts"
  - "apps/desktop/tests/app-metrics.test.ts"
  - "apps/hub/src/server/api/resources/router.ts"
  - "apps/hub/src/server/services/resources-service.ts"
  - "apps/hub/tests/resources-machines.test.ts"
  - "apps/web/e2e/resources.spec.ts"
  - "packages/host-api/src/resources.ts"
  - "packages/host-local/src/resources/**"
---

# Architecture: resources page

The Resources dialog (`ResourcesPage.tsx`, `resources-model.ts`) has a Memory / CPU / Storage switch, one card and one section per machine (the hub's machine, each online worker, and the desktop app's Electron processes), and the Band processes on each machine grouped as worker, agents, terminals, language servers and browsers/simulators/MCP.

- Worker side: `Host.resources` (`packages/host-api/src/resources.ts`, `LocalResources` in `packages/host-local/src/resources/`, link methods `resources.snapshot | storage`, both passive for the idle clock). `snapshot` reads the process table twice about 0.5 s apart (`/proc` on Linux, `ps` elsewhere, no native dependency), sums each shell, agent, language server and browser with its children, and caches 3 s. The terminal and agent daemons are found by their `--run-dir` argument, so only this worker's own daemons count. The worker, hub and daemon rows count the process itself; an unclassified child of the process shows as `other`. A stdio MCP server or simulator that does not match a known command line also shows as `other`. `storage` runs `du` on the worktree folders the hub names (the worker's path policy checks them) and on each child of the state folder, three at a time, and reads the disk with `df`.
- Hub side: `resources.snapshot` and `resources.storage { hostId }` (`api/resources/router.ts`, `services/resources-service.ts`). A worker that is offline or does not answer in 8 s becomes `status: "unavailable"`. A process maps to a worktree by its `BAND_WORKTREE_ID` (read from `/proc/<pid>/environ`; macOS hides the environment, so there it falls back to the process's folder), and an agent maps to its chat by pid (`agentSessionService.agentPids`). The procedures are left out of the MCP endpoint and are not in `RELAY_PROCEDURES`, so a worker's agent gets 403.
- The old `services.resourcesServer | resourcesRepos | resourcesRepoSize` procedures remain but the page no longer calls them. The Worktrees card read 0 B on a hub without checkouts because it ran `du` on the hub. The Storage view measures on the machine that holds the files.
- Tests: `apps/hub/tests/resources-machines.test.ts` (real hub and worker, terminal, ACP stub agent, a stopped worker), the `resources-snapshot` probe in `remote-relay.test.ts`, `apps/web/e2e/resources.spec.ts` (including the phone width). `resources.spec.ts` cannot cover the Electron machine: it renders only when `window.__BAND_DESKTOP__` exists and reads `get_app_metrics` over the Electron IPC, and the web harness never boots Electron. `apps/desktop/tests/app-metrics.test.ts` covers the data mapping only; the IPC channel, the preload entry and the Electron rows stay untested.
- Not done yet: actions on rows (stopping an agent), history charts, the mobile app, and finding stdio MCP servers and simulators by the worker's own registries.
