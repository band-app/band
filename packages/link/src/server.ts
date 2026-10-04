import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import {
  DEFAULT_CHANNEL_WINDOW,
  DEFAULT_HEARTBEAT_MS,
  type HandshakeReply,
  type Hello,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
} from "./protocol.ts";
import { LinkSession, type SessionOptions } from "./session.ts";

export type AuthResult = { ok: true; sessionToken?: string } | { ok: false; reason: string };

export interface LinkServerOptions {
  /** Decides whether a `hello` may connect. Called for every connection, including resumes. `existing` is the live session for the same workerId, so the hub can refuse a credential that does not own it. */
  authenticate: (hello: Hello, existing?: ServerSession) => AuthResult | Promise<AuthResult>;
  /** Largest WebSocket message accepted in `listen()`. A hub calling `handleConnection` sets it on its own server. */
  maxPayload?: number;
  heartbeatMs?: number;
  /** How long a session with no socket waits for its worker before it is dropped. Default 5 min. */
  resumeTtlMs?: number;
  handshakeTimeoutMs?: number;
  window?: number;
  requestTimeoutMs?: number;
  heartbeatMisses?: number;
}

/** A connected worker, as seen by the hub. It survives reconnects until `resumeTtlMs` passes. */
export class ServerSession extends LinkSession {
  readonly workerId: string;
  hello: Hello;
  sessionToken: string;
  constructor(hello: Hello, sessionToken: string, opts: SessionOptions) {
    super(opts);
    this.workerId = hello.workerId;
    this.hello = hello;
    this.sessionToken = sessionToken;
  }
}

/**
 * Accepts worker connections. Events: `session` (new worker session),
 * `connected` (session, resumed), `disconnected` (session), `lost` (session,
 * missed heartbeats), `expired` (session, dropped after `resumeTtlMs`).
 */
export class LinkServer extends EventEmitter {
  private readonly opts: Required<
    Pick<LinkServerOptions, "heartbeatMs" | "resumeTtlMs" | "handshakeTimeoutMs" | "window">
  > &
    LinkServerOptions;
  private readonly sessions = new Map<string, ServerSession>();
  private readonly expiry = new Map<string, NodeJS.Timeout>();
  private http: HttpServer | null = null;
  private wss: WebSocketServer | null = null;

  constructor(opts: LinkServerOptions) {
    super();
    this.opts = {
      heartbeatMs: DEFAULT_HEARTBEAT_MS,
      resumeTtlMs: 5 * 60_000,
      handshakeTimeoutMs: 10_000,
      window: DEFAULT_CHANNEL_WINDOW,
      ...opts,
    };
  }

  getSession(workerId: string): ServerSession | undefined {
    return this.sessions.get(workerId);
  }

  /** Starts a standalone HTTP + WebSocket server and resolves with its port. The hub mounts `handleConnection` instead. */
  listen(port = 0, host = "127.0.0.1", path = "/"): Promise<number> {
    const http = createServer();
    const wss = new WebSocketServer({
      server: http,
      path,
      maxPayload: this.opts.maxPayload ?? MAX_MESSAGE_BYTES,
    });
    wss.on("connection", (ws) => this.handleConnection(ws));
    this.http = http;
    this.wss = wss;
    return new Promise((resolve, reject) => {
      http.once("error", reject);
      http.listen(port, host, () => {
        const addr = http.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });
  }

  async close(): Promise<void> {
    for (const t of this.expiry.values()) clearTimeout(t);
    this.expiry.clear();
    for (const s of this.sessions.values()) s.destroy("server closed");
    this.sessions.clear();
    for (const c of this.wss?.clients ?? []) c.terminate();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) =>
      this.http ? this.http.close(() => resolve()) : resolve(),
    );
    this.http = null;
    this.wss = null;
  }

  /** Runs the handshake on a freshly accepted WebSocket. */
  handleConnection(ws: WebSocket): void {
    const timer = setTimeout(() => ws.terminate(), this.opts.handshakeTimeoutMs);
    ws.on("error", () => {});
    ws.once("close", () => clearTimeout(timer));
    ws.once("message", (data: RawData, isBinary: boolean) => {
      clearTimeout(timer);
      void this.handshake(ws, data, isBinary);
    });
  }

  private reply(ws: WebSocket, msg: HandshakeReply, close: boolean): void {
    ws.send(JSON.stringify(msg), () => {
      if (close) ws.close();
    });
  }

  private async handshake(ws: WebSocket, data: RawData, isBinary: boolean): Promise<void> {
    let hello: Hello;
    try {
      if (isBinary) throw new Error("binary frame before hello");
      hello = JSON.parse(data.toString()) as Hello;
      if (
        hello.type !== "hello" ||
        typeof hello.workerId !== "string" ||
        typeof hello.protocol !== "number"
      ) {
        throw new Error("malformed hello");
      }
    } catch (err) {
      this.reply(
        ws,
        { type: "rejected", reason: err instanceof Error ? err.message : "malformed hello" },
        true,
      );
      return;
    }
    if (hello.protocol !== PROTOCOL_VERSION) {
      this.reply(ws, { type: "mismatch", need: PROTOCOL_VERSION }, true);
      return;
    }
    let auth: AuthResult;
    try {
      auth = await this.opts.authenticate(hello, this.sessions.get(hello.workerId));
    } catch {
      auth = { ok: false, reason: "authentication failed" };
    }
    if (!auth.ok) {
      this.reply(ws, { type: "rejected", reason: auth.reason }, true);
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;

    const sessionToken = auth.sessionToken ?? randomBytes(24).toString("base64url");
    let session = this.sessions.get(hello.workerId);
    const wantsResume = hello.resume !== undefined;
    if (session && !wantsResume) {
      // The worker restarted and has no channels. Whatever the old session held is gone.
      this.dropSession(session, "worker restarted");
      session = undefined;
    }
    const resumed = session !== undefined;
    if (!session) {
      session = new ServerSession(hello, sessionToken, {
        role: "server",
        window: this.opts.window,
        requestTimeoutMs: this.opts.requestTimeoutMs,
        heartbeatMisses: this.opts.heartbeatMisses,
      });
      this.sessions.set(hello.workerId, session);
      this.wire(session);
      this.emit("session", session);
    }
    session.hello = hello;
    session.sessionToken = sessionToken;
    clearTimeout(this.expiry.get(hello.workerId));
    this.expiry.delete(hello.workerId);

    // Order matters: `ready` goes out before attach, which may write replayed frames behind it.
    const ready: HandshakeReply = {
      type: "ready",
      sessionToken,
      heartbeatMs: this.opts.heartbeatMs,
      resumed,
      resume: resumed ? session.resumeMap() : undefined,
    };
    ws.send(JSON.stringify(ready));
    try {
      session.attach(ws, {
        heartbeatMs: this.opts.heartbeatMs,
        peerResume: hello.resume,
        resumed,
        wsPing: true,
      });
    } catch {
      ws.terminate();
      return;
    }
    this.emit("connected", session, resumed);
  }

  private wire(session: ServerSession): void {
    session.on("detached", () => {
      this.emit("disconnected", session);
      const t = setTimeout(() => {
        this.dropSession(session, "resume window passed");
        this.emit("expired", session);
      }, this.opts.resumeTtlMs);
      t.unref();
      this.expiry.set(session.workerId, t);
    });
    session.on("lost", () => this.emit("lost", session));
  }

  private dropSession(session: ServerSession, reason: string): void {
    clearTimeout(this.expiry.get(session.workerId));
    this.expiry.delete(session.workerId);
    if (this.sessions.get(session.workerId) === session) this.sessions.delete(session.workerId);
    session.destroy(reason);
  }
}
