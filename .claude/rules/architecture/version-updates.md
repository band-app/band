---
paths:
  - "**/HubUpdateControls.tsx"
  - "**/UpdateAllWorkers.tsx"
  - "**/UpdateAvailableBadge.tsx"
  - "**/UpdatePanelDialog.tsx"
  - "**/WorkerUpdateButton.tsx"
  - "**/biome.json"
  - "**/fixtures/github-releases-stub.ts"
  - "**/hub/tests/helpers/stand-in-worker.ts"
  - "**/remote-relay.test.ts"
  - "**/settings/HostVersionLine.tsx"
  - "**/update.sh"
  - "**/worker-versions-dev-hub.test.ts"
  - "**/worker-versions.test.ts"
  - "apps/hub/package.json"
  - "apps/hub/src/server/services/_utils/host-version.ts"
  - "apps/hub/src/server/services/_utils/hub-version.ts"
  - "apps/hub/src/server/services/hub-update-service.ts"
  - "apps/hub/src/server/services/release-check-service.ts"
  - "apps/hub/src/server/services/worker-update-service.ts"
  - "apps/hub/tests/hub-update.test.ts"
  - "apps/hub/tests/release-check.test.ts"
  - "apps/web/e2e/update-available.spec.ts"
  - "apps/web/e2e/update-hub-interruptions.spec.ts"
  - "apps/web/e2e/update-hub.spec.ts"
  - "apps/worker/src/update.ts"
  - "apps/worker/tests/update.test.ts"
  - "deploy/compose/compose.yml"
  - "deploy/k8s/hub.yaml"
  - "docker/Dockerfile/**"
  - "docs/install.md"
  - "packages/shared/src/versions.ts"
  - "packages/shared/tests/versions.test.ts"
---

# Architecture: version updates

Workers show their Band version, the hub tells when a newer release exists, and an admin can update a worker with one click (guide: `docs/install.md#updating`).

- Versions (`packages/shared/src/versions.ts`, pure and tested in `packages/shared/tests/versions.test.ts`): `compatibilityProblem` is the link rule (same major, middle number within 1; version 0.x), `updateTargetFor`/`describeHostVersion` (`services/_utils/host-version.ts`) work out what `workers.list` returns per worker (`workerVersion`, `versionState` current|behind|ahead|unknown|refused, `updateRequired`, `serviceManager`, `updateTarget`, `canUpdate`, `manualCommand`, `update`), and `isStrictSemver` is the only thing allowed to reach npm. The hub's own version is `apps/hub/package.json`, imported into the bundle (`services/_utils/hub-version.ts`), so the Docker build sets it from the `BAND_VERSION` build arg before `pnpm build:web`. A hub that still reports the unreleased default `0.1.0` (run from source) skips the compatibility check, logs that it did, and accepts every worker. `BAND_HUB_VERSION` (plain MAJOR.MINOR.PATCH) replaces the bundled version; `worker-versions.test.ts` uses it to test refusal at a released version, `worker-versions-dev-hub.test.ts` covers the default.
- Link: `Hello.version` and `Hello.serviceManager` (`launchd` | `systemd`) are optional, `Rejected.code` is optional, so old and new peers still talk (no `PROTOCOL_VERSION` bump). A worker without `version` is read from `buildId` (`band-worker@<v>`), else its version is unknown and it is accepted. `WorkerLinkService.authenticate` checks the credential first, then the version; a refusal carries `code: "version-incompatible"` and is stored in `workers.info.updateRequired` (only for a worker that holds a valid credential). `LinkClient.connect` rejects with `LinkRejectedError`, and the worker waits `BAND_WORKER_VERSION_RETRY_MS` (5 min) before it exits, so a service manager does not make it redial every few seconds.
- Release check (`services/release-check-service.ts`): `GET <BAND_GITHUB_API_URL>/repos/band-app/band/releases/latest` at startup and every 24 h (`BAND_UPDATE_CHECK_INTERVAL_MS`), `BAND_UPDATE_CHECK=off` disables it. The answer stays in memory, a failure is logged once and costs nothing in the UI. `workers.checkForUpdates` (admin, in `NEVER_FOR_AGENTS`, left out of the MCP endpoint; `band workers check-updates`; the Check for updates button in Settings > Workers) runs `releaseCheckService.checkNow()` at once and returns the status plus `error`; admin calls within 30 s of each other reuse the last answer, so GitHub's 60 requests an hour are safe. `workers.updateStatus` (any device token) returns the hub version, `latest`, `updateAvailable`, `installMethod` and `hubCommand` (`hubUpdateCommand`, from `BAND_INSTALL_METHOD`: `compose`, `helm`, `k8s`, `docker`; set in `deploy/compose/compose.yml`, `deploy/k8s/hub.yaml` and `docker/Dockerfile`).
- Update (`services/worker-update-service.ts`): `workers.update { hostId }` (admin) computes the target itself and answers at once (a proxy in front of the hub would time out on a request held open for an npm install); in the background it sends `worker.update` over the link, and the worker (`apps/worker/src/update.ts`) validates the version, runs the npm beside its own node (`BAND_NPM_BIN` overrides; node's directory goes first on the child's PATH) as `npm i -g --prefix <prefix> @band-app/worker@<v>` with the prefix taken from where the worker runs (`installPrefix`; a worker outside an npm global layout sends `updateBlocked` in its hello, so `workers.list` has `canUpdate: false` and `updateBlockedReason`), fixes node-pty's `spawn-helper` mode, answers, and 500 ms later restarts through `launchctl kickstart -k gui/$UID/app.band.worker` or `systemctl --user restart band-worker` (`BAND_LAUNCHCTL_BIN`, `BAND_SYSTEMCTL_BIN`). The service manager comes from the environment (`XPC_SERVICE_NAME=app.band.worker`, `INVOCATION_ID`). The worker row's `update` (`installing`, `restarting`, `failed` with the error) is the progress, pushed as `host-status-changed`. A failed install is an RPC error kept there, an update that does not reconnect on the target within 3 minutes (`BAND_WORKER_UPDATE_RESTART_TIMEOUT_MS`) fails too; state is in memory. `workers.interruptions` (admin) lists the agents the restart ends, for the confirm dialog. `hosts.*` is left out of the MCP endpoint and the worker relay.
- UI: `UpdateAvailableBadge.tsx` in the sidebar footer, `UpdatePanelDialog.tsx`, `WorkerUpdateButton.tsx` (confirm dialog) and `settings/HostVersionLine.tsx` on Settings > Workers. CLI: `band workers list` has a VERSION column.
- Tests: `apps/hub/tests/release-check.test.ts`, `worker-versions.test.ts` (real hub, real worker and `LinkClient` stand-ins), `apps/worker/tests/update.test.ts` (fake npm, launchctl and systemctl), `apps/web/e2e/update-available.spec.ts` (`hub/tests/helpers/stand-in-worker.ts`, `fixtures/github-releases-stub.ts`). The real update of a live worker restarts it, so it is checked by hand.
- Hub update (`services/hub-update-service.ts`, `settings.hubUpdate.command`, admin only to read or write): `workers.updateHub` (admin) runs the command with `sh -c`, detached (`detached`, `unref`), with a minimal env plus `BAND_HUB_TARGET_VERSION` and the user-session bus variables, output in `<BAND_HOME>/hub-update.log`. The run lives in `<BAND_HOME>/hub-update.json` because the restart ends the process. `workers.updateStatus` returns `hubUpdate { configured, state idle|updating|failed, target, error }` (the log tail only for an admin): the target version reached means done, a non-zero exit, a restart on another version or `BAND_HUB_UPDATE_TIMEOUT_MS` (10 minutes, read on every call) means failed. `workers.dismissHubUpdate` clears a failure. `workers.hubInterruptions` (admin) lists every live agent on the hub (held ones included, because only the hub has their ACP state) with a `busy` flag, and `workers.updateHub { confirmInterruptions }` answers 409 naming the busy worktrees unless it is true. `HubUpdateControls.tsx` checks first, starts at once with no busy turn, and otherwise opens a confirm dialog. The documented `update.sh` (`docs/install.md`) defers while `tasks.list` shows turns younger than `BAND_HUB_UPDATE_MAX_TASK_AGE_MIN` (180), up to `BAND_HUB_UPDATE_MAX_DEFER_H` (6) hours. `workers.updateAll { confirmInterruptions }` (admin) updates every online worker that is behind one after the other (`WorkerUpdateService.updateAll`), skips one with running agents unless confirmed, and `updateStatus.updateAll` lists the result per worker. `updateHub`, `hubInterruptions`, `dismissHubUpdate` and `updateAll` are in `NEVER_FOR_AGENTS`, and the service is on the machine-access exempt list in `biome.json`. `BAND_INSTALL_METHOD=npm` gives `npm i -g @band-app/server@<v> && systemctl --user restart band-hub`. UI: `HubUpdateControls.tsx` and `UpdateAllWorkers.tsx` in the update panel. Tests: `apps/hub/tests/hub-update.test.ts`, the probes in `remote-relay.test.ts`, `apps/web/e2e/update-hub.spec.ts`, `apps/web/e2e/update-hub-interruptions.spec.ts`.
- Not done yet: updating a Docker, compose, Helm or k8s hub from the button, a CLI command to update a worker, a pre-release channel.
