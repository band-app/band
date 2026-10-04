import { EventEmitter } from "node:events";
import { type ClientOptions, WebSocket } from "ws";
import {
  DEFAULT_CHANNEL_WINDOW,
  type HandshakeReply,
  type Hello,
  type HelloInfo,
  LinkClosedError,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  type Ready,
} from "./protocol.ts";
import { LinkSession } from "./session.ts";

export interface LinkClientOptions {
  url: string;
  token: string;
  hello: HelloInfo;
  wsOptions?: ClientOptions;
  /** Backoff between dial attempts. Defaults 250 ms doubling up to 15 s, with up to 25% jitter. */
  reconnect?: { minMs?: number; maxMs?: number } | false;
  handshakeTimeoutMs?: number;
  /** Present the `sessionToken` from the last `ready` instead of `token` on later dials. */
  useSessionToken?: boolean;
  window?: number;
  requestTimeoutMs?: number;
  heartbeatMisses?: number;
}

/**
 * Dials the hub and keeps the link up. `session` is stable across reconnects:
 * handlers, channels and queued sends survive a dropped socket.
 *
 * Events: `connected` (ready, resumed), `disconnected`, `lost` (missed
 * heartbeats), `rejected` (reason, terminal), `mismatch` (need, terminal).
 */
export class LinkClient extends EventEmitter {
  readonly session: LinkSession;
  private readonly opts: LinkClientOptions;
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private currentToken: string;
  private firstReady: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(opts: LinkClientOptions) {
    super();
    this.opts = opts;
    this.currentToken = opts.token;
    this.session = new LinkSession({
      role: "client",
      window: opts.window ?? DEFAULT_CHANNEL_WINDOW,
      requestTimeoutMs: opts.requestTimeoutMs,
      heartbeatMisses: opts.heartbeatMisses,
    });
    this.session.on("detached", () => {
      this.emit("disconnected");
      this.scheduleRedial();
    });
    this.session.on("lost", () => this.emit("lost"));
  }

  /**
   * Resolves on the first `ready`. Rejects on `rejected` or `mismatch`. Later
   * drops reconnect on their own. A repeated or concurrent call returns the
   * same promise while the first is pending, and resolves at once when the
   * link is up.
   */
  connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.session.attached) return Promise.resolve();
    const attempt = new Promise<void>((resolve, reject) => {
      this.firstReady = { resolve, reject };
      this.stopped = false;
      this.dial();
    });
    this.connecting = attempt;
    const clear = () => {
      if (this.connecting === attempt) this.connecting = null;
    };
    attempt.then(clear, clear);
    return attempt;
  }

  private connecting: Promise<void> | null = null;
  /** The `sessionToken` of the last `ready`, sent on later hellos as proof of ownership. */
  private lastSessionToken: string | undefined;

  async close(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.session.destroy("client closed");
    this.firstReady?.reject(new LinkClosedError("client closed"));
    this.firstReady = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) ws.terminate();
  }

  private dial(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.opts.url, {
      maxPayload: MAX_MESSAGE_BYTES,
      ...this.opts.wsOptions,
    });
    this.ws = ws;
    let handshaken = false;
    const timeout = setTimeout(() => ws.terminate(), this.opts.handshakeTimeoutMs ?? 10_000);

    const failDial = () => {
      clearTimeout(timeout);
      if (handshaken || this.ws !== ws) return;
      this.ws = null;
      this.scheduleRedial();
    };
    ws.on("error", () => {});
    ws.on("close", failDial);

    ws.once("open", () => {
      const hello: Hello = {
        type: "hello",
        protocol: PROTOCOL_VERSION,
        token: this.currentToken,
        sessionToken: this.lastSessionToken,
        ...this.opts.hello,
        resume: this.sessionStarted ? this.session.resumeMap() : undefined,
      };
      ws.send(JSON.stringify(hello));
    });

    ws.once("message", (data, isBinary) => {
      clearTimeout(timeout);
      if (isBinary) {
        ws.terminate();
        return;
      }
      let reply: HandshakeReply;
      try {
        reply = JSON.parse(data.toString()) as HandshakeReply;
      } catch {
        ws.terminate();
        return;
      }
      if (reply.type === "ready") {
        handshaken = true;
        this.onReady(ws, reply);
      } else {
        // Terminal: retrying the same hello would get the same answer.
        this.stopped = true;
        const err =
          reply.type === "mismatch"
            ? new Error(`protocol mismatch: hub needs ${reply.need}`)
            : new Error(`rejected: ${reply.reason}`);
        if (reply.type === "mismatch") this.emit("mismatch", reply.need);
        else this.emit("rejected", reply.reason);
        this.firstReady?.reject(err);
        this.firstReady = null;
        ws.terminate();
      }
    });
  }

  /** Set after the first successful handshake, so a later hello carries `resume`. */
  private sessionStarted = false;

  private onReady(ws: WebSocket, ready: Ready): void {
    this.attempt = 0;
    if (this.opts.useSessionToken) this.currentToken = ready.sessionToken;
    this.sessionStarted = true;
    this.lastSessionToken = ready.sessionToken;
    this.session.attach(ws, {
      heartbeatMs: ready.heartbeatMs,
      peerResume: ready.resume,
      resumed: ready.resumed,
      wsPing: false,
    });
    this.emit("connected", ready, ready.resumed);
    this.firstReady?.resolve();
    this.firstReady = null;
  }

  private scheduleRedial(): void {
    if (this.stopped || this.opts.reconnect === false || this.retryTimer) return;
    const { minMs = 250, maxMs = 15_000 } = this.opts.reconnect ?? {};
    const base = Math.min(maxMs, minMs * 2 ** this.attempt);
    this.attempt++;
    const delay = base + Math.random() * base * 0.25;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.dial();
    }, delay);
  }
}
