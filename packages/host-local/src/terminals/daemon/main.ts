import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createLogger } from "@band-app/logger";
import { runDaemon } from "./daemon-server";
import { daemonPaths } from "./protocol";

const log = createLogger("terminal-daemon");

/**
 * The body of a terminal daemon entry file (`apps/hub/terminal-daemon.ts`,
 * `apps/worker/src/terminal-daemon.ts`), so the hub and the worker run the
 * same process. Never returns: it exits the process when the daemon stops.
 *
 *   <entry> --run-dir <dir> --build-id <id> [--supersede <dev>:<ino>] [--record-exits]
 *
 * `--supersede` names the socket of a live daemon of another build that this
 * one takes the endpoint from (issue #652); see `publishEndpoint`. Reports
 * readiness to the launcher over the fork IPC channel, then drops the channel
 * so the two processes are independent.
 */
export async function runDaemonMain(entryUrl: string): Promise<never> {
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
      "record-exits": { type: "boolean", default: false },
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
    entry: fileURLToPath(entryUrl),
    supersede: supersede ? { dev: BigInt(supersede[1]), ino: BigInt(supersede[2]) } : undefined,
    recordExits: values["record-exits"],
    onReady: () => {
      // Disconnect once the message is flushed: an open IPC channel keeps both
      // processes tied together.
      process.send?.({ type: "ready", pid: process.pid }, () => {
        if (process.connected) process.disconnect();
      });
    },
  });
  process.exit(exitCode);
}
