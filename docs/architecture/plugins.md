# Plugins

Band loads only the plugins that ship with it. A plugin has up to three halves, each listed in one bundled-plugins file:

- Hub half (`apps/hub/src/server/services/bundled-plugins.ts`): `definePlugin` from `@band-app/plugin-api/server`. `PluginHost` activates it on `onStartup` or `onRepoRemote:<host glob>`. It registers review and checks providers and agent tools.
- Worker half (`apps/worker/src/bundled-worker-plugins.ts`): `defineWorkerPlugin` from `@band-app/plugin-api/worker`. It runs inside `band-worker`.
- Client half (`apps/web/src/plugins/bundled-client-plugins.ts`): `defineClientPlugin`, for UI slots.

`band-plugin.json` (schema in `packages/plugin-api/src/manifest.ts`) is validated by every process before it runs plugin code.

## Manifest

- `contributes.slots`: client slots the plugin fills.
- `contributes.workerServices`: ids of worker services the plugin runs.
- `contributes.tools`: names of the agent tools the hub half registers.
- `requires`: an entry with `=` is a worker fact (`os=darwin`, `arch=arm64`). Any other entry is a binary that must be on the worker's `PATH` (`xcrun`, `gh`).

## Worker half

`WorkerPlugins` (`apps/worker/src/plugins.ts`) starts before the worker's hello. A plugin runs when its manifest `requires` hold on this machine and its `unavailable()` returns null. The worker lists each plugin it runs in its hello capabilities and in `host.info`, named by the plugin id, so `workers.list` shows `simulator` for a worker that can run it.

The hub reaches the plugin with the link method `plugin.call { pluginId, method, params, worktreeKey, worktreePath }` (`packages/link/src/plugins.ts`, `HostPlugins` in `packages/host-api`, implemented by `RemoteHost`). Params and result are JSON, and large results use the link's payload channels. The worktree path goes through the worker's path policy, and `LeaseGuard.assertMayRun` refuses the call once the lease ran out.

A plugin keeps state per worktree key. The worker tells it when to let go:

- `worktree.remove` on the worker calls `release(key, "removed")` for every worktree at that path. The plugin deletes its state.
- A lease fence calls `release(key, "fenced")` and a worker shutdown (which an ephemeral worker's sleep ends in) calls `release(key, "shutdown")`, then `stop()`. The plugin stops what runs and keeps its state.

The hub's own machine (`local`) has no `plugins` on its `Host`, so a plugin tool on a worktree there answers an error naming the worker.

## Hub half and agent tools

`BandServerApi.workers.call(hostId, method, params, scope)` calls the worker half. `BandServerApi.tools.register(tool)` adds an agent tool to the built-in `band` MCP server (`/mcp-proxy/band`, `api/mcp-proxy/band-tools.ts`). Tools need no relay procedure, because they travel over the MCP proxy with the chat's session token.

A tool handler gets a `ToolContext` made from the session token's chat: its worktree, that worktree's worker, and `call(method, params)` which reaches the plugin's worker half for exactly that worktree. A tool takes no worktree argument, and an extra argument is dropped by the schema, so an agent cannot act on another worktree. `PluginHost.callWorker` checks the worker's `host.info` capabilities first and answers `Worker <id> cannot run the <plugin> plugin` when it lacks one.

## Tests

`apps/hub/tests/simulator-plugin.test.ts` runs a real hub and real `band-worker` processes with the ACP stub calling the tools.
