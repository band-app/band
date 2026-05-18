/**
 * Pure helpers that back `pickSaveFile` in `./macos-shell.ts`.
 *
 * Separated from `macos-shell.ts` so they can be unit-/integration-
 * tested without dragging in the `electron` module — `node:test` runs
 * outside the Electron runtime and `import { dialog } from "electron"`
 * throws there. The IPC handler itself stays in `macos-shell.ts` (it
 * needs Electron's `dialog.showSaveDialog`), but its bytes-to-disk and
 * default-seed computation are isolated here.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Compute the default seed path for the OS save dialog from caller-
 * supplied `defaultName` and `defaultPath`. Decides what `defaultPath`
 * to hand to Electron's `dialog.showSaveDialog`:
 *
 *   - Both: join `defaultPath` and `defaultName` (e.g. workspace +
 *     "Untitled-1.txt"). This is the common case when the editor knows
 *     the active worktree.
 *   - Only `defaultPath`: hand the directory to Electron and let it
 *     pick the filename interactively.
 *   - Only `defaultName`: use the bare filename; Electron anchors it
 *     against the last-used save dir.
 *   - Neither: fall back to "Untitled.txt".
 */
export function resolveSaveDialogSeed(args: {
  defaultName?: string;
  defaultPath?: string;
}): string {
  if (args.defaultPath) {
    return args.defaultName ? join(args.defaultPath, args.defaultName) : args.defaultPath;
  }
  return args.defaultName ?? "Untitled.txt";
}

/**
 * Persist `content` to `filePath` using a UTF-8 write. The IPC handler
 * invokes this once Electron's save dialog returns a path; the
 * separation lets the integration tests exercise the on-disk path
 * directly without driving the native dialog.
 *
 * Throws on filesystem errors (permission denied, parent missing) so
 * the error surfaces through the IPC invoke chain rather than silently
 * succeeding and losing the user's work.
 */
export function writeSavedFile(filePath: string, content: string): void {
  writeFileSync(filePath, content, "utf8");
}
