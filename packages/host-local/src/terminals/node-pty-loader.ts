type NodePtyModule = typeof import("node-pty");

let cachedImport: Promise<NodePtyModule> | undefined;

/**
 * Loads node-pty, memoizing the promise itself (not just the resolved value)
 * so concurrent callers share one import attempt.
 *
 * Node's own ESM loader caches a failed CommonJS evaluation for the rest of
 * the process, so retrying the import within one process can never help —
 * the daemon exits on a failed preload instead (see `runDaemon`), so the
 * *next* spawn launches a fresh process with a fresh module cache.
 */
export function preloadNodePty(): Promise<NodePtyModule> {
  cachedImport ??= import("node-pty");
  return cachedImport;
}
