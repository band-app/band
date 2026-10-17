import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RunTmp {
  dir: string;
  remove(): void;
}

/**
 * A temp dir only this run uses. Maestro writes its `maestro_xctestrunner_xcodebuild_output*`
 * folders (about 200 MB each) into TMPDIR, so the Maestro child gets this dir as its TMPDIR and
 * the run deletes the whole dir at the end. A sibling run has its own dir, so cleanup never
 * touches a folder another run still uses.
 */
export function createRunTmp(base: string = tmpdir()): RunTmp {
  const dir = mkdtempSync(join(base, "band-verify-"));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Removes `tmp` when the process exits, and on SIGINT or SIGTERM, which a default handler would
 * not let `exit` listeners see. Returns a function that removes the dir now.
 */
export function removeOnExit(tmp: RunTmp): () => void {
  process.on("exit", tmp.remove);
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.on(signal, () => process.exit(code));
  }
  return tmp.remove;
}

/**
 * Maestro is a JVM program, and on macOS Java ignores TMPDIR (`java.io.tmpdir` comes from the
 * per-user Darwin temp dir), so the child also needs the property. Maestro's launcher passes
 * `MAESTRO_OPTS` to the JVM; any value already set stays in front.
 */
export function maestroTmpEnv(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const opts = [env.MAESTRO_OPTS, `-Djava.io.tmpdir=${dir}`].filter(Boolean).join(" ");
  return { TMPDIR: dir, MAESTRO_OPTS: opts };
}

const STALE_PREFIX = "maestro_xctestrunner_xcodebuild_output";

function sizeOf(path: string): number {
  const st = lstatSync(path);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of readdirSync(path)) {
    try {
      total += sizeOf(join(path, name));
    } catch {
      // A file that vanished mid-walk counts for nothing.
    }
  }
  return total;
}

/**
 * Deletes `maestro_xctestrunner_xcodebuild_output*` folders directly in `base` that were last
 * modified more than `maxAgeMs` ago: leftovers of a run that crashed before it cleaned up.
 * Younger folders may belong to a run in progress and stay. Nothing else in `base` is touched.
 */
export function sweepStaleMaestroOutput(
  base: string = tmpdir(),
  maxAgeMs: number = 2 * 60 * 60 * 1000,
  now: number = Date.now(),
): { removed: number; bytes: number } {
  let removed = 0;
  let bytes = 0;
  for (const name of readdirSync(base)) {
    if (!name.startsWith(STALE_PREFIX)) continue;
    const path = join(base, name);
    try {
      const st = lstatSync(path);
      if (!st.isDirectory() || now - st.mtimeMs <= maxAgeMs) continue;
      const size = sizeOf(path);
      rmSync(path, { recursive: true, force: true });
      removed++;
      bytes += size;
    } catch {
      // Another run may be deleting it too.
    }
  }
  return { removed, bytes };
}
