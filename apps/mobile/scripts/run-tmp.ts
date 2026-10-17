import { mkdtempSync, rmSync } from "node:fs";
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
