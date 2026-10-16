/**
 * Output to the native view in batches. Every `write` crosses the JS bridge, so many small hub
 * frames (a build log arrives as 1 KB messages) are joined and sent together. One write is in
 * flight at a time and the chunks that arrive meanwhile wait, so a fast log queues in JS memory
 * and the UI thread is never handed more than `MAX_BATCH_BYTES` at once. The `parsed` callbacks
 * run after the view has taken the bytes, which is what acknowledges them to the hub.
 */

const MAX_BATCH_BYTES = 64 * 1024;

export class WriteBatcher {
  private queue: { bytes: Uint8Array; parsed: () => void }[] = [];
  private queuedBytes = 0;
  private flushing = false;
  private generation = 0;
  private readonly send: (bytes: Uint8Array) => Promise<void>;
  private readonly onOverflow?: () => void;
  /**
   * The most output that may wait to be sent. Past it the queue is dropped and `onOverflow` runs,
   * so a hidden terminal that nobody reads cannot grow without bound. The owner then replays the
   * screen. Infinity (the default) means no limit.
   */
  queueCap = Number.POSITIVE_INFINITY;

  constructor(send: (bytes: Uint8Array) => Promise<void>, onOverflow?: () => void) {
    this.send = send;
    this.onOverflow = onOverflow;
  }

  push(bytes: Uint8Array, parsed: () => void): void {
    this.queue.push({ bytes, parsed });
    this.queuedBytes += bytes.length;
    if (this.queuedBytes > this.queueCap) {
      this.clear();
      this.onOverflow?.();
      return;
    }
    if (!this.flushing) void this.flush();
  }

  /** Drops what has not been sent (a reconnect replays the whole screen). */
  clear(): void {
    this.generation++;
    const dropped = this.queue;
    this.queue = [];
    this.queuedBytes = 0;
    for (const item of dropped) item.parsed();
  }

  private async flush(): Promise<void> {
    this.flushing = true;
    const generation = this.generation;
    try {
      while (this.queue.length > 0) {
        // Let frames that arrive in the same tick join this batch.
        await Promise.resolve();
        if (generation !== this.generation) break;
        const batch: { bytes: Uint8Array; parsed: () => void }[] = [];
        let total = 0;
        while (this.queue.length > 0) {
          const next = this.queue[0];
          if (batch.length > 0 && total + next.bytes.length > MAX_BATCH_BYTES) break;
          batch.push(next);
          total += next.bytes.length;
          this.queue.shift();
          this.queuedBytes -= next.bytes.length;
        }
        const joined = new Uint8Array(total);
        let at = 0;
        for (const item of batch) {
          joined.set(item.bytes, at);
          at += item.bytes.length;
        }
        try {
          await this.send(joined);
        } catch {
          // A failed write (the view went away) still counts as taken, so the hub is not held up.
        }
        for (const item of batch) item.parsed();
        if (generation !== this.generation) break;
      }
    } finally {
      this.flushing = false;
      if (this.queue.length > 0) void this.flush();
    }
  }
}
