# iOS simulator for agents

A worktree on a Mac worker can have its own iOS simulator, which the worktree's agent drives with tools. This is the bundled `simulator` plugin (`plugins/simulator`). The live video panel is not part of it yet.

## Requirements

The worker must be a Mac with Xcode (`xcrun simctl`). A worker reports the `simulator` capability when it is. Touch and text input also need `idb` and `idb_companion` (`brew install facebook/fb/idb-companion`, `pipx install fb-idb`). Without them the status, screenshot, URL, install and launch tools work and the input tools say what to install. `BAND_IDB_BIN` and `BAND_IDB_COMPANION_BIN` name the binaries when they are not on the worker's `PATH`.

The hub's own machine runs no worker plugins. Use a worktree on a connected worker, such as the desktop app's "This Mac" worker.

## Devices

Devices live in a Band-owned device set at `<worker state dir>/simulator/devices`, never in your default set. The first use creates a base device (the newest iOS runtime and the newest iPhone Pro it supports) and each worktree's device is a clone of it. `BAND_SIMULATOR_DEVICE_TYPE` and `BAND_SIMULATOR_RUNTIME` pick another base before the first use.

A booted device uses about 5.7 GB of memory and a device about 5 GB of disk. `BAND_SIMULATOR_MAX_BOOTED` (default 2, read on every call) caps booted devices. Booting one over the cap shuts down the least recently used, which is only shut down, not deleted. Removing the worktree deletes its device. Stopping the worker, or a lease fence, shuts devices down and keeps them.

## Tools

`simulator_status`, `simulator_screenshot` (a PNG), `simulator_tap`, `simulator_type`, `simulator_button`, `simulator_open_url`, `simulator_install` (an `.app` inside the worktree) and `simulator_launch` (a bundle id). Each acts on the calling chat's worktree only. Tap coordinates are points: screenshot pixels divided by the scale `simulator_status` reports.

## Why idb for input

`simctl` has no tap or text command. Two routes exist. serve-sim (used by Orca) drives the simulator's private HID APIs directly, and is not on npm or Homebrew here, so Band would have to ship or build it. idb is maintained by Meta, installs from Homebrew and pip, takes `--device-set-path` so it works with the Band device set, and offers `ui tap`, `ui text` and `ui button`. Band starts one `idb_companion` per booted device and stops it with the device. The cost is a second install on the worker and about a second of Python start-up per input.

## Not done yet

The video stream and panel, Android, `band simulators` in the CLI, and running it on the hub's own machine.
