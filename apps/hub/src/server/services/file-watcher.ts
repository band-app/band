import type { Host } from "@band-app/host-api";
import { workspaceService } from "./workspace-service";

// ---------------------------------------------------------------------------
// Server-side file watcher
// ---------------------------------------------------------------------------
//
// One recursive watch (`host.fs.watch`) per workspace, started on demand when a client
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
//   * A watch may fail to start or end if the worktree was deleted; we
//     swallow the first and tell listeners about the second.
// ---------------------------------------------------------------------------

// Directory segments whose contents we never report to the client. Keeping
// them out of the event stream avoids flooding the FileBrowser with
// meaningless events when, for example, "pnpm install" rewrites
// node_modules.
//
// Trade-off: this match is depth-agnostic, so "target/" anywhere in the
// tree is silently filtered (intentional — Rust monorepos write to
// apps/cli/target/, packages/*/target/, etc. on every cargo build). The
// cost is that a repo that legitimately uses one of these names as a
// source directory (e.g. a Go project with a nested "build/" source
// folder) will see no refresh events from it. If a real user hits that,
// the right fix is a per-project configurable ignore list rather than
// unilaterally narrowing this set.
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

/**
 * Listener for file-change events.
 *
 * - `path` (string): workspace-relative parent directory whose contents
 *   changed.
 * - `path === null`: sentinel meaning the underlying watcher hit an
 *   unrecoverable error (e.g. the worktree directory was deleted) and is
 *   shutting down. Listeners should stop waiting for more events and let
 *   their subscription complete; the next subscriber will create a fresh
 *   watcher.
 */
export type FileChangeListener = (path: string | null) => void;
export type Unsubscribe = () => void;

interface WatchEntry {
  /** Aborting it ends the host's change stream and so releases the OS watch handle. */
  controller: AbortController;
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

function stopWatcher(workspaceId: string, entry: WatchEntry): void {
  entry.controller.abort();
  for (const timer of entry.pendingTimers.values()) clearTimeout(timer);
  entry.pendingTimers.clear();
  // A newer entry may have replaced this one.
  if (watchers.get(workspaceId) === entry) watchers.delete(workspaceId);
}

/** Feeds the host's change stream into `scheduleEmit` until it ends or the entry stops. */
async function pumpChanges(
  workspaceId: string,
  entry: WatchEntry,
  host: Host,
  root: string,
): Promise<void> {
  try {
    // `recursive` needs Node ≥ 22 on Linux (macOS and Windows always had it).
    // Band's web server already requires Node ≥ 22.5
    // (`apps/hub/package.json#engines`), so this is safe on every platform.
    for await (const change of host.fs.watch(root, {
      recursive: true,
      signal: entry.controller.signal,
    })) {
      const relative = change.path;
      if (!relative || isIgnoredPath(relative)) continue;
      scheduleEmit(workspaceId, parentDirOf(relative));
    }
  } catch {
    // The worktree may have been deleted between resolve and the watch
    // start. Treat it as a silent no-op, as a failed start always was.
    // A subscriber that joined before the failure surfaced must still end.
    for (const listener of entry.listeners) listener(null);
    stopWatcher(workspaceId, entry);
    return;
  }
  if (entry.controller.signal.aborted) return;
  // The stream ended on its own, as a watch does when the watched directory
  // is removed. Wake every current subscriber with a `null` sentinel so
  // their tRPC generators can finish cleanly instead of parking forever
  // waiting for an event from a dead watcher.
  for (const listener of entry.listeners) listener(null);
  stopWatcher(workspaceId, entry);
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
    const ws = workspaceService.resolve(workspaceId);
    if (!ws) return () => {};
    const root = ws.worktree.path;

    entry = { controller: new AbortController(), listeners: new Set(), pendingTimers: new Map() };
    watchers.set(workspaceId, entry);
    void pumpChanges(workspaceId, entry, ws.host, root);
  }

  entry.listeners.add(listener);

  const subscribed = entry;
  return () => {
    subscribed.listeners.delete(listener);
    if (subscribed.listeners.size === 0) stopWatcher(workspaceId, subscribed);
  };
}
