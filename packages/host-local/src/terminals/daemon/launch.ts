import { retireDaemon } from "../../daemon-kit/connection";
import type { EndpointIdentity } from "../../daemon-kit/endpoint";
import { launchDaemon as launchKitDaemon } from "../../daemon-kit/launch";
import type { DaemonPaths } from "../../daemon-kit/protocol";
import { daemonPaths, EXIT_NODE_PTY_UNAVAILABLE, IDENTITY, PROTOCOL_VERSION } from "./protocol";

export interface LaunchOptions {
  /** `dist/terminal-daemon.mjs`, or `terminal-daemon.ts` under tsx in dev. */
  entry: string;
  paths: DaemonPaths;
  /** The daemon's working directory: `~/.band`, never a worktree, since worktrees get deleted. */
  cwd: string;
  buildId: string;
  /** Take the endpoint from the live daemon of another build at this entry. */
  supersede?: EndpointIdentity;
  /** The daemon records exits that happen while no server is connected. */
  recordExits?: boolean;
  /** Node flags for the daemon, such as a loader for a `.ts` entry. Defaults to this process's. */
  execArgv?: string[];
}

/**
 * Start a detached terminal daemon and wait until it serves the endpoint.
 * Resolves `occupied` when another daemon won the race to publish; connect to
 * that one. The child runs under the server's own runtime so node-pty's native
 * ABI matches, and under the desktop app `ELECTRON_RUN_AS_NODE=1` also keeps
 * Electron's display init away from node-pty's `posix_spawn`.
 */
export function launchDaemon(options: LaunchOptions): Promise<"launched" | "occupied"> {
  const { recordExits, ...rest } = options;
  return launchKitDaemon({
    ...rest,
    extraArgs: recordExits ? ["--record-exits"] : undefined,
    label: IDENTITY.label,
    describeExit: (code) =>
      code === EXIT_NODE_PTY_UNAVAILABLE
        ? "Terminal daemon could not load its native module (node-pty)"
        : undefined,
  });
}

/**
 * Ask daemons of older protocol versions on this home to exit before
 * launching ours. Their sessions are lost on that upgrade; keeping them
 * attachable is a follow-up. Uses the hello / mismatch / shutdown exchange,
 * the one part of the protocol that never changes.
 */
export async function retireOlderDaemons(runDir: string, buildId: string): Promise<void> {
  for (let version = 1; version < PROTOCOL_VERSION; version++) {
    try {
      await retireDaemon(daemonPaths(runDir, version), buildId, IDENTITY);
    } catch {
      // Nothing running there, or nothing we may touch.
    }
  }
}
