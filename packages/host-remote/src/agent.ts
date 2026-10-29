import { type AgentExit, type AgentStdio, HostOfflineError, HostTimeoutError } from "@band-app/host-api";
import type { Channel } from "@band-app/link";
import type { RemoteRpc } from "./rpc";

const DEFAULT_REATTACH_TIMEOUT_MS = 2 * 60_000;
const ACK_DELAY_MS = 250;
/** Unacknowledged output above which the acknowledgement goes out at once. */
const ACK_NOW_BYTES = 1024 * 1024;
/** How long a stream that ended gracefully waits for the exit that explains it. */
const EXIT_WAIT_MS = 5_000;

/**
 * How long a detached agent waits for its worker before the hub gives up on it, read on every
 * loss. The default covers an `npm i -g` plus a restart; it is an estimate, not a measurement.
 */
function reattachTimeoutMs(): number {
  const value = Number(process.env.BAND_AGENT_REATTACH_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_REATTACH_TIMEOUT_MS;
}

/** The answer to `acp.reattach`. */
interface ReattachReply {
  pid: number | null;
  stdio: number;
  stderr: number;
  /** Bytes the daemon has written to the agent's stdin. */
  stdin: number;
}

/** One output stream of the agent: the channel it currently reads and how much it has received. */
class Lane {
  received = 0;
  iterator: AsyncIterator<Buffer> | null = null;
  eof = false;

  swap(channel: Channel): void {
    this.iterator = channel[Symbol.asyncIterator]();
    this.eof = false;
  }
}

/**
 * An agent in a worker's agent daemon, seen as an {@link AgentStdio} that outlives any one link
 * session. Its output streams keep reading when the link is lost: they wait, and
 * {@link RemoteAgent.reattach} points them at new channels that start at the byte after the last
 * one received, so the reader sees one unbroken stream. Bytes written to stdin while detached
 * are kept and sent after the reattach.
 *
 * Gives up (the agent "exits" with signal `link-lost`) when the worker does not return in time or
 * no longer has the agent. The caller then does what it does for any exited agent.
 */
export class RemoteAgent implements AgentStdio {
  readonly stdout: AgentStdio["stdout"];
  readonly stderr: AgentStdio["stderr"];
  readonly exit: Promise<AgentExit>;
  readonly held: NonNullable<AgentStdio["held"]>;
  readonly ghToken: boolean;
  private resolveExit!: (exit: AgentExit) => void;
  private readonly out = new Lane();
  private readonly err = new Lane();
  private channel: Channel;
  private detachedAt: number | null = null;
  private giveUpTimer: NodeJS.Timeout | null = null;
  private ackTimer: NodeJS.Timeout | null = null;
  private acked = { stdout: 0, stderr: 0 };
  private exited = false;
  private gone = false;
  private readonly waiters: Array<() => void> = [];
  private readonly reattachListeners: Array<() => void> = [];
  /** Stdin bytes written and not yet confirmed by the worker, and the offset of the first. */
  private stdinBuffer: Buffer[] = [];
  private stdinBase = 0;
  private stdinTotal = 0;
  private endWanted = false;
  private killWanted: NodeJS.Signals | null = null;

  constructor(
    private readonly rpc: RemoteRpc,
    readonly agentId: string,
    readonly pid: number | undefined,
    stdio: Channel,
    stderr: Channel,
    info: { specHash: string | null; ghToken: boolean },
    private readonly onEnded: (agentId: string) => void,
  ) {
    this.held = { agentId, specHash: info.specHash };
    this.ghToken = info.ghToken;
    this.channel = stdio;
    this.out.swap(stdio);
    this.err.swap(stderr);
    this.exit = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.stdout = this.lane(this.out);
    this.stderr = this.lane(this.err);
  }

  get isDetached(): boolean {
    return this.detachedAt !== null && !this.gone;
  }

  get isGone(): boolean {
    return this.gone;
  }

  readonly stdin: AgentStdio["stdin"] = {
    write: (chunk) => {
      if (this.exited || this.gone) return;
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      this.stdinBuffer.push(bytes);
      this.stdinTotal += bytes.length;
      if (this.detachedAt === null) this.channel.send(bytes).catch(() => undefined);
    },
    end: () => {
      this.endWanted = true;
      if (this.detachedAt === null) this.channel.end();
    },
  };

  kill(signal?: NodeJS.Signals): void {
    if (this.exited || this.gone) return;
    if (this.detachedAt !== null) {
      // Sent once the worker is back, so a stopped chat does not leave its agent running.
      this.killWanted = signal ?? "SIGTERM";
      return;
    }
    this.rpc.request("acp.kill", { agentId: this.agentId, signal }).catch(() => undefined);
  }

  onReattached(listener: () => void): void {
    this.reattachListeners.push(listener);
  }

  /** The worker said the agent exited. */
  notifyExit(exit: AgentExit): void {
    if (this.exited) return;
    this.exited = true;
    this.finish(exit);
  }

  /** The link session is gone. The agent may still run in the worker's daemon. */
  detach(): void {
    if (this.detachedAt !== null || this.exited || this.gone) return;
    this.detachedAt = Date.now();
    this.giveUpTimer = setTimeout(() => this.giveUp(), reattachTimeoutMs());
    this.giveUpTimer.unref();
  }

  /** Opens new channels on the worker's current session and carries on from the last byte. */
  async reattach(): Promise<void> {
    if (this.detachedAt === null || this.gone) return;
    let reply: ReattachReply;
    try {
      reply = await this.rpc.request<ReattachReply>("acp.reattach", {
        agentId: this.agentId,
        stdout: this.out.received,
        stderr: this.err.received,
      });
    } catch (err) {
      // An offline worker is retried at its next connect; one that refuses has lost the agent.
      if (!isOffline(err)) this.giveUp();
      return;
    }
    if (this.gone) {
      // Gave up while the call was out: the worker holds an agent nobody uses.
      this.rpc.request("acp.kill", { agentId: this.agentId }).catch(() => undefined);
      return;
    }
    this.channel = this.rpc.channel(reply.stdio);
    this.out.swap(this.channel);
    this.err.swap(this.rpc.channel(reply.stderr));
    this.trimStdin(reply.stdin);
    // What the worker never received goes again, in order, ahead of anything written later.
    for (const chunk of this.stdinBuffer) this.channel.send(chunk).catch(() => undefined);
    if (this.endWanted) this.channel.end();
    this.detachedAt = null;
    if (this.giveUpTimer) clearTimeout(this.giveUpTimer);
    this.giveUpTimer = null;
    if (this.killWanted) {
      this.rpc
        .request("acp.kill", { agentId: this.agentId, signal: this.killWanted })
        .catch(() => undefined);
    }
    this.wake();
    for (const listener of this.reattachListeners) listener();
  }

  /** Gives up on the agent: it "exits" with `link-lost`. */
  giveUp(): void {
    if (this.gone || this.exited) return;
    this.gone = true;
    this.finish({ code: null, signal: "link-lost" });
  }

  private finish(exit: AgentExit): void {
    if (this.giveUpTimer) clearTimeout(this.giveUpTimer);
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.giveUpTimer = null;
    this.ackTimer = null;
    this.resolveExit(exit);
    // Whoever never calls `stdin.end()` would leave the worker waiting on this channel for good.
    if (this.detachedAt === null) {
      try {
        this.channel.end();
      } catch {
        // The channel is already closed.
      }
    }
    this.wake();
    this.onEnded(this.agentId);
  }

  private wake(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  private changed(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private trimStdin(confirmed: number): void {
    let drop = confirmed - this.stdinBase;
    while (drop > 0 && this.stdinBuffer.length > 0) {
      const first = this.stdinBuffer[0] as Buffer;
      if (first.length <= drop) {
        this.stdinBuffer.shift();
        drop -= first.length;
        this.stdinBase += first.length;
      } else {
        this.stdinBuffer[0] = first.subarray(drop);
        this.stdinBase += drop;
        drop = 0;
      }
    }
  }

  private async *lane(lane: Lane): AsyncGenerator<Uint8Array> {
    for (;;) {
      if (this.gone || (this.exited && lane.eof)) return;
      const iterator = lane.iterator;
      if (!iterator || lane.eof) {
        if (this.exited || this.gone) return;
        // A stream that ended on its own is waiting for the exit that explains it.
        const timer = lane.eof
          ? setTimeout(() => this.notifyExit({ code: null, signal: null }), EXIT_WAIT_MS)
          : null;
        await this.changed();
        if (timer) clearTimeout(timer);
        continue;
      }
      let next: IteratorResult<Buffer>;
      try {
        next = await iterator.next();
      } catch {
        // The channel failed with its link session. A swapped-in channel is a different iterator.
        if (lane.iterator === iterator) {
          lane.iterator = null;
          this.detach();
        }
        continue;
      }
      if (next.done) {
        if (lane.iterator === iterator) lane.eof = true;
        continue;
      }
      lane.received += next.value.length;
      this.scheduleAck();
      yield next.value;
    }
  }

  private scheduleAck(): void {
    const pending = this.out.received - this.acked.stdout + (this.err.received - this.acked.stderr);
    if (pending >= ACK_NOW_BYTES) {
      void this.sendAck();
      return;
    }
    if (this.ackTimer || this.detachedAt !== null || this.exited) return;
    this.ackTimer = setTimeout(() => void this.sendAck(), ACK_DELAY_MS);
    this.ackTimer.unref();
  }

  private async sendAck(): Promise<void> {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    if (this.detachedAt !== null || this.exited || this.gone) return;
    const upTo = { stdout: this.out.received, stderr: this.err.received };
    try {
      const reply = await this.rpc.request<{ stdin: number }>("acp.ack", {
        agentId: this.agentId,
        ...upTo,
      });
      this.acked = upTo;
      this.trimStdin(reply.stdin);
    } catch {
      // The next chunk asks again, and a reattach names the offsets anyway.
    }
  }
}

function isOffline(err: unknown): boolean {
  return err instanceof HostOfflineError || err instanceof HostTimeoutError;
}
