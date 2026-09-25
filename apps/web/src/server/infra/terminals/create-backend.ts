import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@band-app/logger";
import { DaemonTerminalBackend } from "./daemon/daemon-backend";
import { InProcessTerminalBackend } from "./in-process-backend";
import type { TerminalBackend } from "./terminal-backend";

const log = createLogger("terminal-backend");

/**
 * Pick where this server's terminals live.
 *
 * `serverRoot` is the directory holding the server entry: `dist/` for the
 * bundle, where the daemon is `terminal-daemon.mjs`, or `apps/web/` in dev,
 * where tsx runs `terminal-daemon.ts` (the fork inherits tsx's loader flags).
 */
export function createTerminalBackend(serverRoot: string, bandHome: string): TerminalBackend {
  if (process.platform === "win32") return new InProcessTerminalBackend();
  if (process.env.BAND_TERMINAL_DAEMON !== "1") return new InProcessTerminalBackend();

  const entry = [
    join(serverRoot, "terminal-daemon.mjs"),
    join(serverRoot, "terminal-daemon.ts"),
  ].find((candidate) => existsSync(candidate));
  if (!entry) {
    log.error(
      { serverRoot },
      "terminal daemon entry is missing; terminals will not survive a server restart",
    );
    return new InProcessTerminalBackend();
  }
  const { size, mtimeMs } = statSync(entry);
  return new DaemonTerminalBackend({
    entry,
    runDir: join(bandHome, "run"),
    cwd: bandHome,
    buildId: `${size}-${Math.trunc(mtimeMs)}`,
  });
}
