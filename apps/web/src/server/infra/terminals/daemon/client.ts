import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import {
  type ControlNotify,
  type ControlReply,
  type DaemonPaths,
  type DaemonRequestName,
  type DaemonRequests,
  type HelloMessage,
  type HelloReply,
  PROTOCOL_VERSION,
  readFrames,
  type StreamEvent,
  writeFrame,
} from "./protocol";

const CONNECT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Nothing is serving the endpoint: the socket is missing or refused. The only
 * connect failure that licenses launching a daemon; a timeout or EACCES
 * proves nothing (see `endpoint.ts`).
 */
export class DaemonNotRunningError extends Error {
  constructor(message = "Terminal daemon is not running") {
    super(message);
    this.name = "DaemonNotRunningError";
  }
}

/** The daemon answered but refused us (bad token, or another protocol version). */
export class DaemonRejectedError extends Error {
  constructor(readonly reply: Exclude<HelloReply, { t: "ready" }>) {
    super(
      reply.t === "mismatch"
        ? `Terminal daemon speaks protocol ${reply.protocol}, expected ${PROTOCOL_VERSION}`
        : `Terminal daemon rejected the connection: ${reply.reason}`,
    );
    this.name = "DaemonRejectedError";
  }
}

/**
 * One authenticated session with the terminal daemon over two sockets:
 * `control` for request/response and fire-and-forget commands, `stream` for
 * pushed output and exit events, so an output flood can't delay a reply.
 *
 * An instance is one connection generation. When either socket drops it
 * rejects everything pending, fires `onDisconnect` once, and is finished; the
 * owner connects a fresh instance. A late event from an old instance can't
 * touch a newer one because each owns only its own sockets.
 */
export class DaemonClient {
  readonly pid: number;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly eventListeners = new Set<(event: StreamEvent) => void>();
  private disconnectListener: (() => void) | null = null;
  private closed = false;

  private constructor(
    private readonly control: Socket,
    private readonly stream: Socket,
    ready: Extract<HelloReply, { t: "ready" }>,
    controlFrames: FrameSink,
    streamFrames: FrameSink,
  ) {
    this.pid = ready.pid;
    controlFrames.set((frame) => this.settle(frame as ControlReply));
    streamFrames.set((frame) => {
      for (const listener of this.eventListeners) listener(frame as StreamEvent);
    });
    for (const socket of [control, stream]) {
      socket.on("close", () => this.teardown(true));
      socket.on("error", () => {
        // Followed by `close`, which does the teardown.
      });
    }
    // A socket that closed before the listener above existed won't emit
    // `close` again; the owner sees `isClosed` right after `connect`.
    if (control.destroyed || stream.destroyed) this.teardown(false);
  }

  /**
   * Open and authenticate both connections. Throws
   * {@link DaemonNotRunningError} when nothing serves the socket.
   */
  static async connect(paths: DaemonPaths, buildId: string): Promise<DaemonClient> {
    const clientId = randomUUID();
    const control = await openSocket(paths.socket);
    const controlFrames = new FrameSink(control);
    let stream: Socket | null = null;
    try {
      const token = readToken(paths.token);
      const ready = await handshake(control, controlFrames, {
        t: "hello",
        protocol: PROTOCOL_VERSION,
        token,
        role: "control",
        clientId,
        buildId,
      });
      stream = await openSocket(paths.socket);
      const streamFrames = new FrameSink(stream);
      const streamReady = await handshake(stream, streamFrames, {
        t: "hello",
        protocol: PROTOCOL_VERSION,
        token,
        role: "stream",
        clientId,
        buildId,
      });
      if (streamReady.pid !== ready.pid) {
        throw new Error("Terminal daemon changed while connecting");
      }
      return new DaemonClient(control, stream, ready, controlFrames, streamFrames);
    } catch (err) {
      control.destroy();
      stream?.destroy();
      throw err;
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  request<K extends DaemonRequestName>(
    t: K,
    params: DaemonRequests[K][0],
  ): Promise<DaemonRequests[K][1]> {
    if (this.closed) return Promise.reject(new Error("Terminal daemon connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Terminal daemon did not answer ${t} within ${REQUEST_TIMEOUT_MS} ms`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      writeFrame(this.control, { ...params, id, t });
    });
  }

  /** Fire-and-forget; ordered with requests. A no-op once closed. */
  notify(message: ControlNotify): void {
    if (this.closed) return;
    writeFrame(this.control, message);
  }

  onEvent(listener: (event: StreamEvent) => void): void {
    this.eventListeners.add(listener);
  }

  /** Fires once when the connection drops, but not after {@link close}. */
  onDisconnect(listener: () => void): void {
    this.disconnectListener = listener;
  }

  /** Close deliberately. The daemon and its sessions keep running. */
  close(): void {
    this.teardown(false);
  }

  private settle(reply: ControlReply): void {
    const entry = this.pending.get(reply.id);
    if (!entry) return;
    this.pending.delete(reply.id);
    clearTimeout(entry.timer);
    if (reply.ok) entry.resolve(reply.result);
    else entry.reject(new Error(reply.error));
  }

  private teardown(unexpected: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.control.destroy();
    this.stream.destroy();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Terminal daemon connection lost"));
    }
    this.pending.clear();
    this.eventListeners.clear();
    const listener = this.disconnectListener;
    this.disconnectListener = null;
    if (unexpected) listener?.();
  }
}

/**
 * Ask the daemon at `paths` to exit if it speaks another protocol version.
 * Resolves `true` once it has closed the connection. A daemon of our own
 * version, or one that rejects our token, is left alone.
 */
export async function retireDaemon(paths: DaemonPaths, buildId: string): Promise<boolean> {
  const socket = await openSocket(paths.socket);
  const frames = new FrameSink(socket);
  try {
    await handshake(socket, frames, {
      t: "hello",
      protocol: PROTOCOL_VERSION,
      token: readToken(paths.token),
      role: "control",
      clientId: randomUUID(),
      buildId,
    });
    return false;
  } catch (err) {
    if (!(err instanceof DaemonRejectedError) || err.reply.t !== "mismatch") throw err;
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    writeFrame(socket, { t: "shutdown" } satisfies ControlNotify);
    await closed;
    return true;
  } finally {
    socket.destroy();
  }
}

/**
 * Routes a socket's frames to whichever handler is current: the handshake
 * first, then the client. Installed once so no frame arriving between the two
 * is dropped.
 */
class FrameSink {
  private handler: ((frame: unknown) => void) | null = null;
  private readonly queue: unknown[] = [];

  constructor(socket: Socket) {
    readFrames(socket, (frame) => {
      if (this.handler) this.handler(frame);
      else this.queue.push(frame);
    });
  }

  /** Queue frames until the next {@link set}. */
  hold(): void {
    this.handler = null;
  }

  set(handler: (frame: unknown) => void): void {
    this.handler = handler;
    for (let frame = this.queue.shift(); frame !== undefined; frame = this.queue.shift()) {
      handler(frame);
    }
  }
}

function openSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out connecting to the terminal daemon"));
    }, CONNECT_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      // Only these prove nothing is serving; see endpoint.ts.
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED" || err.code === "ENOTSOCK") {
        reject(new DaemonNotRunningError());
      } else {
        reject(err);
      }
    });
  });
}

function handshake(
  socket: Socket,
  frames: FrameSink,
  hello: HelloMessage,
): Promise<Extract<HelloReply, { t: "ready" }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Terminal daemon did not answer hello"));
    }, CONNECT_TIMEOUT_MS);
    const onClose = () => {
      clearTimeout(timer);
      reject(new Error("Terminal daemon closed the connection during hello"));
    };
    socket.once("close", onClose);
    socket.on("error", () => {
      // Followed by `close`.
    });
    frames.set((frame) => {
      frames.hold();
      clearTimeout(timer);
      socket.off("close", onClose);
      const reply = frame as HelloReply;
      if (reply.t === "ready") resolve(reply);
      else reject(new DaemonRejectedError(reply));
    });
    writeFrame(socket, hello);
  });
}

function readToken(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (err) {
    // The socket answered but no token file exists: send an empty token and
    // let the daemon's rejection say so, rather than guess.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}
