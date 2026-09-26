// Entry point of the terminal daemon: the detached process that owns every
// terminal's PTY so shells survive a web-server restart. Bundled to
// `dist/terminal-daemon.mjs` by `scripts/build-server.sh`; launched by the
// web server (`src/server/infra/terminals/daemon/launch.ts`), never by hand.
//
//   terminal-daemon.mjs --run-dir <~/.band/run> --build-id <id> [--supersede <dev>:<ino>]
//
// `--supersede` names the socket of a live daemon of another build that this
// one takes the endpoint from (issue #652); see `publishEndpoint`.
//
// Reports readiness to the launcher over the fork IPC channel, then drops
// the channel so the two processes are independent.

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createLogger } from "@band-app/logger";
import { runDaemon } from "./src/server/infra/terminals/daemon/daemon-server.ts";
import { daemonPaths } from "./src/server/infra/terminals/daemon/protocol.ts";

const log = createLogger("terminal-daemon");

// Losing the daemon loses every shell, so a stray exception from one session
// (a node-pty callback, a malformed frame handler) is logged, not fatal.
process.on("uncaughtException", (err) => {
  log.error({ err }, "uncaught exception in terminal daemon");
});
process.on("unhandledRejection", (err) => {
  log.error({ err }, "unhandled rejection in terminal daemon");
});

const { values } = parseArgs({
  options: {
    "run-dir": { type: "string" },
    "build-id": { type: "string", default: "unknown" },
    supersede: { type: "string" },
  },
});
const runDir = values["run-dir"];
if (!runDir) {
  log.error("terminal daemon needs --run-dir");
  process.exit(2);
}

const supersede = values.supersede?.match(/^(\d+):(\d+)$/);
if (values.supersede !== undefined && !supersede) {
  log.error({ supersede: values.supersede }, "terminal daemon got a malformed --supersede");
  process.exit(2);
}

const exitCode = await runDaemon({
  paths: daemonPaths(runDir),
  buildId: values["build-id"] ?? "unknown",
  entry: fileURLToPath(import.meta.url),
  supersede: supersede ? { dev: BigInt(supersede[1]), ino: BigInt(supersede[2]) } : undefined,
  onReady: () => {
    // Disconnect once the message is flushed: an open IPC channel keeps both
    // processes tied together.
    process.send?.({ type: "ready", pid: process.pid }, () => {
      if (process.connected) process.disconnect();
    });
  },
});
process.exit(exitCode);
