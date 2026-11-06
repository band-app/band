---
paths:
  - "**/extension-panels-tools.test.ts"
  - "**/extension-worker-services.test.ts"
  - "**/plugin-host-service.ts"
  - "**/remote-relay.test.ts"
  - "**/tool-call.tsx"
  - "apps/hub/src/server/api/mcp-proxy/extension-tools.ts"
  - "apps/hub/src/server/api/plugins/stream-handler.ts"
  - "apps/hub/tests/fixtures/extensions/echo-service/**"
  - "apps/worker/src/bundled-worker-plugins.ts"
  - "apps/worker/src/plugins.ts"
  - "apps/worker/tests/extensions.test.ts"
  - "docs/architecture/plugins.md"
  - "docs/simulator.md"
  - "packages/link/src/plugins.ts"
  - "packages/plugin-api/src/worker.ts"
---

# Architecture: plugin worker half

A bundled plugin can run code on a worker and give agents tools (guide: `docs/architecture/plugins.md`). No bundled plugin does now: the iOS simulator moved into the official `simulator` extension (`docs/simulator.md`), and the machinery stays for extensions. The manifest has `contributes.workerServices` and `contributes.tools`, and `requires` entries with `=` are worker facts (`os=darwin`).

- Worker: `defineWorkerPlugin` (`packages/plugin-api/src/worker.ts`) plugins are listed in `apps/worker/src/bundled-worker-plugins.ts` and run by `WorkerPlugins` (`apps/worker/src/plugins.ts`). A worker reports each plugin it can run as a capability named by the plugin id. The link method `plugin.call` (`packages/link/src/plugins.ts`, `Host.plugins`, `RemoteHost`) carries JSON. `worktree.remove` releases a worktree's plugin state, a lease fence and worker shutdown stop it.
- Hub: `BandServerApi.workers.call` and `tools.register` (`plugin-host-service.ts`). Registered tools join the built-in `band` MCP server and act on the calling chat's worktree only (`band-tools.ts`). A worker without the capability, and the hub's own machine, answer an error naming the worker.
- Streams and panels: a worker plugin's `stream()` is served by the link method `plugin.stream` and bridged at `GET /api/plugins/<id>/worktrees/<worktreeId>/stream` (`api/plugins/stream-handler.ts`, device token, input reaches the plugin from the start, the old `{"type":"control"}` frame is ignored, no relay route so an agent gets 403). A client half contributes `worktree.panels`; the center "+" menu offers a panel when the worktree's worker reports its `capability`. The tab is kind `plugin`, id `plugin:<plugin id>:<panel id>`, kept mounted while hidden, in `band:center-tabs`. The chat draws image tool results (`ToolImage` in `tool-call.tsx`).
- Tests: the fixture extension `apps/hub/tests/fixtures/extensions/echo-service` stands in for any plugin: `extension-panels-tools.test.ts` (tools, image results, streams on both paths), `extension-worker-services.test.ts`, `apps/worker/tests/extensions.test.ts` (the lease fence), and the probes in `remote-relay.test.ts`. The simulator's own tests live in `band-app/band-extensions`.
- Extension tools may return `{ content: [text | image blocks] }` (`api/mcp-proxy/extension-tools.ts`, images PNG or JPEG up to 5 MB decoded); anything else is JSON text, and an invalid block is a tool error.
- Not done yet: worker plugins on the hub's own machine.
