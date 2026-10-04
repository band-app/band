import {
  decodeCreditBytes,
  encodeCredit,
  encodeFrame,
  type Frame,
  MAX_CHUNK_BYTES,
} from "./protocol.ts";

/** What a channel needs from the session that owns it. */
export interface ChannelHost {
  /** Writes a binary frame if a socket is attached, and returns whether it did. */
  writeBinary(buf: Buffer): boolean;
  /** Called once both directions have ended and the peer acknowledged our end. */
  channelDone(chan: number): void;
}

interface SendFrame {
  frame: Frame;
  /** True once the frame has been written once and counted against the window. */
  counted: boolean;
  /** Settles the `send()` call that owns this frame, if it is that call's last one. */
  done?: { resolve: () => void };
}

/**
 * One numbered byte stream. Sending is credit-gated: at most `window` bytes
 * are in flight, meaning written but not yet consumed by the peer's reader.
 * Receiving is pull-based (`for await`), and a chunk's credit goes back to
 * the sender only when the reader takes it.
 *
 * Sequence numbers count data and end frames from 1. Frames stay in `retained`
 * until the peer reports it consumed them, so a reconnect can replay whatever
 * the old socket lost. The receiver drops any frame at or below its last
 * received sequence, so replay delivers every frame exactly once.
 */
export class Channel implements AsyncIterable<Buffer> {
  readonly id: number;
  readonly name: string;
  readonly meta: unknown;

  // send side
  private sendSeq = 0;
  private sentBytes = 0;
  private peerConsumedBytes = 0;
  private retained: SendFrame[] = [];
  private transmitCursor = 0;
  private localEnded = false;
  private localEndAcked = false;
  private sendWaiters: { reject: (err: Error) => void }[] = [];

  // receive side
  private recvSeq = 0;
  private inbox: { seq: number; data: Buffer | null }[] = [];
  private inboxBytes = 0;
  private consumedBytes = 0;
  private consumedSeq = 0;
  private reportedBytes = 0;
  private remoteEnded = false;
  private readWaiter: (() => void) | null = null;

  private failure: Error | null = null;
  private readonly host: ChannelHost;
  private readonly window: number;

  constructor(host: ChannelHost, id: number, name: string, meta: unknown, window: number) {
    this.host = host;
    this.id = id;
    this.name = name;
    this.meta = meta;
    this.window = window;
  }

  // ---- state the session reads ------------------------------------------

  /** Highest sequence number received, reported in `resume`. */
  get lastReceivedSeq(): number {
    return this.recvSeq;
  }

  /** Bytes written to the peer and not yet consumed by it. Never exceeds the window. */
  get bytesInFlight(): number {
    return this.sentBytes - this.peerConsumedBytes;
  }

  /** Bytes queued by `send()` that credit has not let out yet. */
  get bytesBlocked(): number {
    let n = 0;
    for (const f of this.retained) if (!f.counted) n += f.frame.payload.length;
    return n;
  }

  get failed(): boolean {
    return this.failure !== null;
  }

  get closed(): boolean {
    return (
      this.failure !== null || (this.localEndAcked && this.remoteEnded && this.inbox.length === 0)
    );
  }

  // ---- sending -----------------------------------------------------------

  /**
   * Queues `data`, split into chunks. The promise resolves when every chunk has
   * been written once, which needs credit, so a slow reader stalls the caller.
   */
  send(data: Uint8Array): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.localEnded) return Promise.reject(new Error(`channel ${this.id} already ended`));
    // Copy: frames stay queued for replay after send() resolves, and the caller may reuse its buffer.
    const buf = Buffer.from(data);
    if (buf.length === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.sendWaiters.push({ reject });
      for (let off = 0; off < buf.length; off += MAX_CHUNK_BYTES) {
        const payload = buf.subarray(off, Math.min(off + MAX_CHUNK_BYTES, buf.length));
        const last = off + MAX_CHUNK_BYTES >= buf.length;
        this.retained.push({
          frame: { chan: this.id, seq: ++this.sendSeq, kind: "data", payload },
          counted: false,
          done: last ? { resolve } : undefined,
        });
      }
      this.flush();
    });
  }

  /** Sends the end marker. The reader on the other side sees the iteration finish. */
  end(): void {
    if (this.failure || this.localEnded) return;
    this.localEnded = true;
    this.retained.push({
      frame: { chan: this.id, seq: ++this.sendSeq, kind: "end", payload: Buffer.alloc(0) },
      counted: false,
    });
    this.flush();
  }

  /** Aborts both directions. The peer's reader and pending `send()` calls fail. */
  reset(reason = "reset"): void {
    if (this.failure) return;
    this.host.writeBinary(
      encodeFrame({ chan: this.id, seq: 0, kind: "reset", payload: Buffer.from(reason) }),
    );
    this.fail(new Error(`channel ${this.id} reset: ${reason}`));
  }

  // ---- session hooks -----------------------------------------------------

  /** After a (re)attach: restart transmission from the first frame the peer lacks. */
  resumeSend(peerLastSeq: number): void {
    // The peer keeps what it received across the reconnect, so only frames after
    // peerLastSeq go out again. Frames it holds unconsumed need no retention here.
    this.retained = this.retained.filter((f) => f.frame.seq > peerLastSeq);
    this.transmitCursor = 0;
    this.flush();
    this.sendCredit(true);
  }

  /** What the session keeps after the channel finishes, so a lost final credit can be repeated. */
  tombstone(): { seq: number; bytes: number } {
    return { seq: this.recvSeq, bytes: this.consumedBytes };
  }

  handleFrame(frame: Frame): void {
    if (this.failure) return;
    switch (frame.kind) {
      case "data":
      case "end": {
        if (frame.seq <= this.recvSeq) return; // replayed duplicate
        if (frame.seq !== this.recvSeq + 1) {
          this.fail(
            new Error(
              `channel ${this.id}: sequence gap, expected ${this.recvSeq + 1} got ${frame.seq}`,
            ),
          );
          return;
        }
        if (
          frame.payload.length > MAX_CHUNK_BYTES ||
          this.inboxBytes + frame.payload.length > this.window + MAX_CHUNK_BYTES
        ) {
          // The sender ignored the credit window. Buffering on would let a peer exhaust memory.
          this.reset("credit window exceeded");
          return;
        }
        this.recvSeq = frame.seq;
        this.inboxBytes += frame.payload.length;
        if (frame.kind === "end") {
          this.remoteEnded = true;
          this.inbox.push({ seq: frame.seq, data: null });
        } else {
          this.inbox.push({ seq: frame.seq, data: frame.payload });
        }
        this.wakeReader();
        return;
      }
      case "credit": {
        const bytes = decodeCreditBytes(frame.payload);
        if (bytes > this.peerConsumedBytes) this.peerConsumedBytes = bytes;
        // frame.seq is the highest sequence the peer has consumed: drop what replay no longer needs.
        let drop = 0;
        while (
          drop < this.retained.length &&
          this.retained[drop].frame.seq <= frame.seq &&
          this.retained[drop].counted
        ) {
          drop++;
        }
        if (drop > 0) {
          this.retained.splice(0, drop);
          this.transmitCursor = Math.max(0, this.transmitCursor - drop);
        }
        if (this.localEnded && frame.seq >= this.sendSeq) this.localEndAcked = true;
        this.flush();
        this.maybeDone();
        return;
      }
      case "reset":
        this.fail(new Error(`channel ${this.id} reset by peer: ${frame.payload.toString()}`));
        return;
    }
  }

  /** The session is gone for good (expired, or the peer lost its state). */
  fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    for (const w of this.sendWaiters) w.reject(err);
    this.sendWaiters = [];
    this.retained = [];
    this.wakeReader();
    this.host.channelDone(this.id);
  }

  // ---- reading -----------------------------------------------------------

  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    return {
      next: async () => {
        for (;;) {
          const item = this.inbox.shift();
          if (item) {
            if (item.data === null) {
              this.consumedSeq = item.seq;
              this.sendCredit(true);
              this.maybeDone();
              return { value: undefined, done: true };
            }
            this.inboxBytes -= item.data.length;
            this.consumedBytes += item.data.length;
            this.consumedSeq = item.seq;
            this.sendCredit(false);
            return { value: item.data, done: false };
          }
          if (this.failure) throw this.failure;
          await new Promise<void>((resolve) => {
            this.readWaiter = resolve;
          });
        }
      },
    };
  }

  /** Reads until the peer ends the channel and returns everything as one buffer. */
  async readAll(): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const chunk of this) parts.push(chunk);
    return Buffer.concat(parts);
  }

  // ---- internals ---------------------------------------------------------

  private flush(): void {
    while (this.transmitCursor < this.retained.length) {
      const entry = this.retained[this.transmitCursor];
      const len = entry.frame.payload.length;
      if (
        !entry.counted &&
        entry.frame.kind === "data" &&
        this.sentBytes + len - this.peerConsumedBytes > this.window
      ) {
        return; // out of credit
      }
      if (!this.host.writeBinary(encodeFrame(entry.frame))) return; // detached; resumeSend restarts it
      if (!entry.counted) {
        entry.counted = true;
        this.sentBytes += len;
      }
      this.transmitCursor++;
      const done = entry.done;
      if (done) {
        // Settle once. A replay writes this entry again and must not shift another call's waiter.
        entry.done = undefined;
        done.resolve();
        this.sendWaiters.shift();
      }
    }
  }

  private sendCredit(force: boolean): void {
    const unreported = this.consumedBytes - this.reportedBytes;
    if (!force && unreported < this.window / 4 && this.inbox.length > 0) return;
    if (this.host.writeBinary(encodeCredit(this.id, this.consumedSeq, this.consumedBytes))) {
      this.reportedBytes = this.consumedBytes;
    }
  }

  private wakeReader(): void {
    const w = this.readWaiter;
    this.readWaiter = null;
    w?.();
  }

  private maybeDone(): void {
    if (this.localEndAcked && this.remoteEnded && this.inbox.length === 0)
      this.host.channelDone(this.id);
  }
}
