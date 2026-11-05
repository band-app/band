/**
 * Files the OS asked Band to open (Finder's Open With, `open -a Band file`,
 * a file dropped on the Dock icon). macOS delivers them through the app's
 * `open-file` event, which can fire before the app is ready and before any
 * window or page exists, so the paths wait here until the renderer asks for
 * them. The renderer drains the queue when it starts and again each time the
 * main process announces a new path. No Electron import, so `node:test`
 * can drive it.
 */
export class OpenFileQueue {
  private paths: string[] = [];
  private listeners = new Set<() => void>();

  /** Queues an absolute path. Anything else is ignored. */
  push(path: string): void {
    if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) return;
    this.paths.push(path);
    for (const listener of this.listeners) listener();
  }

  /** Returns the queued paths in arrival order and empties the queue. */
  take(): string[] {
    const taken = this.paths;
    this.paths = [];
    return taken;
  }

  /** Calls `fn` after each push. Returns a function that stops it. */
  onPush(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
