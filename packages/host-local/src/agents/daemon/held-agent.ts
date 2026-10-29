import type { AgentExit, AgentStdio } from "@band-app/host-api";
import type { AgentHolder } from "./holder";
import type { AgentRecord, AgentStreamName } from "./protocol";

/** A byte queue that one consumer reads as an async iterable. Ends after the queued bytes are read. */
class Pipe implements AsyncIterable<Uint8Array> {
  private readonly queue: Uint8Array[] = [];
  private waiting: ((result: IteratorResult<Uint8Array>) => void) | null = null;
  private ended = false;

  push(chunk: Uint8Array): void {
    if (this.ended) return;
    if (this.waiting) {
      const wake = this.waiting;
      this.waiting = null;
      wake({ value: chunk, done: false });
    } else {
      this.queue.push(chunk);
    }
  }

  end(): void {
    this.ended = true;
    if (this.waiting && this.queue.length === 0) {
      const wake = this.waiting;
      this.waiting = null;
      wake({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const chunk = this.queue.shift();
        if (chunk) return Promise.resolve({ value: chunk, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
      // A reader that stops (the channel was reset) leaves the agent running in the daemon.
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/**
 * An agent held by the agent daemon, seen as an {@link AgentStdio}. Its output starts at the
 * offsets given to {@link HeldAgentProcess.attach}, which is how a reattach continues where the
 * hub's last byte was. Ending or abandoning a handle never stops the agent; `kill` does.
 */
export class HeldAgentProcess implements AgentStdio {
  readonly stdout: Pipe = new Pipe();
  readonly stderr: Pipe = new Pipe();
  readonly exit: Promise<AgentExit>;
  private resolveExit!: (exit: AgentExit) => void;
  private readonly next: Record<AgentStreamName, number>;
  private done = false;

  private constructor(
    private readonly holder: AgentHolder,
    readonly record: AgentRecord,
    offsets: { stdout: number; stderr: number },
  ) {
    this.next = { ...offsets };
    this.exit = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  /** Subscribes to the agent from `offsets`. Null when no daemon holds it. */
  static async attach(
    holder: AgentHolder,
    agentId: string,
    offsets: { stdout: number; stderr: number },
  ): Promise<HeldAgentProcess | null> {
    let handle: HeldAgentProcess | null = null;
    const pending: Array<() => void> = [];
    // The daemon replays before it answers, so events can arrive while `handle` is still being made.
    const record = await holder.attach(agentId, offsets, {
      output: (stream, off, data) => {
        if (handle) handle.onOutput(stream, off, data);
        else pending.push(() => handle?.onOutput(stream, off, data));
      },
      exit: (exit) => {
        if (handle) handle.finish(exit);
        else pending.push(() => handle?.finish(exit));
      },
    });
    if (!record) return null;
    handle = new HeldAgentProcess(holder, record, offsets);
    for (const run of pending) run();
    return handle;
  }

  get pid(): number | undefined {
    return this.record.pid ?? undefined;
  }

  get held(): NonNullable<AgentStdio["held"]> {
    return {
      agentId: this.record.agentId,
      specHash: this.record.specHash,
      ghToken: this.record.ghToken,
    };
  }

  readonly stdin: AgentStdio["stdin"] = {
    write: (chunk) => {
      void this.holder
        .write(this.record.agentId, typeof chunk === "string" ? Buffer.from(chunk) : chunk)
        .catch(() => undefined);
    },
    end: () => {
      void this.holder.write(this.record.agentId, new Uint8Array(0), true).catch(() => undefined);
    },
  };

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    void this.holder.kill(this.record.agentId, signal).catch(() => undefined);
  }

  /** Stops streaming to this handle. The agent keeps running. */
  release(): void {
    this.holder.detach(this.record.agentId);
    this.stdout.end();
    this.stderr.end();
  }

  private onOutput(stream: AgentStreamName, off: number, data: Buffer): void {
    // A replay and the live stream can overlap by a chunk, and a repeat must not reach the reader.
    const expected = this.next[stream];
    if (off + data.length <= expected) return;
    const fresh = off < expected ? data.subarray(expected - off) : data;
    this.next[stream] = Math.max(expected, off) + fresh.length;
    (stream === "stdout" ? this.stdout : this.stderr).push(fresh);
  }

  private finish(exit: AgentExit): void {
    if (this.done) return;
    this.done = true;
    this.stdout.end();
    this.stderr.end();
    this.resolveExit(exit);
  }
}
