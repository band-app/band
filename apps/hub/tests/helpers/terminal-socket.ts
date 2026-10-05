// A client of the `/terminal` WebSocket, for tests that drive a real shell.

import WebSocket from "ws";
import type { ServerHandle } from "./server";
import { waitFor } from "./wait-for";

/**
 * A `/terminal` WebSocket that sends `attach`, then collects everything the
 * terminal prints: the replayed snapshot first, then live output.
 */
export class TerminalSocket {
  /** Everything printed, or only its tail when `maxOutputChars` is set. */
  output = "";
  /** Bytes of output received. */
  bytes = 0;
  attached = false;
  /** Set once the server closes the socket (e.g. the PTY exited). `null` while still open. */
  closeCode: number | null = null;
  private readonly outputListeners = new Set<(text: string) => void>();
  private constructor(
    private readonly ws: WebSocket,
    maxOutputChars: number,
  ) {
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.bytes += data.length;
        const text = data.toString("utf8");
        this.output += text;
        for (const listener of this.outputListeners) listener(text);
        if (this.output.length > maxOutputChars) this.output = this.output.slice(-maxOutputChars);
        return;
      }
      const frame = JSON.parse(data.toString()) as { type: string };
      if (frame.type === "attached") this.attached = true;
    });
    ws.on("close", (code: number) => {
      this.closeCode = code;
    });
  }

  static async open(
    server: ServerHandle,
    {
      worktreeId,
      terminalId,
      token,
      maxOutputChars = Number.POSITIVE_INFINITY,
      flow = false,
    }: {
      worktreeId: string;
      terminalId: string;
      token: string;
      /** Keep only this much of the output, for terminals that print a flood. */
      maxOutputChars?: number;
      /**
       * Opt into parse-acknowledged backpressure, as the browser does. The
       * server then pauses the PTY once too much output is unacknowledged;
       * acknowledge with {@link ack}.
       */
      flow?: boolean;
    },
  ): Promise<TerminalSocket> {
    const url = new URL(server.url);
    const ws = new WebSocket(
      `ws://${url.host}/terminal?worktreeId=${encodeURIComponent(worktreeId)}&terminalId=${terminalId}`,
      { headers: { Cookie: `band_token=${token}` } },
    );
    const socket = new TerminalSocket(ws, maxOutputChars);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "attach", cols: 100, rows: 30, flow }));
    await waitFor(async () => (socket.attached ? true : undefined), { label: "attach ack" });
    return socket;
  }

  /** Call `listener` with each output frame as it arrives. Returns an unsubscribe function. */
  onOutput(listener: (text: string) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  type(input: string): void {
    this.ws.send(input);
  }

  /** Stop reading the socket, like a client whose main thread is busy. */
  pause(): void {
    this.ws.pause();
  }

  resume(): void {
    this.ws.resume();
  }

  /** Acknowledge output bytes as parsed (a `flow` socket). */
  ack(bytes: number): void {
    this.ws.send(JSON.stringify({ type: "ack", bytes }));
  }

  async waitForOutput(text: string, timeoutMs?: number): Promise<void> {
    await waitFor(async () => (this.output.includes(text) ? true : undefined), {
      label: `terminal output ${text}`,
      timeoutMs,
    });
  }

  /** Wait for the server to close the socket (e.g. the PTY exited) and return the close code. */
  async waitForClose(timeoutMs?: number): Promise<number> {
    await waitFor(async () => (this.closeCode === null ? undefined : true), {
      label: "socket closed",
      timeoutMs,
    });
    // Non-null, checked above.
    return this.closeCode as number;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}
