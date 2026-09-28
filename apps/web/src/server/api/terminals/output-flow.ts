import type { WebSocket } from "ws";
import type { TerminalAttachment } from "../../services/terminal-service";

/**
 * Unparsed output one browser may have in flight before its terminal's PTY is
 * paused, and the level it must drain below before the PTY resumes. Orca's
 * producer watermarks (`pty-producer-flow-control.ts`); the wide gap keeps a
 * draining client from flapping pause/resume once per write.
 */
export const OUTPUT_HOLD_BYTES = 256 * 1024;
export const OUTPUT_RESUME_BYTES = 32 * 1024;
/**
 * A held client that acknowledges nothing for this long is treated as stuck
 * (a frozen tab, a debugger): its debt is written off and the PTY resumes, so
 * one wedged browser can't stall a terminal that others are watching. The
 * WebSocket heartbeat reaps it if it never recovers.
 */
const ACK_STALL_MS = 5_000;
/** How often a hold re-checks the socket buffer and the stall timer. */
const HOLD_POLL_MS = 25;

/**
 * Parse-acknowledged backpressure for one terminal WebSocket, ported from
 * orca's renderer delivery accounting. The browser acknowledges output bytes
 * once xterm has parsed them; when too many are unacknowledged the PTY is
 * held, so the shell blocks instead of the backlog growing in the socket
 * buffers ahead of the user's keystroke echo.
 *
 * A client that never opted into acks (an older tab) is paced on
 * `ws.bufferedAmount` alone, which bounds what this server buffers for it.
 * Input is never held, so a TUI waiting on a query reply (DSR, DA, OSC 11)
 * gets it as soon as the client parses the query.
 */
export class OutputFlow {
  private sentBytes = 0;
  private ackedBytes = 0;
  private acking = false;
  private held = false;
  private lastProgressAt = 0;
  private poll: NodeJS.Timeout | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly attachment: TerminalAttachment,
  ) {}

  /** The client acknowledges parsed bytes; count from here on. */
  enableAcks(): void {
    if (this.acking) return;
    this.acking = true;
    this.ackedBytes = this.sentBytes;
  }

  noteSent(bytes: number): void {
    this.sentBytes += bytes;
    this.update();
  }

  ack(bytes: number): void {
    if (!this.acking) return;
    // Clamped so a bad count can't push in-flight below zero.
    this.ackedBytes = Math.min(this.sentBytes, this.ackedBytes + bytes);
    this.lastProgressAt = Date.now();
    this.update();
  }

  dispose(): void {
    this.stopPoll();
    this.setHeld(false);
  }

  private inFlight(): number {
    return this.acking ? this.sentBytes - this.ackedBytes : this.ws.bufferedAmount;
  }

  private update(): void {
    if (!this.held) {
      if (this.inFlight() > OUTPUT_HOLD_BYTES) this.setHeld(true);
      return;
    }
    if (this.acking && Date.now() - this.lastProgressAt >= ACK_STALL_MS) {
      this.ackedBytes = this.sentBytes;
    }
    if (this.inFlight() < OUTPUT_RESUME_BYTES) this.setHeld(false);
  }

  private setHeld(held: boolean): void {
    if (this.held === held) return;
    this.held = held;
    this.attachment.setOutputHeld(held);
    if (held) {
      this.lastProgressAt = Date.now();
      this.poll = setInterval(() => this.update(), HOLD_POLL_MS);
      this.poll.unref();
    } else {
      this.stopPoll();
    }
  }

  private stopPoll(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }
}
