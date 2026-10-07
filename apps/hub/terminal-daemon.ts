// Entry point of the terminal daemon: the detached process that owns every
// terminal's PTY so shells survive a web-server restart. Bundled to
// `dist/terminal-daemon.mjs` by `scripts/build-server.sh`; launched by the
// web server (`packages/host-local/src/terminals/daemon/launch.ts`), never by hand.
//
//   terminal-daemon.mjs --run-dir <~/.band/run> --build-id <id> [--supersede <dev>:<ino>]
//
// The body is shared with the worker's daemon entry: `daemon/main.ts`.

import { runDaemonMain } from "@band-app/host-local/terminals/daemon/main";

await runDaemonMain(import.meta.url);
