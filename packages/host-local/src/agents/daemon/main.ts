import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createLogger } from "@band-app/logger";
import { runDaemon } from "./daemon-server";
import { agentDaemonPaths } from "./protocol";

const log = createLogger("agent-daemon");

/**
 * The body of the agent daemon's entry file (`apps/worker/src/agent-daemon.ts`). Never returns:
 * it exits the process when the daemon stops.
 *
 *   <entry> --run-dir <dir> --build-id <id> [--supersede <dev>:<ino>]
 *
 * Reports readiness to the launcher over the fork IPC channel, then drops the channel so the two
 * processes are independent.
 */
export async function runAgentDaemonMain(entryUrl: string): Promise<never> {
  // Losing the daemon loses every agent, so a stray exception from one is logged, not fatal.
  process.on("uncaughtException", (err) => {
    log.error({ err }, "uncaught exception in agent daemon");
  });
  process.on("unhandledRejection", (err) => {
    log.error({ err }, "unhandled rejection in agent daemon");
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
    log.error("agent daemon needs --run-dir");
    process.exit(2);
  }
  const supersede = values.supersede?.match(/^(\d+):(\d+)$/);
  if (values.supersede !== undefined && !supersede) {
    log.error({ supersede: values.supersede }, "agent daemon got a malformed --supersede");
    process.exit(2);
  }

  const exitCode = await runDaemon({
    paths: agentDaemonPaths(runDir),
    buildId: values["build-id"] ?? "unknown",
    entry: fileURLToPath(entryUrl),
    supersede: supersede ? { dev: BigInt(supersede[1]), ino: BigInt(supersede[2]) } : undefined,
    onReady: () => {
      process.send?.({ type: "ready", pid: process.pid }, () => {
        if (process.connected) process.disconnect();
      });
    },
  });
  process.exit(exitCode);
}
