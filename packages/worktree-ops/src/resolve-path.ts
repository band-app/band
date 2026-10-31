/**
 * Where a path stands relative to a worktree: canonical, existing, inside the
 * worktree or not. The hub's `worktree.resolvePath` and `band open`, and a
 * worker's direct listener, all use it.
 */

import { isAbsolute, join, resolve, sep } from "node:path";
import type { FsStat, HostFs } from "@band-app/host-api";
import { WorktreeNotFoundError, type WorktreeResolver } from "./resolver";

export interface ResolvedPath {
  /** The symlink-free absolute path, also for one that does not exist yet. */
  canonicalTarget: string;
  exists: boolean;
  isFile: boolean;
  inside: boolean;
  /** POSIX worktree-relative path when `inside`, else null. */
  relativePath: string | null;
}

export interface ResolvePathResult {
  exists: boolean;
  isFile: boolean;
  /** True when the path lies outside the worktree. */
  external: boolean;
  /** POSIX worktree-relative path, set only when inside the worktree. */
  worktreeRelativePath: string | null;
}

export class PathsService {
  constructor(private readonly worktrees: WorktreeResolver) {}

  async resolvePath(input: { worktreeId: string; filePath: string }): Promise<ResolvePathResult> {
    const worktree = this.worktrees.resolve(input.worktreeId);
    if (!worktree) throw new WorktreeNotFoundError(input.worktreeId);
    const resolved = await resolveTarget(worktree.host.fs, worktree.worktree.path, input.filePath);
    return {
      exists: resolved.exists,
      isFile: resolved.isFile,
      external: !resolved.inside,
      worktreeRelativePath: resolved.inside ? resolved.relativePath : null,
    };
  }
}

/**
 * Shared resolution core for `PathsService.resolvePath` and the hub's `band open`:
 * canonicalize the target (following the deepest existing ancestor so
 * not-yet-created paths still classify), stat it, and run the
 * segment-aware containment check against the canonicalized worktree root.
 */
export async function resolveTarget(
  fs: HostFs,
  root: string,
  filePath: string,
): Promise<ResolvedPath> {
  // Absolute paths are taken as-is; relative paths resolve against root.
  const absoluteTarget = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);

  // Canonicalize the worktree root so symlinked path prefixes
  // (macOS's `/var/folders` → `/private/var/folders` in particular)
  // compare equal. The CLI canonicalizes the user's argument before
  // sending, so a stored worktree path under `/var/...` would
  // otherwise look "outside" its real location. Async fs (fs/promises)
  // so the tRPC query handler never parks the event loop on sync I/O.
  let canonicalRoot = root;
  try {
    canonicalRoot = await fs.realpath(root);
  } catch {
    // worktree may have been deleted out from under us — leave as-is
  }

  // Canonicalize the user's path the same way. `realpath` fails on
  // missing files, so walk up to the deepest ancestor that does exist,
  // canonicalize that, then re-append the trailing segments. That
  // keeps the in-worktree check accurate for paths the user wants to
  // *create* as well.
  const canonicalTarget = await canonicalizeMaybeMissing(fs, absoluteTarget);

  let targetStat: FsStat | null = null;
  try {
    targetStat = await fs.stat(canonicalTarget, { followSymlinks: true });
  } catch {
    // ENOENT or another IO error — reported via `exists: false`.
  }

  // Segment-aware containment check (same invariant as the untitled
  // save flow in CodeBrowserView): a naive `startsWith` would treat
  // `/a/band-fork/x.ts` as inside `/a/band`.
  const normalizedRoot = canonicalRoot.replace(/\/+$/, "");
  const inside =
    canonicalTarget === normalizedRoot || canonicalTarget.startsWith(`${normalizedRoot}${sep}`);

  // POSIX separators on the wire — tanstack-router and
  // `parseFileLocation` both work off `/`-separated paths.
  const relativePath = inside
    ? (canonicalTarget === normalizedRoot ? "" : canonicalTarget.slice(normalizedRoot.length + 1))
        .split(sep)
        .join("/")
    : null;

  return {
    canonicalTarget,
    exists: !!targetStat,
    isFile: targetStat?.kind === "file",
    inside,
    relativePath,
  };
}

/**
 * `realpath` resolves symlinks but throws ENOENT for paths that don't
 * exist. We need the symlink-resolution part for paths that may or may not
 * exist (e.g. files the user wants to *open* that don't exist yet). Try to
 * canonicalize the whole path; on failure walk up to the deepest ancestor
 * that does resolve, canonicalize that, then re-append the trailing
 * segments. Async (fs/promises) so callers don't block the event loop.
 */
async function canonicalizeMaybeMissing(fs: HostFs, p: string): Promise<string> {
  try {
    // Succeeds iff `p` exists and every component resolves.
    return await fs.realpath(p);
  } catch {
    // Missing / unresolvable — fall through to the walk-up below.
  }
  const parts = p.split(sep);
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join(sep) || sep;
    try {
      const canonicalPrefix = await fs.realpath(prefix);
      // `path.join` collapses the duplicate separator that arises when
      // `canonicalPrefix === "/"`.
      return join(canonicalPrefix, ...parts.slice(i));
    } catch {
      // keep walking up toward the root
    }
  }
  return p;
}
