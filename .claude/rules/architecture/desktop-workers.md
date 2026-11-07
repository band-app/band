---
paths:
  - "**/methods-streams.ts"
  - "**/remote-relay.test.ts"
  - "apps/worker/src/agent-env.ts"
  - "apps/worker/src/extensions.ts"
  - "docker/desktop-entrypoint.sh"
  - "docker/worker-desktop.Dockerfile"
  - "packages/worktree-ops/src/plugin-stream-socket.ts"
---

# Architecture: desktop workers

A worker can offer a virtual desktop per worktree, through the official `desktop` extension (`band-app/band-extensions`, `extensions/desktop`). Band bundles no viewer, no RFB code and no noVNC. The `band-worker-desktop` image (`docker/worker-desktop.Dockerfile`, entrypoint `docker/desktop-entrypoint.sh`) is the worker image plus Xvfb, fluxbox, x11vnc, Chromium and common GUI libraries. The entrypoint exports `DISPLAY` and starts a display on `:99` with x11vnc on loopback; the extension starts its own displays and does not use that one. The docker runner hook with `desktop: true` (`BAND_DESKTOP=1`) runs `BAND_DOCKER_DESKTOP_IMAGE`. x11vnc always runs with `-localhost -nopw`: the worker's link is the auth boundary, so never drop `-localhost`.

- Extension. A worker service (`requires` os=linux, Xvfb and x11vnc; capability `desktop`) starts, per worktree and on first need, an Xvfb on a free display number, a window manager and x11vnc on a free loopback port. Its panel "Desktop" streams RFB bytes with `binaryInput: true`, and panel input is always on, so the person is in control at once. Its tools (`desktop_screenshot`, `desktop_click`, `desktop_type`, `desktop_key`, `desktop_open_url`) act on the calling chat's worktree display. Users who had the bundled viewer install the extension from Settings > Extensions.
- Band side, generic and used by any extension: `panels[].binaryInput` (binary frames from the page reach the service, up to 1 MiB each, a `bridgePluginStream` option; the direct listener takes it as `?binaryInput=1`), `workerServices[].worktreeEnv` (an allowlist of variable names the service may set) with the `worktree.env` service method, which the worker calls before `acp.spawn`, `pty.spawn` and an owned chat's agent start (`ExtensionHost.worktreeEnv`, `agent-env.ts`). Names under `BAND_*`, `GIT_*`, `PATH` and credential-looking names are refused by the manifest schema (`isAllowedServiceEnvName`). Any number of viewers may open one panel's stream.
- Removed: the hub's `/api/hosts/<id>/desktop` bridge and RFB message filter, `Host.desktop` and the `desktop.open` link method, the `desktop` host capability (an extension service now reports the capability name `desktop`), the viewer dialog and header button, Settings > Workers "Open desktop", noVNC, and their tests and fixtures.
- Tests: `apps/hub/tests/extension-panels-tools.test.ts` (binary input, worktree env, second viewer) with the fixture extension `echo-service`; the extension's own runner in `band-app/band-extensions` runs against a real Xvfb and x11vnc. CI still builds the desktop image and checks its binaries.
