/**
 * The client side of the hub's `/terminal` WebSocket (`packages/worktree-ops/src/terminal-socket.ts`):
 * request-driven replay (`attach` carries the fitted size and asks for parse acknowledgements),
 * `ack`, `resize`, `ping`, the reconnect backoff, and the close codes that end a terminal for good.
 *
 * It owns no screen. A platform passes in a socket factory and a sink, so the same protocol runs
 * under the mobile app's native view and in tests. The web keeps its own copy inside
 * `terminal-cache.ts`, which also drives xterm, parking and the direct worker path.
 */

import { tokenProtocols, toWsUrl } from "./hub-client.ts";

const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 20_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
/** How long container-driven resizes wait for the replay after an `attach`. */
const REPLAY_GUARD_TIMEOUT_MS = 3_000;

const OPEN = 1;

/** The part of `WebSocket` the client uses. */
export interface TerminalSocket {
  readyState: number;
  binaryType: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  send(data: string): void;
  close(code?: number): void;
}

export interface TerminalDims {
  cols: number;
  rows: number;
}

export interface TerminalSink {
  /** Output bytes for the screen. Call `parsed` once the screen has taken them (it acknowledges them). */
  write(bytes: Uint8Array, parsed: () => void): void;
  /** Clear the screen: a reconnect replays all of it. */
  reset(): void;
  /** A line of the client's own, such as "Reconnecting…" (plain text, no escapes). */
  notice(text: string): void;
  /** The foreground process name. */
  title?(title: string): void;
  /** The terminal ended for good (the shell exited, or the hub refused it). */
  ended?(reason: "exited" | "failed", message?: string): void;
  /** The connection state, for an indicator. */
  connection?(state: "connecting" | "open" | "reconnecting"): void;
}

export interface TerminalClientOptions {
  hubUrl: string;
  token: string;
  worktreeId: string;
  terminalId: string;
  sink: TerminalSink;
  /** The size the screen fits now, or null before it has been laid out. */
  getDims: () => TerminalDims | null;
  createSocket: (url: string, protocols: string[]) => TerminalSocket;
}

export function terminalSocketUrl(hubUrl: string, worktreeId: string, terminalId: string): string {
  return `${toWsUrl(hubUrl)}/terminal?worktreeId=${encodeURIComponent(worktreeId)}&terminalId=${encodeURIComponent(terminalId)}`;
}

export class TerminalClient {
  private ws: TerminalSocket | null = null;
  private destroyed = false;
  private terminated = false;
  private attachSent = false;
  private awaitingReplay = false;
  private visible = true;
  private lastCols = 0;
  private lastRows = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private replayGuard: ReturnType<typeof setTimeout> | null = null;
  private lastPongAt = 0;
  private didConnectOnce = false;

  private readonly options: TerminalClientOptions;

  constructor(options: TerminalClientOptions) {
    this.options = options;
  }

  connect(): void {
    if (this.destroyed || this.terminated) return;
    this.clearReconnectTimer();
    const { options } = this;
    const previous = this.ws;
    this.ws = null;
    previous?.close();
    const url = terminalSocketUrl(options.hubUrl, options.worktreeId, options.terminalId);
    const sock = options.createSocket(url, tokenProtocols(options.token, ["band"]));
    this.ws = sock;
    sock.binaryType = "arraybuffer";
    const reconnect = this.didConnectOnce;
    options.sink.connection?.(reconnect ? "reconnecting" : "connecting");
    let unacked = 0;
    const sendAck = () => {
      const bytes = unacked;
      unacked = 0;
      if (this.ws === sock && sock.readyState === OPEN && bytes > 0) {
        sock.send(JSON.stringify({ type: "ack", bytes }));
      }
    };
    const ack = (bytes: number) => {
      if (this.ws !== sock || bytes === 0) return;
      if (unacked === 0) queueMicrotask(sendAck);
      unacked += bytes;
    };

    sock.onopen = () => {
      if (this.ws !== sock) return;
      this.reconnectAttempts = 0;
      this.lastPongAt = Date.now();
      this.attachSent = false;
      this.lastCols = 0;
      this.lastRows = 0;
      this.clearReplayGuard();
      // The replay rebuilds the whole screen, so what is on it now would sit under it.
      if (reconnect) options.sink.reset();
      this.didConnectOnce = true;
      options.sink.connection?.("open");
      this.requestReplay();
      this.stopHeartbeat();
      this.heartbeatTimer = setInterval(() => this.probe(), HEARTBEAT_INTERVAL_MS);
    };

    sock.onmessage = (event) => {
      if (this.ws !== sock) return;
      const data = event.data;
      if (typeof data === "string") {
        this.onText(data);
        return;
      }
      if (!(data instanceof ArrayBuffer)) return;
      this.finishReplay();
      const bytes = new Uint8Array(data);
      if (this.visible) {
        options.sink.write(bytes, () => ack(bytes.byteLength));
      } else {
        // Nobody can see it, so it must not hold the PTY back for another device watching it.
        ack(bytes.byteLength);
        options.sink.write(bytes, () => {});
      }
    };

    sock.onclose = (event) => {
      if (this.ws !== sock) return;
      this.stopHeartbeat();
      this.ws = null;
      if (this.destroyed) return;
      // 1000: the shell exited or the client closed it. 4xxx: the hub refused it. Neither
      // reconnects, so no new shell spawns behind the user's back.
      if (event.code === 1000 || event.code >= 4000) {
        this.terminated = true;
        options.sink.ended?.(event.code === 1000 ? "exited" : "failed");
        return;
      }
      options.sink.connection?.("reconnecting");
      this.scheduleReconnect();
    };
  }

  private onText(text: string): void {
    const { sink } = this.options;
    let msg: { type?: string; title?: unknown; message?: unknown };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === "pong") this.lastPongAt = Date.now();
    else if (msg.type === "attached") this.finishReplay();
    else if (msg.type === "title" && typeof msg.title === "string") sink.title?.(msg.title);
    else if (msg.type === "error" && typeof msg.message === "string") {
      // Control bytes stripped, so a hub message cannot drive the screen.
      sink.notice(msg.message.replace(/\p{Cc}/gu, ""));
    }
  }

  /** The screen is laid out at `dims` (or its size changed). */
  resize(dims: TerminalDims): void {
    if (dims.cols <= 0 || dims.rows <= 0) return;
    const sock = this.ws;
    if (!sock || sock.readyState !== OPEN) return;
    if (!this.attachSent) {
      this.requestReplay();
      return;
    }
    // A size change between the request and the replay would reflow the snapshot wrongly.
    if (this.awaitingReplay) return;
    if (dims.cols === this.lastCols && dims.rows === this.lastRows) return;
    this.lastCols = dims.cols;
    this.lastRows = dims.rows;
    sock.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
  }

  /** Keystrokes for the shell. Returns false when there is no open socket. */
  send(data: string): boolean {
    const sock = this.ws;
    if (!sock || sock.readyState !== OPEN || !data) return false;
    sock.send(data);
    return true;
  }

  /** Whether anyone can see the screen. Output while hidden never holds the PTY. */
  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  /** The app came back to the foreground, or the network returned. */
  resume(): void {
    if (this.destroyed || this.terminated) return;
    const sock = this.ws;
    if (!sock || sock.readyState !== OPEN) {
      this.reconnectAttempts = 0;
      this.connect();
    } else {
      this.probe();
    }
  }

  /** Tells the hub to kill the shell, then closes. */
  kill(): void {
    const sock = this.ws;
    if (sock && sock.readyState === OPEN) sock.send(JSON.stringify({ type: "close" }));
    this.destroy();
  }

  destroy(): void {
    this.destroyed = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.clearReplayGuard();
    const sock = this.ws;
    this.ws = null;
    sock?.close();
  }

  private requestReplay(): void {
    if (this.attachSent) return;
    const sock = this.ws;
    if (!sock || sock.readyState !== OPEN) return;
    const dims = this.options.getDims();
    if (!dims || dims.cols <= 0 || dims.rows <= 0) return;
    this.attachSent = true;
    this.lastCols = dims.cols;
    this.lastRows = dims.rows;
    this.awaitingReplay = true;
    sock.send(JSON.stringify({ type: "attach", cols: dims.cols, rows: dims.rows, flow: true }));
    this.replayGuard = setTimeout(() => this.finishReplay(), REPLAY_GUARD_TIMEOUT_MS);
  }

  private finishReplay(): void {
    if (!this.awaitingReplay) return;
    this.clearReplayGuard();
    // The screen may have changed size while the replay was on its way.
    const dims = this.options.getDims();
    if (dims) this.resize(dims);
  }

  private clearReplayGuard(): void {
    this.awaitingReplay = false;
    if (this.replayGuard !== null) {
      clearTimeout(this.replayGuard);
      this.replayGuard = null;
    }
  }

  private probe(): void {
    const sock = this.ws;
    if (!sock || sock.readyState !== OPEN) return;
    if (Date.now() - this.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
      // Dead socket: drop it and dial again at once.
      this.ws = null;
      this.stopHeartbeat();
      sock.close();
      this.options.sink.connection?.("reconnecting");
      this.scheduleReconnect();
      return;
    }
    try {
      sock.send(JSON.stringify({ type: "ping" }));
    } catch {
      sock.close();
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.terminated || this.reconnectTimer !== null) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    if (delay < RECONNECT_MAX_MS) this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
