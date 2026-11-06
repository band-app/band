---
paths:
  - "**/activity-reporter.ts"
  - "**/globals.css"
  - "**/host-battery-polling.test.ts"
  - "**/main/index.ts"
  - "**/watch-ignore.test.ts"
  - "**/window-state.test.ts"
  - "apps/desktop/tests/window-power.test.ts"
  - "apps/hub/src/server/services/client-activity-service.ts"
  - "apps/desktop/src/main/services/window-power.ts"
  - "apps/hub/tests/client-activity.test.ts"
  - "apps/web/e2e/power-saver.spec.ts"
  - "apps/web/src/lib/power-state.ts"
  - "apps/web/tests/power-policy.test.ts"
  - "packages/host-local/src/process/power.ts"
  - "packages/host-local/tests/power.test.ts"
---

# Architecture: battery saver

On battery, or with the window blurred or hidden, Band slows its polling and stops continuous repaint work. Plugged in and focused, nothing changes.

- Client power state (`apps/web/src/lib/power-state.ts`): battery comes from Electron's `powerMonitor` (IPC `get_power_state` and the `power-state-changed` event) or, in a plain browser, the Battery Status API. It sets `data-power="saver"` (battery, blurred or hidden) and `data-on-battery` on `<html>`. Under `data-power="saver"`, and under `prefers-reduced-motion`, `globals.css` pauses the infinite animations (`animate-spin`, `animate-pulse`, `animate-status-pulse*`, `tool-shimmer`, the browser loading bar). On battery the desktop window drops its vibrancy (`applyPowerToWindow`, `services/window-power.ts`) and the sidebar paints solid. A focused terminal's cursor stops blinking, a parked terminal drops its output instead of draining it (the snapshot replays on show), and hidden terminals stay warm for 10 s / 1 min instead of 30 s / 5 min. `usePollInterval` pauses the changes, diff and `workers.list` polls while blurred and slows them on battery.
- Activity (`activity-reporter.ts`, `services/client-activity-service.ts`): every UI, in the desktop app or a browser, reports `active | idle | background` with its own client id through `services.setActivity` on change and every minute (`releaseActivity` on page hide). The hub keeps the most active live client, drops one that is silent for 3 minutes (`BAND_ACTIVITY_TTL_MS`), and uses `idle` with no live client (`BAND_ACTIVITY_DEFAULT` overrides that level). The branch-status poller and the terminal title poller follow it. The desktop main process no longer reports; the old `activity-monitor.ts` only worked for a local hub.
- Worker power (`packages/host-local/src/process/power.ts`): `host.info` carries `onBattery` (`pmset -g batt` on macOS, `/sys/class/power_supply` on Linux, unknown elsewhere, cached 60 s, `BAND_POWER_STATE=battery|ac` pins it). The poller reads it once a minute per worker. A worktree on a battery worker is polled every 60 s whatever the clients report, never `git fetch`ed, and queried for CI every 10 minutes.
- `host.fs.watch` takes `ignore` (single path segments); the hub passes its ignore list so `node_modules`, `.git` and build output never cross a worker's link.
- Tests: `apps/hub/tests/client-activity.test.ts`, `host-battery-polling.test.ts` (two real workers), `packages/host-local/tests/power.test.ts` and `watch-ignore.test.ts`, `apps/desktop/tests/window-power.test.ts`, `apps/web/e2e/power-saver.spec.ts`, `apps/web/tests/power-policy.test.ts` (pure functions, no state to fake). `BAND_ACTIVITY_DEFAULT` and `BAND_POWER_STATE` are production settings read on every call; the hub vitest config sets them to `active` and `ac` so servers with no UI keep their 5 s poll and a fixed power state, beyond TEST-1's carve-outs.
- Exceptions: `packages/host-local/tests/power.test.ts` and `watch-ignore.test.ts` call `parsePmset`, `readLinuxPower`, `isOnBattery` and `LocalHost.fs.watch` directly against temp dirs, because a worker's real power source and its link are not reachable from a test (the hub test covers the whole path with `BAND_POWER_STATE`). `apps/desktop/tests/window-power.test.ts` covers only `applyPowerToWindow`; the `on-ac` and `on-battery` forwarding in `main/index.ts` and the `get_power_state` handler need the Electron runtime and stay untested, as with `window-state.test.ts`.
- Not done yet: Windows power detection, event-driven git status.
