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

import { randomBytes } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
 * Persist `content` to `filePath` using an atomic write-to-temp +
 * rename pattern. Three guarantees that follow from the layout:
 *
 *   1. **Async.** The IPC handler runs on the Electron main process —
 *      a synchronous `writeFileSync` would freeze the event loop and
 *      every renderer IPC call until the write completes (visible as
 *      app stalls on slow disks or large buffers). `fs/promises`
 *      yields between syscalls.
 *
 *   2. **Atomic at the filesystem level.** `writeFile` truncates the
 *      destination before streaming bytes, so a crash / SIGKILL /
 *      power loss mid-write would zero the file. We write to a sibling
 *      `.band-save-<rand>.tmp` first, then `rename(2)` — which is
 *      atomic on POSIX and best-effort on Windows (NTFS implements it
 *      via MoveFileEx with `REPLACE_EXISTING`). Either the user sees
 *      the previous contents or the new contents, never a truncated
 *      file.
 *
 *   3. **Errors propagate.** Filesystem failures (permission denied,
 *      parent missing, disk full mid-rename) throw so the IPC chain
 *      surfaces them to the renderer; we still try to remove the temp
 *      file on the error path so a failed save doesn't litter the
 *      worktree.
 */
export async function writeSavedFile(filePath: string, content: string): Promise<void> {
  // 12 hex chars (6 random bytes) is more than enough for a temp name —
  // collision probability inside a single save is astronomically low,
  // and the temp lives in the same directory as the target so any
  // overlap with an existing dotfile would be coincidental.
  const tmp = join(dirname(filePath), `.band-save-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, filePath);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      // Ignore cleanup error — the original error is what the caller
      // cares about. The temp file may legitimately not exist yet (the
      // `writeFile` itself failed) or the unlink may race with another
      // process; neither should mask the real failure.
    }
    throw err;
  }
}
