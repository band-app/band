import {
  AttachGate,
  type TerminalAttachment,
  type TerminalBackend,
  type TerminalSpawnRequest,
} from "./terminal-backend";
import { type TerminalExitEvent, type TerminalListEntry, TerminalPool } from "./terminal-pool";

/**
 * PTYs owned by this process, through a {@link TerminalPool}. They die with
 * the web server. The daemon backend is the default; this one covers Windows,
 * `BAND_TERMINAL_DAEMON=0`, and a daemon that cannot start.
 */
export class InProcessTerminalBackend implements TerminalBackend {
  constructor(private readonly pool: TerminalPool = new TerminalPool()) {}

  async spawn(request: TerminalSpawnRequest): Promise<TerminalListEntry> {
    const { workspaceId, terminalId, workspaceRoot, options, cleanupOnExit } = request;
    await this.pool.spawn(workspaceId, terminalId, workspaceRoot, options, { cleanupOnExit });
    const entry = this.pool.info(terminalId);
    if (!entry) throw new Error(`Terminal exited during spawn: ${terminalId}`);
    return entry;
  }

  async info(terminalId: string): Promise<TerminalListEntry | null> {
    return this.pool.info(terminalId);
  }

  async list(workspaceId: string): Promise<TerminalListEntry[]> {
    return this.pool.list(workspaceId);
  }

  async listAll(): Promise<TerminalListEntry[]> {
    return this.pool.listAll();
  }

  async kill(terminalId: string): Promise<TerminalListEntry | null> {
    const entry = this.pool.info(terminalId);
    this.pool.kill(terminalId);
    return entry;
  }

  async killWorkspace(workspaceId: string): Promise<void> {
    this.pool.killWorkspace(workspaceId);
  }

  async getScrollback(terminalId: string, lines?: number): Promise<string | null> {
    return this.pool.getScrollback(terminalId, lines);
  }

  async write(terminalId: string, data: string): Promise<boolean> {
    return this.pool.write(terminalId, data);
  }

  input(terminalId: string, data: string): void {
    this.pool.write(terminalId, data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.pool.resize(terminalId, cols, rows);
  }

  nudgeResize(terminalId: string): void {
    this.pool.nudgeResize(terminalId);
  }

  async attach(
    terminalId: string,
    dims?: { cols: number; rows: number },
  ): Promise<TerminalAttachment | null> {
    let unsubscribe: (() => void) | null = null;
    const gate = new AttachGate(() => unsubscribe?.());
    const attached = await this.pool.attach(terminalId, dims, (data, seq) => gate.push(data, seq));
    if (!attached) return null;
    unsubscribe = attached.unsubscribe;
    gate.setSnapshot(attached.snapshot.data, attached.snapshot.seq);
    return gate;
  }

  onExit(listener: (event: TerminalExitEvent) => void): () => void {
    return this.pool.onExit(listener);
  }

  async close(): Promise<void> {
    this.pool.killAll();
  }
}
