/**
 * A tap on the JSON-RPC lines between a chat's client and its agent.
 *
 * It does what the SDK's `ndJsonStream` does for the agent's stdout (one JSON message per line)
 * and, on the way, keeps what a rebuilt client would need to carry on: the byte offset after the
 * last complete line it handed to the SDK, the next request id the client uses, and the ids of the
 * requests open in each direction. The SDK's own internals stay untouched; this sits on both of its
 * streams.
 *
 * Durability is the caller's: the tap calls `begin` when the first line of a batch is delivered
 * and `commit` once the SDK has handled the batch (every handler of these lines runs in
 * microtasks, so a `setImmediate` after the delivery comes after them). The caller opens a
 * transaction in `begin` and, in `commit`, stores the snapshot with the events the batch logged,
 * commits, and calls {@link WireTap.acknowledge}. Only then may the agent daemon drop the bytes.
 */

import type * as acp from "@agentclientprotocol/sdk";

export type JsonRpcId = number | string;

export interface OpenRequest {
  id: JsonRpcId;
  method: string;
  /** For a client request: the stdin offset after the request's bytes. A rebuilt client compares it with what the daemon wrote. */
  stdinEnd?: number;
}

/** What the tap knows at a commit point. */
export interface WireSnapshot {
  /** Bytes of the agent's stdout up to the end of the last line handed to the SDK. */
  stdoutOffset: number;
  /** The id the client's next request takes. */
  nextRequestId: number;
  /** Bytes the client has written to the agent's stdin, counting the message being written. */
  stdinOffset: number;
  /** Requests the client sent and the agent has not answered (`session/prompt` among them). */
  openClientRequests: OpenRequest[];
  /**
   * Requests the agent sent and the client has not answered (permission, form). `requestId` is the
   * id Band logged the request under, once the client claimed it.
   */
  openAgentRequests: Array<OpenRequest & { requestId?: string; optionIds?: string[] }>;
}

export interface WireHooks {
  /** A batch starts: its first line is about to reach the SDK. */
  begin(): void;
  /** The tap's state changed outside a batch (the client sent a request or an answer): store it. */
  changed?(): void;
  /** The SDK handled the batch. Store `snapshot` with its events, commit, then call `tap.acknowledge()`. */
  commit(snapshot: WireSnapshot): void;
}

/** Where the bytes come from, and how to tell the agent daemon what may be dropped. */
export interface WireSource {
  stdout: AsyncIterable<Uint8Array>;
  /** Releases agent output up to these offsets. Absent when nothing holds it for us. */
  ack?(offsets: { stdout: number; stderr: number }): void;
  /** Bytes of stderr read so far. */
  stderrOffset?(): number;
}

/** What a rebuilt client carries over from the one that stopped. */
export interface WireRestore {
  openClientRequests: OpenRequest[];
  openAgentRequests: Array<OpenRequest & { requestId?: string }>;
  /** Bytes the agent daemon has written to the agent's stdin. */
  stdinBase: number;
  /**
   * The id of the `session/prompt` the former client left open. The tap holds the agent's output
   * until the rebuilt client has re-issued that request ({@link WireTap.adopted}); the agent's reply
   * to the old id then resolves the new request.
   */
  adoptPromptId?: JsonRpcId;
}

const NEWLINE = 0x0a;

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "number" || typeof value === "string";
}

export class WireTap {
  private delivered: number;
  private committed: number;
  private nextId = 1;
  private readonly openClient = new Map<JsonRpcId, { method: string; stdinEnd: number | null }>();
  private readonly openAgent = new Map<JsonRpcId, { method: string; requestId?: string }>();
  private scheduled = false;
  private source: WireSource | null = null;
  /**
   * Request ids of a rebuilt client sit above every id a former client used: the client's own ids
   * (from 0) are shifted by this on their way out and back on their way in.
   */
  private readonly idBase: number;
  private stdin: number;
  private sender: ((message: acp.AnyMessage) => Promise<void>) | null = null;
  private adopt: { storedId: JsonRpcId; sdkId: JsonRpcId | null } | null = null;
  private resolveAdopted!: () => void;
  /** Resolves once the rebuilt client has re-issued the open prompt (see {@link WireRestore}). */
  readonly adopted: Promise<void>;
  private held: Promise<void> | null = null;
  private resolveHeld: (() => void) | null = null;

  /**
   * @param stdoutBase The offset of the first byte of the stream this tap reads. Zero for a new
   *   agent; the stored offset when a rebuilt client reattaches.
   * @param nextRequestId The id after the last one a former client used, when there was one.
   */
  constructor(
    private readonly hooks: WireHooks,
    stdoutBase = 0,
    nextRequestId = 1,
    private readonly onBadLine: (line: string, err: unknown) => void = () => undefined,
    restore?: WireRestore,
  ) {
    this.delivered = stdoutBase;
    this.committed = stdoutBase;
    this.nextId = nextRequestId;
    this.idBase = restore ? nextRequestId : 0;
    this.stdin = restore?.stdinBase ?? 0;
    this.adopted = new Promise((resolve) => {
      this.resolveAdopted = resolve;
    });
    if (restore) {
      // Only the prompt is carried over: the rebuilt client waits for nothing else.
      for (const r of restore.openClientRequests) {
        if (r.id !== restore.adoptPromptId) continue;
        this.openClient.set(r.id, { method: r.method, stdinEnd: r.stdinEnd ?? null });
      }
      for (const r of restore.openAgentRequests) {
        this.openAgent.set(r.id, { method: r.method, requestId: r.requestId });
      }
      if (restore.adoptPromptId !== undefined) {
        this.adopt = { storedId: restore.adoptPromptId, sdkId: null };
      } else {
        this.resolveAdopted();
      }
      // Nothing reaches the client until it is ready for the replay.
      this.held = new Promise((resolve) => {
        this.resolveHeld = resolve;
      });
    } else {
      this.resolveAdopted();
    }
  }

  /** Lets the agent's output through. A rebuilt client calls it once it can take the replay. */
  release(): void {
    this.resolveHeld?.();
    this.resolveHeld = null;
  }

  /** How the tap writes a message to the agent on its own (an answer to a request from before the restart). */
  setSender(send: (message: acp.AnyMessage) => Promise<void>): void {
    this.sender = send;
  }

  /** Answers an agent request the former client left open, with the agent's own id. */
  async respond(id: JsonRpcId, result: unknown): Promise<void> {
    if (!this.sender || !this.openAgent.has(id)) return;
    const message = { jsonrpc: "2.0", id, result } as acp.AnyMessage;
    this.openAgent.delete(id);
    this.stdin += Buffer.byteLength(`${JSON.stringify(message)}\n`);
    this.hooks.changed?.();
    await this.sender(message);
  }

  snapshot(): WireSnapshot {
    return {
      stdoutOffset: this.delivered,
      nextRequestId: this.nextId,
      stdinOffset: this.stdin,
      openClientRequests: [...this.openClient].map(([id, r]) => ({
        id,
        method: r.method,
        ...(r.stdinEnd === null ? {} : { stdinEnd: r.stdinEnd }),
      })),
      openAgentRequests: [...this.openAgent].map(([id, r]) => ({ id, ...r })),
    };
  }

  /** Bytes of stderr read so far. */
  stderrOffset(): number {
    return this.source?.stderrOffset?.() ?? 0;
  }

  /** Releases the agent output the last commit covers. A failure is the daemon's to retry on the next ack. */
  acknowledge(): void {
    this.committed = this.delivered;
    this.source?.ack?.({ stdout: this.committed, stderr: this.stderrOffset() });
  }

  /** Messages the SDK reads: one per complete line of `source.stdout`, in order. */
  inbound(source: WireSource): ReadableStream<acp.AnyMessage> {
    this.source = source;
    const iterator = source.stdout[Symbol.asyncIterator]();
    let rest: Buffer = Buffer.alloc(0);
    return new ReadableStream<acp.AnyMessage>({
      pull: async (controller) => {
        await this.held;
        // Reads until a line is ready, so a pull never ends with nothing queued.
        for (;;) {
          let next: IteratorResult<Uint8Array>;
          try {
            next = await iterator.next();
          } catch (err) {
            controller.error(err);
            return;
          }
          if (next.done) {
            controller.close();
            return;
          }
          rest = rest.length === 0 ? Buffer.from(next.value) : Buffer.concat([rest, next.value]);
          let delivered = false;
          for (;;) {
            const end = rest.indexOf(NEWLINE);
            if (end < 0) break;
            const line = rest.subarray(0, end);
            rest = rest.subarray(end + 1);
            if (this.deliver(controller, line, end + 1)) delivered = true;
          }
          if (delivered) return;
        }
      },
      cancel: async () => {
        await iterator.return?.();
      },
    });
  }

  /**
   * The client opened its handler for the oldest request of `method` that nobody claimed yet (the
   * SDK calls handlers in the order the lines arrived), and logged it as `requestId`.
   */
  claimAgentRequest(method: string, requestId: string): void {
    for (const open of this.openAgent.values()) {
      if (open.method === method && open.requestId === undefined) {
        open.requestId = requestId;
        return;
      }
    }
  }

  /**
   * Observes what the SDK writes to the agent. Returns the message to write, with a rebuilt client's
   * request ids shifted above the former client's, or null for the one request the tap keeps back
   * (the re-issued prompt, whose reply the agent owes to the old id).
   */
  outbound(message: acp.AnyMessage): acp.AnyMessage | null {
    const m = message as { id?: unknown; method?: unknown };
    if (!isId(m.id)) {
      this.stdin += Buffer.byteLength(`${JSON.stringify(message)}\n`);
      return message;
    }
    if (typeof m.method !== "string") {
      // The client answers a request the agent sent.
      this.openAgent.delete(m.id);
      this.stdin += Buffer.byteLength(`${JSON.stringify(message)}\n`);
      this.hooks.changed?.();
      return message;
    }
    if (this.adopt && this.adopt.sdkId === null && m.method === "session/prompt") {
      this.adopt.sdkId = m.id;
      this.resolveAdopted();
      return null;
    }
    const out =
      typeof m.id === "number" && this.idBase > 0
        ? ({ ...(message as object), id: m.id + this.idBase } as acp.AnyMessage)
        : message;
    const id = (out as { id: JsonRpcId }).id;
    if (typeof id === "number" && id >= this.nextId) this.nextId = id + 1;
    this.stdin += Buffer.byteLength(`${JSON.stringify(out)}\n`);
    this.openClient.set(id, { method: m.method, stdinEnd: this.stdin });
    this.hooks.changed?.();
    return out;
  }

  /** Hands one line to the SDK. Returns whether a message was queued. */
  private deliver(
    controller: ReadableStreamDefaultController<acp.AnyMessage>,
    line: Buffer,
    bytes: number,
  ): boolean {
    const text = line.toString("utf8").trim();
    let message: acp.AnyMessage | null = null;
    if (text) {
      try {
        message = JSON.parse(text) as acp.AnyMessage;
      } catch (err) {
        this.onBadLine(text.slice(0, 200), err);
      }
    }
    if (!message) {
      // Nothing for the SDK to handle: the offset moves with the next batch.
      this.delivered += bytes;
      this.schedule();
      return false;
    }
    const routed = this.observe(message);
    if (!routed) {
      // A reply to a request from before the restart that nobody waits for.
      this.delivered += bytes;
      this.schedule();
      return false;
    }
    this.begin();
    this.delivered += bytes;
    controller.enqueue(routed);
    this.schedule();
    return true;
  }

  /** Notes the message and returns what the SDK should see, or null when nobody waits for it. */
  private observe(message: acp.AnyMessage): acp.AnyMessage | null {
    const m = message as { id?: unknown; method?: unknown };
    if (!isId(m.id)) return message;
    if (typeof m.method === "string") {
      this.openAgent.set(m.id, { method: m.method });
      return message;
    }
    // A reply to a request of the client.
    if (this.adopt && m.id === this.adopt.storedId && this.adopt.sdkId !== null) {
      this.openClient.delete(m.id);
      const sdkId = this.adopt.sdkId;
      this.adopt = null;
      return { ...(message as object), id: sdkId } as acp.AnyMessage;
    }
    if (this.idBase > 0 && typeof m.id === "number") {
      if (m.id < this.idBase) {
        this.openClient.delete(m.id);
        return null;
      }
      this.openClient.delete(m.id);
      return { ...(message as object), id: m.id - this.idBase } as acp.AnyMessage;
    }
    this.openClient.delete(m.id);
    return message;
  }

  private batchOpen = false;

  private begin(): void {
    if (this.batchOpen) return;
    this.batchOpen = true;
    this.hooks.begin();
  }

  private schedule(): void {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.closed) return;
      try {
        // A batch of only blank lines still moves the offset, and needs no transaction of its own.
        this.begin();
        this.batchOpen = false;
        this.hooks.commit(this.snapshot());
      } catch {
        // The store went away. The hooks log their own failures.
      }
    });
  }

  private closed = false;

  /** Commits the batch that is open, now, and stops the tap. For a client that is being dropped. */
  dispose(): void {
    if (this.closed) return;
    if (this.batchOpen) {
      this.batchOpen = false;
      this.hooks.commit(this.snapshot());
    }
    this.closed = true;
  }
}
