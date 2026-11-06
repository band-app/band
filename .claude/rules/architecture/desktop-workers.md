---
paths:
  - "**/DesktopHeaderButton.tsx"
  - "**/DesktopViewer.tsx"
  - "**/DesktopViewerDialog.tsx"
  - "**/desktop-docker.test.ts"
  - "**/desktop-host.test.ts"
  - "**/fixtures/rfb-stub.ts"
  - "**/fixtures/x11-desktop.ts"
  - "**/methods-streams.ts"
  - "**/remote-relay.test.ts"
  - "**/rfb-client-filter.ts"
  - "**/start-server.ts"
  - "apps/hub/src/server/infra/host/desktop-proxy.ts"
  - "apps/hub/tests/desktop-docker.test.ts"
  - "apps/hub/tests/desktop-host.test.ts"
  - "apps/web/e2e/desktop-viewer-x11vnc.spec.ts"
  - "apps/web/e2e/desktop-viewer.spec.ts"
  - "apps/worker/tests/desktop.test.ts"
  - "docker/desktop-entrypoint.sh"
  - "docker/worker-desktop.Dockerfile"
  - "packages/host-local/src/desktop/desktop.ts"
---

# Architecture: desktop workers

A worker can offer a virtual desktop (plan step 7.1). The `band-worker-desktop` image (`docker/worker-desktop.Dockerfile`, entrypoint `docker/desktop-entrypoint.sh`) is the worker image plus Xvfb on `:99` (`BAND_DESKTOP_RESOLUTION`, default 1280x800x24), fluxbox, x11vnc, Chromium and common GUI libraries. The entrypoint exports `DISPLAY` before it execs `band-worker`, so agents, terminals and headed Playwright runs draw on that display. x11vnc runs with `-localhost -nopw`: it listens on loopback only and has no password, because the worker's link is the auth boundary. Never drop `-localhost`.

- A worker reports `desktop` in its capabilities when `DISPLAY` is set and `x11vnc` is on its PATH (`desktopUnavailableReason`, `packages/host-local/src/desktop/desktop.ts`, read on every `host.info`). `Host.desktop.open()` connects to `127.0.0.1:$BAND_DESKTOP_VNC_PORT` (default 5900) and rejects with `This worker has no desktop: <reason>` naming the missing display, the missing x11vnc or the failed connect. The worker method `desktop.open` (`methods-streams.ts`) opens a `desktop` link channel carrying the RFB bytes, and `RemoteHost` wraps it as a `Duplex`.
- The hub bridges it at `GET /api/hosts/<id>/desktop` (`infra/host/desktop-proxy.ts`, wired in `start-server.ts`). It takes any device token like the other WebSocket routes. Binary frames go both ways unchanged, and the `binary` subprotocol noVNC offers is accepted. A worker with no desktop, an offline worker and an unknown worker close with code 4001 and the reason. A second viewer on one worker closes with 4409. Every session starts view-only (step 7.2, `rfb-client-filter.ts`): the bridge splits the viewer's bytes into RFB messages and drops KeyEvent, PointerEvent and ClientCutText, so only SetPixelFormat, SetEncodings and FramebufferUpdateRequest reach x11vnc. It follows RFB 3.7 and 3.8 with security type None (x11vnc `-nopw`) and closes with code 1008 on anything else, including a message type it cannot size. The pane switches mode with a text frame `{"type":"control","enabled":true}`. A binary frame never changes the mode, and the hub sends no text frames because noVNC cannot read them. A new connection is view-only again. The route is for a person's device token only: the worker relay lists no desktop route, so an agent on a worker gets 403 (`remote-relay.test.ts`).
- A runner with `desktop: true` gets `BAND_DESKTOP=1` in its hook environment. The `docker` hook then runs `BAND_DOCKER_DESKTOP_IMAGE` (default `band-worker-desktop`), with `--shm-size 1g`, instead of the repo or worker image.
- Tests: `apps/worker/tests/desktop.test.ts`, `apps/hub/tests/desktop-host.test.ts` (real hub and workers, a stand-in RFB server on the loopback port) and `apps/hub/tests/desktop-docker.test.ts` (the real image, run by the CI `docker` job, skipped without `BAND_DOCKER_TEST_DESKTOP_IMAGE`). The viewer is a dialog (`DesktopViewerDialog.tsx`, `DesktopViewer.tsx`, noVNC loaded with a dynamic import because it reads `window` at load) opened from Settings > Workers ("Open desktop") and from the center group header (`DesktopHeaderButton.tsx`) when the worktree's worker is online with the `desktop` capability. The dialog is a large overlay (96vw by 94vh, no padding), not a center tab, because Settings > Workers opens it too and a worker's desktop belongs to no worktree. Its header shows worker, resolution and mode, with Fit / 1:1, Take control / Release, Fullscreen and Close. Fit scales a desktop larger than the area down at its aspect ratio and draws a smaller one 1:1, never scaled up. 1:1 draws it at its own size and the area scrolls. noVNC measures the area with `getBoundingClientRect`, so the viewer applies the scale again when the dialog's open animation ends. Fullscreen puts the viewer itself in fullscreen. Escape leaves fullscreen first, and in control mode it goes to the remote desktop instead of closing the dialog. The canvas takes keyboard focus only in control mode. It reconnects up to three times after a drop. Take control sends the mode request first, then enables noVNC input, and paste goes to the remote only in control mode. There is no "match my window" resize: the filter does not follow SetDesktopSize (type 251) and would close the session. The filter reads a ClientCutText length as signed, because noVNC answers x11vnc's ExtendedClipboard offer with a negative-length one; read as unsigned it held every later message, so no key or click reached a real x11vnc. Tests: `apps/web/e2e/desktop-viewer.spec.ts` (a stand-in RFB server in `fixtures/rfb-stub.ts` that records keys, its size set per test, with layout, fit, 1:1 and fullscreen cases), `apps/web/e2e/desktop-viewer-x11vnc.spec.ts` (a real Xvfb and x11vnc from `fixtures/x11-desktop.ts`, natively when they are on PATH, which the CI e2e job installs, or in the image named by `BAND_E2E_DESKTOP_IMAGE`; an `xev` window logs the clicks and keys that reach the display), the view-only cases in `desktop-host.test.ts`, and the real framebuffer through the bridge in `desktop-docker.test.ts`. Not done yet: snapshot and restore of a desktop container's display state, and the VM and k8s hooks.
