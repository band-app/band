/**
 * Paths the OS asked Band to open (Finder's Open With, `open -a Band file`,
 * a file dropped on the Dock icon, a `band://file/<path>` URL). macOS delivers
 * them through the app's `open-file` and `open-url` events, which can fire
 * before the app is ready and before any window or page exists, so the
 * requests wait here until the renderer asks for them. The renderer drains the
 * queue when it starts and again each time the main process announces a new
 * request. No Electron import, so `node:test` can drive it.
 */

export interface OpenRequest {
  path: string;
  line?: number;
  column?: number;
  /** Set for a `band://` URL, where the main process checked the disk: a folder is selected, not opened. */
  directory?: boolean;
}

export class OpenFileQueue {
  private requests: OpenRequest[] = [];
  private listeners = new Set<() => void>();

  /** Queues an absolute path. Anything else is ignored. */
  push(path: string, extra: Omit<OpenRequest, "path"> = {}): void {
    if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) return;
    this.requests.push({ path, ...extra });
    for (const listener of this.listeners) listener();
  }

  /** Returns the queued requests in arrival order and empties the queue. */
  take(): OpenRequest[] {
    const taken = this.requests;
    this.requests = [];
    return taken;
  }

  /** Calls `fn` after each push. Returns a function that stops it. */
  onPush(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
