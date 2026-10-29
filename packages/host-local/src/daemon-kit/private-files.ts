import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { DaemonPaths } from "./protocol";

/** Write `path` with mode 0600, atomically, so a reader never sees half a token. */
export function writePrivateFile(path: string, content: string): void {
  // A random suffix, not the pid: a recycled pid could share a tmp name.
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Copy a private runtime file, if it exists. */
export function copyPrivateFile(from: string, to: string): void {
  let content: string;
  try {
    content = readFileSync(from, "utf8");
  } catch {
    return;
  }
  writePrivateFile(to, content);
}

/** Remove the retired names this daemon created. */
export function removeRetiredFiles(retired: DaemonPaths): void {
  for (const path of [retired.socket, retired.token, retired.pid]) {
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
  }
}

/** Constant-time comparison of a hello's token with the daemon's own. */
export function tokenMatches(expected: string, candidate: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(candidate);
  return a.length === b.length && timingSafeEqual(a, b);
}
