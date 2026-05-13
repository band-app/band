import { type FSWatcher, watch as fsWatch } from "node:fs";
import { resolveWorkspace } from "./workspace";

// ---------------------------------------------------------------------------
// Server-side file watcher
// ---------------------------------------------------------------------------
//
// One recursive `fs.watch` per workspace, started on demand when a client
// subscribes for that workspace's file changes and stopped when the last
// subscriber disconnects. The watcher emits a coalesced `(workspaceId,
// parentDir)` event so the client FileBrowser can invalidate its
// in-memory directory cache.
//
// We don't push directory contents through the event — the client already
// knows how to re-fetch via `listFiles`. The event just says which parent
// directory to invalidate.
//
// Per-workspace lifecycle (not global) so we don't hold OS watch handles
// open on every worktree the user has ever added — see issue #384.
//
// Edge-cases:
//   * Heavy directories (`.git`, `node_modules`, build output) are
//     filtered out so the watcher doesn't drown the client in noise.
//   * Events are coalesced per (workspaceId, parentDir) with a short
//     debounce — a rapid burst (e.g. `git checkout`) maps to one refresh.
//   * `fs.watch` may emit `null` filenames or throw if the worktree was
//     deleted; we swallow both.
// ---------------------------------------------------------------------------

/**
 * Directory segments whose contents we never report to the client. Keeping
 * them out of the event stream avoids flooding the FileBrowser with
 * meaningless events when, for example, `pnpm install` rewrites
 * `node_modules`.
 */
const IGNORED_SEGMENTS = new Set<string>([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".vite",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".band",
  ".DS_Store",
]);

/**
 * Window (in milliseconds) over which we coalesce events for the same
 * (workspaceId, parentDir) pair. Short enough to feel snappy; long enough
 * to collapse rapid bursts (saves, git operations) into one refresh.
 */
const DEBOUNCE_MS = 250;

export type FileChangeListener = (path: string) => void;
export type Unsubscribe = () => void;

interface WatchEntry {
  watcher: FSWatcher;
  listeners: Set<FileChangeListener>;
  pendingTimers: Map<string, ReturnType<typeof setTimeout>>;
}

const watchers = new Map<string, WatchEntry>();

function isIgnoredPath(relativePath: string): boolean {
  if (!relativePath) return false;
  for (const segment of relativePath.split(/[\\/]+/)) {
    if (IGNORED_SEGMENTS.has(segment)) return true;
  }
  return false;
}

function parentDirOf(relativePath: string): string {
  const normalised = relativePath.split(/[\\/]+/).join("/");
  const idx = normalised.lastIndexOf("/");
  return idx === -1 ? "" : normalised.slice(0, idx);
}

function scheduleEmit(workspaceId: string, dirPath: string): void {
  const entry = watchers.get(workspaceId);
  if (!entry) return;
  const existing = entry.pendingTimers.get(dirPath);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    entry.pendingTimers.delete(dirPath);
    // Re-resolve the entry — listeners may have been torn down during the
    // debounce window.
    const current = watchers.get(workspaceId);
    if (!current) return;
    for (const listener of current.listeners) listener(dirPath);
  }, DEBOUNCE_MS);
  entry.pendingTimers.set(dirPath, timer);
}

function stopWatcher(workspaceId: string): void {
  const entry = watchers.get(workspaceId);
  if (!entry) return;
  try {
    entry.watcher.close();
  } catch {
    // Already closed — nothing to do.
  }
  for (const timer of entry.pendingTimers.values()) clearTimeout(timer);
  entry.pendingTimers.clear();
  watchers.delete(workspaceId);
}

/**
 * Subscribe to external file-system changes inside a workspace. The
 * watcher is started lazily on the first subscription and torn down when
 * the last subscriber disconnects. Returns an unsubscribe function.
 *
 * If the workspace can't be resolved (e.g. it was just removed) the
 * subscription is a silent no-op so callers don't need a separate
 * error-handling path.
 */
export function subscribeToFileChanges(
  workspaceId: string,
  listener: FileChangeListener,
): Unsubscribe {
  let entry = watchers.get(workspaceId);

  if (!entry) {
    const ws = resolveWorkspace(workspaceId);
    if (!ws) return () => {};
    const root = ws.worktree.path;

    let watcher: FSWatcher;
    try {
      watcher = fsWatch(root, { recursive: true, persistent: false }, (_event, filename) => {
        // `filename` may be null on some platforms or under heavy churn —
        // the change is real but we can't pinpoint where, so skip. Without
        // `encoding: "buffer"` Node returns a string, but we accept both
        // for safety.
        if (filename == null) return;
        const relative = typeof filename === "string" ? filename : Buffer.from(filename).toString();
        if (!relative || isIgnoredPath(relative)) return;
        scheduleEmit(workspaceId, parentDirOf(relative));
      });
    } catch {
      // The worktree may have been deleted between resolveWorkspace and
      // fs.watch. Treat this subscription as a silent no-op.
      return () => {};
    }

    entry = { watcher, listeners: new Set(), pendingTimers: new Map() };
    // Recursive watches can emit transient errors (e.g. when a watched
    // subdir is removed). Drop the watcher so the next subscriber retries
    // with a fresh handle.
    watcher.on("error", () => stopWatcher(workspaceId));
    watchers.set(workspaceId, entry);
  }

  entry.listeners.add(listener);

  return () => {
    const current = watchers.get(workspaceId);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) stopWatcher(workspaceId);
  };
}
