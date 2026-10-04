import { StringDecoder } from "node:string_decoder";
import type {
  TerminalAttachment,
  TerminalBackend,
  TerminalExitEvent,
  TerminalListEntry,
  TerminalSpawnRequest,
} from "@band-app/host-api";
import type { Channel } from "@band-app/link";
import type { RemoteRpc } from "./rpc";

/**
 * The terminal calls of one worker, as the `TerminalBackend` the hub's
 * terminal service already speaks. The worker owns the PTYs. Output comes down
 * a channel the worker opens on `pty.attach`, and exits arrive as `pty.exit`
 * notifications, which the host routes to {@link RemoteTerminalBackend.handleExit}.
 */
export class RemoteTerminalBackend implements TerminalBackend {
  private readonly listeners = new Set<(event: TerminalExitEvent) => void>();
  /** Terminals this backend spawned and has not seen exit, so a lost session can report them gone. */
  private readonly live = new Map<string, TerminalListEntry>();

  constructor(private readonly rpc: RemoteRpc) {}

  /** A `pty.exit` notification from the worker. */
  handleExit(event: TerminalExitEvent): void {
    this.live.delete(event.terminalId);
    for (const listener of [...this.listeners]) listener(event);
  }

  /** The link session is gone for good, and the worker's shells with it. */
  handleSessionLost(): void {
    for (const entry of [...this.live.values()]) {
      this.handleExit({
        terminalId: entry.terminalId,
        workspaceId: entry.workspaceId,
        exitCode: -1,
        killed: true,
        cleanupOnExit: false,
      });
    }
  }

  async spawn(request: TerminalSpawnRequest): Promise<TerminalListEntry> {
    const entry = await this.rpc.call<TerminalListEntry>("pty.spawn", request);
    this.live.set(entry.terminalId, entry);
    return entry;
  }

  info(terminalId: string): Promise<TerminalListEntry | null> {
    return this.rpc.call("pty.info", { terminalId });
  }

  list(workspaceId: string): Promise<TerminalListEntry[]> {
    return this.rpc.call("pty.list", { workspaceId });
  }

  listAll(): Promise<TerminalListEntry[]> {
    return this.rpc.call("pty.listAll");
  }

  async kill(terminalId: string): Promise<TerminalListEntry | null> {
    return this.rpc.call("pty.kill", { terminalId });
  }

  killWorkspace(workspaceId: string): Promise<void> {
    return this.rpc.call("pty.killWorkspace", { workspaceId });
  }

  getScrollback(terminalId: string, lines?: number): Promise<string | null> {
    return this.rpc.call("pty.getScrollback", { terminalId, lines });
  }

  write(terminalId: string, data: string): Promise<boolean> {
    return this.rpc.call("pty.write", { terminalId, data });
  }

  input(terminalId: string, data: string): void {
    this.fireAndForget("pty.input", { terminalId, data });
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.fireAndForget("pty.resize", { terminalId, cols, rows });
  }

  nudgeResize(terminalId: string): void {
    this.fireAndForget("pty.nudgeResize", { terminalId });
  }

  /** The caller can't act on a failure, and the link keeps requests in order. */
  private fireAndForget(method: string, params: unknown): void {
    this.rpc.request(method, params).catch(() => undefined);
  }

  async attach(
    terminalId: string,
    dims?: { cols: number; rows: number },
  ): Promise<TerminalAttachment | null> {
    let reply: { chan: number; snapshot: Parameters<RemoteRpc["decode"]>[0] };
    try {
      reply = await this.rpc.request("pty.attach", { terminalId, dims });
    } catch (err) {
      // The worker answers "not live" as an error. The interface says null.
      if (err instanceof Error && /not live/i.test(err.message)) return null;
      throw err;
    }
    const channel = this.rpc.channel(reply.chan);
    const snapshot = (await this.rpc.decode(reply.snapshot)) as string;
    return new RemoteAttachment(channel, snapshot);
  }

  onExit(listener: (event: TerminalExitEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  restartDaemon(): Promise<{ killedCount: number }> {
    return this.rpc.call("pty.restartDaemon");
  }

  /** The worker's shells outlive the hub's link, so closing releases nothing. */
  async close(): Promise<void> {}
}

class RemoteAttachment implements TerminalAttachment {
  private held = false;
  private resume: (() => void) | null = null;
  private done = false;

  constructor(
    private readonly channel: Channel,
    readonly snapshot: string,
  ) {}

  start(onData: (data: string) => void): void {
    const decoder = new StringDecoder("utf8");
    void (async () => {
      try {
        for await (const chunk of this.channel) {
          // Not reading is what holds the PTY: the worker stalls on channel credit.
          while (this.held && !this.done) await new Promise<void>((r) => (this.resume = r));
          if (this.done) return;
          const text = decoder.write(chunk);
          if (text !== "") onData(text);
        }
      } catch {
        // The channel failed or the session ended. The terminal's exit event reports it.
      }
    })();
  }

  setOutputHeld(held: boolean): void {
    this.held = held;
    if (!held) this.release();
  }

  detach(): void {
    if (this.done) return;
    this.done = true;
    this.release();
    this.channel.end();
  }

  private release(): void {
    const resume = this.resume;
    this.resume = null;
    resume?.();
  }
}
