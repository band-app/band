import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AcpLaunch } from "@band-app/host-api";

/** The version of an adapter package at or above `file`, or null for a script outside one. */
function packageVersion(file: string): string | null {
  let dir = dirname(file);
  for (let depth = 0; depth < 6; depth++) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name?.startsWith("@agentclientprotocol/") && pkg.version) {
          return `${pkg.name}@${pkg.version}`;
        }
      } catch {
        // Not readable: fall through to the file's own stamp.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function stamp(file: string): string | null {
  try {
    const stats = statSync(file);
    if (!stats.isFile()) return null;
    return `file:${stats.size}-${Math.trunc(stats.mtimeMs)}`;
  } catch {
    return null;
  }
}

/**
 * What identifies the code a launch runs: the adapter package's version, or for a bundled
 * adapter, a native agent binary or a stand-in script, the file's size and mtime. A worker
 * update that changes it makes a held agent restart at the next clean point.
 */
export function adapterVersionOf(launch: AcpLaunch): string | undefined {
  const script = launch.args.find((arg) => arg.startsWith("/") && stamp(arg) !== null);
  if (script) return packageVersion(script) ?? stamp(script) ?? undefined;
  return stamp(launch.command) ?? undefined;
}
