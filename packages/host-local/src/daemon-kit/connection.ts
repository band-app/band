import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { checkEndpointOwner } from "./endpoint";
import {
  type DaemonPaths,
  type HelloMessage,
  type HelloReply,
  readFrames,
  writeFrame,
} from "./protocol";

const CONNECT_TIMEOUT_MS = 5_000;

/** What a daemon calls itself in messages, and the protocol version a client speaks. */
export interface DaemonIdentity {
  /** For example `Terminal daemon`. */
  label: string;
  protocol: number;
}

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
  constructor(
    readonly reply: Exclude<HelloReply, { t: "ready" }>,
    identity: DaemonIdentity,
  ) {
    super(
      reply.t === "mismatch"
        ? `${identity.label} speaks protocol ${reply.protocol}, expected ${identity.protocol}`
        : `${identity.label} rejected the connection: ${reply.reason}`,
    );
    this.name = "DaemonRejectedError";
  }
}

/**
 * Routes a socket's frames to whichever handler is current: the handshake
 * first, then the client. Installed once so no frame arriving between the two
 * is dropped.
 */
export class FrameSink {
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

/**
 * Connect to the daemon socket at `path`, but only if it is ours (see
 * `checkEndpointOwner`): the connection is about to carry the token. The
 * check and the connect are two syscalls, but only we can write to the 0700
 * directory, so no one else can swap the socket in between.
 */
export function openSocket(path: string, identity: DaemonIdentity): Promise<Socket> {
  try {
    if (checkEndpointOwner(path) === "missing") {
      return Promise.reject(new DaemonNotRunningError(`${identity.label} is not running`));
    }
  } catch (err) {
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const socket = connect({ path });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to the ${identity.label.toLowerCase()}`));
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
        reject(new DaemonNotRunningError(`${identity.label} is not running`));
      } else {
        reject(err);
      }
    });
  });
}

/** Send `hello` and wait for the daemon's verdict. */
export function handshake(
  socket: Socket,
  frames: FrameSink,
  hello: HelloMessage,
  identity: DaemonIdentity,
): Promise<Extract<HelloReply, { t: "ready" }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${identity.label} did not answer hello`));
    }, CONNECT_TIMEOUT_MS);
    const onClose = () => {
      clearTimeout(timer);
      reject(new Error(`${identity.label} closed the connection during hello`));
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
      else reject(new DaemonRejectedError(reply, identity));
    });
    writeFrame(socket, hello);
  });
}

export async function readToken(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (err) {
    // The socket answered but no token file exists: send an empty token and
    // let the daemon's rejection say so, rather than guess.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Ask the daemon at `paths` to exit if it speaks another protocol version.
 * Resolves `true` once it has closed the connection. A daemon of our own
 * version, or one that rejects our token, is left alone.
 */
export async function retireDaemon(
  paths: DaemonPaths,
  buildId: string,
  identity: DaemonIdentity,
): Promise<boolean> {
  const socket = await openSocket(paths.socket, identity);
  const frames = new FrameSink(socket);
  try {
    await handshake(
      socket,
      frames,
      {
        t: "hello",
        protocol: identity.protocol,
        token: await readToken(paths.token),
        role: "control",
        clientId: randomUUID(),
        buildId,
      },
      identity,
    );
    return false;
  } catch (err) {
    if (!(err instanceof DaemonRejectedError) || err.reply.t !== "mismatch") throw err;
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    writeFrame(socket, { t: "shutdown" });
    await closed;
    return true;
  } finally {
    socket.destroy();
  }
}
