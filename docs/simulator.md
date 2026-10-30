# iOS simulator

A worktree on a Mac worker can have its own iOS simulator. An agent drives it with tools, and a person opens it as a Simulator tab in the worktree's center dock. This is the bundled `simulator` plugin (`plugins/simulator`). Capture and input come from [serve-sim](https://www.npmjs.com/package/serve-sim), pinned to 0.1.47.

## Requirements

The worker must be a Mac with Xcode (`xcrun simctl`). A worker reports the `simulator` capability when it is. serve-sim needs nothing else on the worker: it is a dependency of `@band-app/worker` and ships in the desktop app's bundled worker (`apps/worker/scripts/build-desktop.mjs` copies it and `ws`). It runs only on Apple Silicon. `BAND_SERVE_SIM_ENTRY` points at another `serve-sim.js`.

The hub's own machine runs no worker plugins. Use a worktree on a connected worker, such as the desktop app's "This Mac" worker.

## Devices and the device set

Each worktree has one device named `Band – <worktree id>` in the machine's default device set, so it also shows in Simulator.app. The first use creates a base device `Band – base` (the newest iOS runtime and the newest iPhone Pro it supports) and each worktree's device is a clone of it. `BAND_SIMULATOR_DEVICE_TYPE` and `BAND_SIMULATOR_RUNTIME` pick another base before the first use.

Band touches only devices whose name starts with `Band – `. `BAND_SIMULATOR_NAME_PREFIX` replaces `Band`; the tests set one of their own, so they never match a person's devices, and they delete every device with it.

A booted device uses about 5.7 GB of memory and a device about 5 GB of disk. `BAND_SIMULATOR_MAX_BOOTED` (default 2, read on every call) caps booted devices. Booting one over the cap shuts down the least recently used, which is only shut down, not deleted. Removing the worktree deletes its device. Stopping the worker, or a lease fence, shuts devices down and keeps them.

### Probe: Band's own device set does not work with serve-sim

The first version kept devices in a private device set (`xcrun simctl --set <state dir>/simulator/devices`) and used idb. The probe for serve-sim 0.1.47 on Xcode 26.6 (iOS 26.5), 2026-10-30:

- `Sources/SimNative/FrameCapture.swift` finds a device with `SimServiceContext.defaultDeviceSetWithError:`, so it sees only the default set.
- A device created and booted with `--set <dir>`: `serve-sim --detach <udid>` never answered (it hung until killed).
- The same device type created in the default set: `--detach` answered at once with its endpoints; `/stream.mjpeg` sent JPEG frames, `/ax` returned the accessibility tree, and `tap`, `button` and `type` ran without error.

So the devices moved into the default set under the `Band – ` prefix. The cap, per-worktree clone and cleanup rules stayed. Devices the first version created in the private set are deleted on first use (the set directory is removed), and the next use clones a new one. `apps/hub/tests/simulator-plugin.test.ts` runs on the default set (devices under the run's own prefix) and checks stream, input and the accessibility tree through the hub.

## Tests

The tests that boot devices (`apps/hub/tests/simulator-plugin.test.ts`, `apps/worker/tests/plugin-fencing.test.ts`, the live part of `apps/web/e2e/simulator-panel.spec.ts`) skip without Xcode, and on CI unless `BAND_TEST_SIMULATOR=1`, because a cold boot takes minutes there. Keep 15 GB of disk free: the base device and each clone take about 5 GB.

## Agent tools

`simulator_status`, `simulator_screenshot` (a PNG, from `simctl io`), `simulator_describe`, `simulator_tap`, `simulator_type`, `simulator_button` (`HOME`, `LOCK`, `SIDE_BUTTON`, `SIRI`), `simulator_open_url`, `simulator_install` (an `.app` inside the worktree) and `simulator_launch` (a bundle id). Each acts on the calling chat's worktree only. Coordinates are points: screenshot pixels divided by the scale in the screenshot's text.

`simulator_describe` returns the screen size and a flat list of elements that have a label, a value or are controls: type, label, value, id, enabled, frame and the center to tap, all in points. The chat shows a screenshot result as an image (sized to fit, a click opens it full size), and a simulator tool call has an "Open simulator" button.

## The Simulator tab

Entry points:

- "Simulator" in the center "+" menu, when the worktree's worker is online and reports the capability. The menu is built from the `worktree.panels` contributions of the bundled client plugins (`plugins/simulator/src/client`).
- The "Open simulator" button on a simulator tool call in the chat.
- `band simulators open [worktree]`. It calls `simulators.open`, which boots the device and adds `{ id: "plugin:simulator:simulator", kind: "plugin" }` to the worktree's shared tab list (`band:center-tabs:<id>`). Every connected client then opens the tab, and a reload or another device restores it.

Nothing opens the tab by itself when an agent uses the simulator.

The tab is a `RemoteScreen` (`apps/web/src/components/remote-screen/RemoteScreen.tsx`, handed to the plugin through the client host). It stays mounted while hidden (layout renderer `always`), so switching tabs does not reconnect. Closing the tab ends the stream only; the device stays booted until the cap or the worktree's removal. The header shows the device name and state, Take control / Release, Home, rotate, a screenshot button (saves the current frame as a PNG), and Reveal in Simulator.app only in the desktop app when the worktree's worker is this Mac's own worker (IPC `reveal_simulator`).

The viewer starts view-only. Take control sends `{"type":"control","enabled":true}`; from then on a pointer press, move and release go to the device as touches (positions as fractions of the screen, mapped to points by serve-sim), printable keys type text, and Enter, Backspace, Tab and Escape are key presses. Release sends `enabled: false`.

### The stream

`GET /api/plugins/<plugin id>/worktrees/<worktree id>/stream` is a WebSocket (`api/plugins/stream-handler.ts`), built like the desktop route. It takes a device token. The worker relay lists no such route, so an agent gets 403 (`remote-relay.test.ts`). The hub opens a `plugin.stream` link channel (`packages/link/src/plugins.ts`, `PluginStream` in `plugin-api`) to the worker's plugin; messages are text or bytes framed by `encodeMessageFrame`. The browser never connects to the worker, so it works through a remote hub.

Messages to the browser: one text `{"type":"info"}` (screen size in points, device udid and name), then one binary JPEG per frame. serve-sim's MJPEG is parsed by `Content-Length` on the worker; a slow viewer gets the newest frame, not a queue. H.264 is not used. Messages from the browser are JSON. The hub handles `control` and drops every other message, and every binary one, until control is on. Several viewers may connect; each has its own channel.

## Adopting this for the VNC desktop viewer

`RemoteScreen` is generic over what draws the frames and what the input messages mean. The desktop viewer could adopt it by a plugin-style stream whose messages are RFB bytes: swap the canvas drawing for noVNC's, and keep the header, the control toggle and the reconnect rules, which are the same. That is not done here.

Rotate: the header button sends `serve-sim rotate`, but on Xcode 26.6 the captured framebuffer and the accessibility screen stayed 1206x2622 and 402x874 after `landscape_left`, so the viewer shows no rotation there. The button is wired and gated by control; a visible effect is not verified.

## What breaks it

serve-sim uses private Apple APIs (`SimulatorKit`, `CoreSimulator`, `IndigoHID`). A new Xcode can break capture or input until serve-sim is updated, and the pin (`0.1.47`) is bumped by hand after testing `simulator-plugin.test.ts`. Xcode 27 needs Device Hub running for keyboard input (see serve-sim's README).

## Not done yet

Android, the mobile app showing the tab, moving the VNC viewer onto `RemoteScreen`, extensions, recording video, a `band simulators` command to list, and running it on the hub's own machine.
