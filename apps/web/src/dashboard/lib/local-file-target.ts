import { findWorktreeForPath } from "./html-preview";

export interface LocalWorktree {
  id: string;
  path: string;
  hostId?: string;
}

export type LocalFilePlan =
  /** The file is inside a worktree on this Mac: switch there and open a normal tab. */
  | { kind: "worktree"; worktreeId: string; relPath: string }
  /** The file is outside every worktree on this Mac: an external tab read by the desktop app. */
  | { kind: "external"; worktreeId: string }
  /** There is nowhere to open it. */
  | { kind: "none"; reason: string };

/**
 * Decides where a file that lives on this Mac opens (Finder's Open With, a
 * drag from Finder, the Open File picker). A file inside a worktree whose
 * worker runs on this Mac opens there as a normal editable tab. Any other
 * file opens as an external tab in the current worktree, read and saved by
 * the desktop app. `thisMachineHostIds` holds the ids of the workers on this
 * Mac: its own worker, and `local` when the app runs the hub itself.
 */
export function planLocalFileOpen(
  absPath: string,
  worktrees: LocalWorktree[],
  thisMachineHostIds: string[],
  currentWorktreeId: string | null,
): LocalFilePlan {
  let best: { worktree: LocalWorktree; relPath: string } | null = null;
  for (const hostId of thisMachineHostIds) {
    const found = findWorktreeForPath(absPath, hostId, worktrees);
    if (!found || !found.relPath) continue;
    if (!best || found.worktree.path.length > best.worktree.path.length) best = found;
  }
  if (best) return { kind: "worktree", worktreeId: best.worktree.id, relPath: best.relPath };
  if (currentWorktreeId) return { kind: "external", worktreeId: currentWorktreeId };
  return { kind: "none", reason: "Open a worktree first, then open the file again." };
}
