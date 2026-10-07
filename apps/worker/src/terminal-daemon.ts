// Entry point of the worker's terminal daemon: the detached process that owns
// every terminal's PTY so shells survive a worker restart. Bundled to
// `dist/terminal-daemon.mjs` by `scripts/build.mjs`; launched by the worker
// (`src/terminals.ts`), never by hand.
//
//   terminal-daemon.mjs --run-dir <state dir>/run --build-id <id> [--supersede <dev>:<ino>] --record-exits

import { runDaemonMain } from "@band-app/host-local/terminals/daemon/main";

await runDaemonMain(import.meta.url);
