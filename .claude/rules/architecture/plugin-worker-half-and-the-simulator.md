---
paths:
  - "**/build-desktop.mjs"
  - "**/plugin-host-service.ts"
  - "**/remote-relay.test.ts"
  - "**/tool-call.tsx"
  - "**/worker/servesim.ts"
  - "apps/hub/src/server/api/plugins/stream-handler.ts"
  - "apps/hub/tests/simulator-plugin.test.ts"
  - "apps/web/e2e/simulator-panel.spec.ts"
  - "apps/web/src/components/remote-screen/**"
  - "apps/worker/src/bundled-worker-plugins.ts"
  - "apps/worker/src/plugins.ts"
  - "apps/worker/tests/plugin-fencing.test.ts"
  - "docs/architecture/plugins.md"
  - "docs/simulator.md"
  - "packages/link/src/plugins.ts"
  - "packages/plugin-api/src/worker.ts"
  - "plugins/simulator/**"
---

# Architecture: plugin worker half and the simulator

A bundled plugin can run code on a worker and give agents tools (guide: `docs/architecture/plugins.md`, `docs/simulator.md`). The manifest has `contributes.workerServices` and `contributes.tools`, and `requires` entries with `=` are worker facts (`os=darwin`).

- Worker: `defineWorkerPlugin` (`packages/plugin-api/src/worker.ts`) plugins are listed in `apps/worker/src/bundled-worker-plugins.ts` and run by `WorkerPlugins` (`apps/worker/src/plugins.ts`). A worker reports each plugin it can run as a capability named by the plugin id. The link method `plugin.call` (`packages/link/src/plugins.ts`, `Host.plugins`, `RemoteHost`) carries JSON. `worktree.remove` releases a worktree's plugin state, a lease fence and worker shutdown stop it.
- Hub: `BandServerApi.workers.call` and `tools.register` (`plugin-host-service.ts`). Registered tools join the built-in `band` MCP server and act on the calling chat's worktree only (`band-tools.ts`). A worker without the capability, and the hub's own machine, answer an error naming the worker.
- Simulator (`plugins/simulator`): one iOS simulator per worktree, a device named `Band – <worktree id>` in the machine's default device set (serve-sim sees only that set; the probe is in `docs/simulator.md`), cloned from a `Band – base` device. Band touches only devices with that name prefix (`BAND_SIMULATOR_NAME_PREFIX`, which tests set to their own). `BAND_SIMULATOR_MAX_BOOTED` (default 2, read on every call) caps booted devices and shuts down the least recently used. Capture and input go through serve-sim 0.1.47 (`worker/servesim.ts`, one detached helper per device; a dependency of `@band-app/worker`, copied into the desktop worker by `build-desktop.mjs`). Tools: `simulator_status | screenshot | describe | tap | type | button | open_url | install | launch`.
- Streams and panels: a worker plugin's `stream()` is served by the link method `plugin.stream` and bridged at `GET /api/plugins/<id>/worktrees/<worktreeId>/stream` (`api/plugins/stream-handler.ts`, device token, view-only until `{"type":"control","enabled":true}`, no relay route so an agent gets 403). A client half contributes `worktree.panels`; the center "+" menu offers a panel when the worktree's worker reports its `capability`. The tab is kind `plugin`, id `plugin:<plugin id>:<panel id>`, kept mounted while hidden, in `band:center-tabs`. `RemoteScreen` (`apps/web/src/components/remote-screen`) draws the frames and sends pointer and key messages. `simulators.status | open` (tRPC, left out of the MCP endpoint and the relay) back `band simulators open` and the tab. The desktop IPC `reveal_simulator` shows a device in Simulator.app. The chat draws image tool results (`ToolImage` in `tool-call.tsx`) and a simulator tool call has an "Open simulator" button.
- Tests: `apps/hub/tests/simulator-plugin.test.ts` (real hub, real workers, real simulators under the run's own name prefix, skipped without Xcode and on CI unless `BAND_TEST_SIMULATOR=1`, which the macOS web job sets for the stream case and the tab e2e), `apps/web/e2e/simulator-panel.spec.ts` (the same gate; the chat image and the missing menu item run everywhere), the probes in `remote-relay.test.ts`. `apps/worker/tests/plugin-fencing.test.ts` (real worker, stand-in hub that stops renewing) checks that a lease fence shuts a booted device down and refuses calls until the hub renews. Ephemeral sleep is not tested on its own: the worker exits after the hand-off and the same `stop()` path shuts devices down, which the hub test covers by stopping the worker.
- Not done yet: Android, the mobile app showing the tab, moving the VNC viewer onto `RemoteScreen`, recording video, worker plugins on the hub's own machine.
