import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import {
  DaemonNotRunningError,
  DaemonRejectedError,
  FrameSink,
  handshake,
  openSocket,
  readToken,
} from "../../daemon-kit/connection";
import { type DaemonPaths, type HelloReply, writeFrame } from "../../daemon-kit/protocol";
import {
  type ControlReply,
  type DaemonRequestName,
  type DaemonRequests,
  IDENTITY,
  PROTOCOL_VERSION,
  type StreamEvent,
} from "./protocol";

export { DaemonNotRunningError, DaemonRejectedError };

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * One authenticated session with the agent daemon over two sockets: `control` for requests and
 * `stream` for pushed output, so a flood of output can't delay a reply. An instance is one
 * connection generation: when either socket drops it rejects what is pending, fires
 * `onDisconnect` once and is finished.
 */
export class AgentDaemonClient {
  readonly pid: number;
  readonly buildId: string;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly listeners = new Set<(event: StreamEvent) => void>();
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
    this.buildId = ready.buildId;
    controlFrames.set((frame) => this.settle(frame as ControlReply));
    streamFrames.set((frame) => {
      for (const listener of this.listeners) listener(frame as StreamEvent);
    });
    for (const socket of [control, stream]) {
      socket.on("close", () => this.teardown(true));
      socket.on("error", () => {
        // Followed by `close`, which does the teardown.
      });
    }
    if (control.destroyed || stream.destroyed) this.teardown(false);
  }

  /** Throws {@link DaemonNotRunningError} when nothing serves the socket. */
  static async connect(paths: DaemonPaths, buildId: string): Promise<AgentDaemonClient> {
    const clientId = randomUUID();
    const control = await openSocket(paths.socket, IDENTITY);
    const controlFrames = new FrameSink(control);
    let stream: Socket | null = null;
    try {
      const token = await readToken(paths.token);
      const hello = { t: "hello", protocol: PROTOCOL_VERSION, token, clientId, buildId } as const;
      const ready = await handshake(
        control,
        controlFrames,
        { ...hello, role: "control" },
        IDENTITY,
      );
      stream = await openSocket(paths.socket, IDENTITY);
      const streamFrames = new FrameSink(stream);
      const streamReady = await handshake(
        stream,
        streamFrames,
        { ...hello, role: "stream" },
        IDENTITY,
      );
      if (streamReady.pid !== ready.pid) throw new Error("Agent daemon changed while connecting");
      return new AgentDaemonClient(control, stream, ready, controlFrames, streamFrames);
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
    if (this.closed) return Promise.reject(new Error("Agent daemon connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Agent daemon did not answer ${t} within ${REQUEST_TIMEOUT_MS} ms`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      writeFrame(this.control, { ...params, id, t });
    });
  }

  onEvent(listener: (event: StreamEvent) => void): void {
    this.listeners.add(listener);
  }

  /** Fires once when the connection drops, but not after {@link close}. */
  onDisconnect(listener: () => void): void {
    this.disconnectListener = listener;
  }

  /** Close deliberately. The daemon and its agents keep running. */
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
      entry.reject(new Error("Agent daemon connection lost"));
    }
    this.pending.clear();
    this.listeners.clear();
    const listener = this.disconnectListener;
    this.disconnectListener = null;
    if (unexpected) listener?.();
  }
}
