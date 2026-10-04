import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { Channel, type ChannelHost } from "./channel.ts";
import {
  DEFAULT_CHANNEL_WINDOW,
  decodeFrame,
  encodeCredit,
  encodeFrame,
  HEARTBEAT_MISSES,
  LinkClosedError,
  METHOD_CANCEL,
  METHOD_HEARTBEAT,
  METHOD_OPEN,
  RPC_CANCELLED,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RpcError,
  type RpcNotification,
  type RpcRequest,
  type RpcResponse,
  RpcTimeoutError,
} from "./protocol.ts";

const MAX_CHANNELS = 1024;

export type RpcHandler = (
  params: unknown,
  ctx: { signal: AbortSignal },
) => unknown | Promise<unknown>;
export type NotificationHandler = (params: unknown) => void;

export interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SessionOptions {
  role: "client" | "server";
  window?: number;
  /** Default timeout for `request`. 0 disables it. */
  requestTimeoutMs?: number;
  heartbeatMisses?: number;
}

export interface AttachOptions {
  heartbeatMs: number;
  /** Highest sequence the peer reports having received, per channel. */
  peerResume: Record<string, number> | undefined;
  /** False when the peer lost its state, so every channel is gone. */
  resumed: boolean;
  /** True on the server, which pings at the WebSocket level too. */
  wsPing: boolean;
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
  cleanup?: () => void;
}

/**
 * Everything that outlives one socket: channels, handlers and the heartbeat
 * policy. The server keeps one per worker and reattaches it on reconnect. The
 * client owns exactly one.
 *
 * Events: `channel` (a peer-opened channel), `attached`, `detached`, `lost`.
 */
export class LinkSession extends EventEmitter implements ChannelHost {
  private readonly role: "client" | "server";
  private readonly window: number;
  private readonly requestTimeoutMs: number;
  private readonly misses: number;

  private ws: WebSocket | null = null;
  private lastRecv = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  private readonly handlers = new Map<string, RpcHandler>();
  private readonly notifyHandlers = new Map<string, NotificationHandler>();
  private readonly pending = new Map<number | string, Pending>();
  private readonly inbound = new Map<number | string, AbortController>();
  private nextRpcId = 1;

  private readonly channels = new Map<number, Channel>();
  private readonly tombstones = new Map<number, { seq: number; bytes: number }>();
  private nextChan: number;

  constructor(opts: SessionOptions) {
    super();
    this.role = opts.role;
    this.window = opts.window ?? DEFAULT_CHANNEL_WINDOW;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.misses = opts.heartbeatMisses ?? HEARTBEAT_MISSES;
    this.nextChan = opts.role === "client" ? 1 : 2;
  }

  get attached(): boolean {
    return this.ws !== null && this.ws.readyState === 1;
  }

  // ---- RPC ---------------------------------------------------------------

  /** Registers the handler for requests with this method. */
  handle(method: string, fn: RpcHandler): void {
    this.handlers.set(method, fn);
  }

  /** Registers the handler for notifications with this method. */
  onNotification(method: string, fn: NotificationHandler): void {
    this.notifyHandlers.set(method, fn);
  }

  request<T = unknown>(method: string, params?: unknown, opts: CallOptions = {}): Promise<T> {
    if (!this.attached) return Promise.reject(new LinkClosedError());
    const id = this.nextRpcId++;
    const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { method, resolve: resolve as (v: unknown) => void, reject };
      const settle = (fn: () => void) => {
        if (!this.pending.delete(id)) return;
        if (entry.timer) clearTimeout(entry.timer);
        entry.cleanup?.();
        fn();
      };
      entry.resolve = (v) => settle(() => resolve(v as T));
      entry.reject = (e) => settle(() => reject(e));
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.notify(METHOD_CANCEL, { id });
          entry.reject(new RpcTimeoutError(method, timeoutMs));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      if (opts.signal) {
        const signal = opts.signal;
        const onAbort = () => {
          this.notify(METHOD_CANCEL, { id });
          entry.reject(new RpcError(RPC_CANCELLED, `RPC ${method} cancelled`));
        };
        if (signal.aborted) {
          entry.reject(new RpcError(RPC_CANCELLED, `RPC ${method} cancelled`));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        entry.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      const msg: RpcRequest = { jsonrpc: "2.0", id, method, params };
      this.sendText(msg);
    });
  }

  notify(method: string, params?: unknown): void {
    const msg: RpcNotification = { jsonrpc: "2.0", method, params };
    this.sendText(msg);
  }

  // ---- channels ----------------------------------------------------------

  openChannel(name: string, meta?: unknown): Channel {
    const id = this.nextChan;
    this.nextChan += 2;
    const ch = new Channel(this, id, name, meta, this.window);
    this.channels.set(id, ch);
    this.notify(METHOD_OPEN, { chan: id, name, meta });
    return ch;
  }

  getChannel(id: number): Channel | undefined {
    return this.channels.get(id);
  }

  /** Highest received sequence per channel, for `hello.resume` and `ready.resume`. */
  resumeMap(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, ch] of this.channels) out[id] = ch.lastReceivedSeq;
    for (const [id, t] of this.tombstones) out[id] = t.seq;
    return out;
  }

  // ---- ChannelHost -------------------------------------------------------

  writeBinary(buf: Buffer): boolean {
    if (!this.attached) return false;
    this.ws?.send(buf, { binary: true });
    return true;
  }

  channelDone(chan: number): void {
    const ch = this.channels.get(chan);
    if (!ch) return;
    this.channels.delete(chan);
    // A finished channel leaves a tombstone unless it failed, so a lost final credit can be repeated.
    if (ch.closed && !ch.failed) this.tombstones.set(chan, ch.tombstone());
  }

  // ---- socket lifecycle --------------------------------------------------

  attach(ws: WebSocket, opts: AttachOptions): void {
    this.detachSocket();
    this.ws = ws;
    this.lastRecv = Date.now();
    ws.on("message", (data, isBinary) => {
      if (this.ws === ws) this.onMessage(data as Buffer, isBinary);
    });
    ws.on("close", () => {
      if (this.ws === ws) this.detach();
    });
    ws.on("error", () => {
      // the close event follows
    });

    if (!opts.resumed) {
      for (const ch of [...this.channels.values()])
        ch.fail(new Error("peer lost the link session"));
      this.tombstones.clear();
    }
    this.reconcile(opts.peerResume ?? {});

    const interval = Math.max(1, opts.heartbeatMs);
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastRecv > this.misses * interval) {
        this.emit("lost");
        ws.terminate();
        return;
      }
      this.notify(METHOD_HEARTBEAT);
      if (opts.wsPing && ws.readyState === 1) ws.ping();
    }, interval);
    this.heartbeatTimer.unref();
    this.emit("attached");
  }

  /** Called when the socket closes. Channels and handlers stay for the next attach. */
  detach(): void {
    if (!this.ws) return;
    this.detachSocket();
    this.emit("detached");
  }

  /** Closes the socket without a close handshake. The peer sees an abrupt drop. */
  dropConnection(): void {
    this.ws?.terminate();
  }

  /** Ends the session for good: pending calls and channels fail. */
  destroy(reason = "session closed"): void {
    this.detachSocket();
    for (const ch of [...this.channels.values()]) ch.fail(new Error(reason));
    this.tombstones.clear();
    this.emit("destroyed");
  }

  private detachSocket(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= 1) ws.terminate();
    const err = new LinkClosedError("link dropped");
    for (const p of [...this.pending.values()]) p.reject(err);
    for (const c of this.inbound.values()) c.abort();
    this.inbound.clear();
  }

  /** After attach, bring both sides' channel tables back in line using the peer's resume map. */
  private reconcile(peer: Record<string, number>): void {
    const ours = this.role === "client" ? 1 : 0;
    for (const [id, ch] of [...this.channels]) {
      const seen = peer[id];
      if (seen !== undefined) {
        ch.resumeSend(seen);
      } else if (id % 2 === ours) {
        // The peer never learned of this channel, or lost its open: announce and send everything.
        this.notify(METHOD_OPEN, { chan: id, name: ch.name, meta: ch.meta });
        ch.resumeSend(0);
      } else {
        ch.fail(new Error(`peer no longer has channel ${id}`));
      }
    }
    for (const [idStr] of Object.entries(peer)) {
      const id = Number(idStr);
      if (!Number.isInteger(id) || id <= 0 || id > 0xffffffff) continue;
      if (this.channels.has(id)) continue;
      const tomb = this.tombstones.get(id);
      if (tomb) {
        this.writeBinary(encodeCredit(id, tomb.seq, tomb.bytes));
      } else if (id % 2 === ours) {
        // A channel we opened and no longer have. An id the peer owns may be one it opened
        // while detached, and its link.open follows, so that one is not reset.
        this.writeBinary(
          encodeFrame({ chan: id, seq: 0, kind: "reset", payload: Buffer.from("unknown channel") }),
        );
      }
    }
    for (const id of [...this.tombstones.keys()]) {
      if (peer[id] === undefined) this.tombstones.delete(id);
    }
  }

  // ---- inbound -----------------------------------------------------------

  private onMessage(data: Buffer, isBinary: boolean): void {
    this.lastRecv = Date.now();
    if (isBinary) {
      let frame: ReturnType<typeof decodeFrame>;
      try {
        frame = decodeFrame(Buffer.isBuffer(data) ? data : Buffer.from(data));
      } catch {
        this.ws?.terminate();
        return;
      }
      try {
        this.channels.get(frame.chan)?.handleFrame(frame);
      } catch {
        this.ws?.terminate();
      }
      return;
    }
    let msg: RpcRequest | RpcNotification | RpcResponse;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      this.ws?.terminate();
      return;
    }
    if (msg === null || typeof msg !== "object") {
      this.ws?.terminate();
      return;
    }
    try {
      this.dispatchText(msg);
    } catch {
      this.ws?.terminate();
    }
  }

  private dispatchText(msg: RpcRequest | RpcNotification | RpcResponse): void {
    if (typeof (msg as RpcRequest).method === "string") {
      if ("id" in msg && msg.id !== undefined && msg.id !== null)
        void this.onRequest(msg as RpcRequest);
      else this.handleNotification(msg as RpcNotification);
    } else if ("id" in msg) {
      this.onResponse(msg as RpcResponse);
    }
  }

  private handleNotification(msg: RpcNotification): void {
    switch (msg.method) {
      case METHOD_HEARTBEAT:
        return;
      case METHOD_CANCEL: {
        const id = (msg.params as { id?: number | string } | undefined)?.id;
        if (id !== undefined) this.inbound.get(id)?.abort();
        return;
      }
      case METHOD_OPEN: {
        const p = msg.params as { chan: number; name: string; meta?: unknown } | null | undefined;
        if (
          !p ||
          !Number.isInteger(p.chan) ||
          p.chan <= 0 ||
          p.chan > 0xffffffff ||
          p.chan % 2 === (this.role === "client" ? 1 : 0) ||
          typeof p.name !== "string"
        ) {
          throw new Error("malformed link.open");
        }
        if (this.channels.has(p.chan) || this.tombstones.has(p.chan)) return;
        if (this.channels.size >= MAX_CHANNELS) throw new Error("too many channels");
        const ch = new Channel(this, p.chan, p.name, p.meta, this.window);
        this.channels.set(p.chan, ch);
        this.emit("channel", ch);
        return;
      }
    }
    this.notifyHandlers.get(msg.method)?.(msg.params);
  }

  private async onRequest(msg: RpcRequest): Promise<void> {
    const handler = this.handlers.get(msg.method);
    if (!handler) {
      this.reply({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: RPC_METHOD_NOT_FOUND, message: `no handler for ${msg.method}` },
      });
      return;
    }
    const ac = new AbortController();
    this.inbound.set(msg.id, ac);
    try {
      const result = await handler(msg.params, { signal: ac.signal });
      this.reply({ jsonrpc: "2.0", id: msg.id, result: result === undefined ? null : result });
    } catch (err) {
      if (err instanceof RpcError) {
        this.reply({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: err.code, message: err.message, data: err.data },
        });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.reply({ jsonrpc: "2.0", id: msg.id, error: { code: RPC_INTERNAL_ERROR, message } });
      }
    } finally {
      this.inbound.delete(msg.id);
    }
  }

  private onResponse(msg: RpcResponse): void {
    if (msg.id === null) return;
    const p = this.pending.get(msg.id);
    if (!p) return; // late answer to a call that timed out or was cancelled
    if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
    else if ("result" in msg) p.resolve(msg.result);
    else p.reject(new RpcError(RPC_INVALID_REQUEST, "response has neither result nor error"));
  }

  private reply(msg: RpcResponse): void {
    this.sendText(msg);
  }

  private sendText(msg: unknown): void {
    if (!this.attached) return;
    this.ws?.send(JSON.stringify(msg));
  }
}
