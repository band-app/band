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
  private constructor(
    private readonly ws: WebSocket,
    maxOutputChars: number,
  ) {
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.bytes += data.length;
        this.output += data.toString("utf8");
        if (this.output.length > maxOutputChars) this.output = this.output.slice(-maxOutputChars);
        return;
      }
      const frame = JSON.parse(data.toString()) as { type: string };
      if (frame.type === "attached") this.attached = true;
    });
  }

  static async open(
    server: ServerHandle,
    {
      workspaceId,
      terminalId,
      token,
      maxOutputChars = Number.POSITIVE_INFINITY,
    }: {
      workspaceId: string;
      terminalId: string;
      token: string;
      /** Keep only this much of the output, for terminals that print a flood. */
      maxOutputChars?: number;
    },
  ): Promise<TerminalSocket> {
    const url = new URL(server.url);
    const ws = new WebSocket(
      `ws://${url.host}/terminal?workspaceId=${encodeURIComponent(workspaceId)}&terminalId=${terminalId}`,
      { headers: { Cookie: `band_token=${token}` } },
    );
    const socket = new TerminalSocket(ws, maxOutputChars);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "attach", cols: 100, rows: 30 }));
    await waitFor(async () => (socket.attached ? true : undefined), { label: "attach ack" });
    return socket;
  }

  type(input: string): void {
    this.ws.send(input);
  }

  async waitForOutput(text: string, timeoutMs?: number): Promise<void> {
    await waitFor(async () => (this.output.includes(text) ? true : undefined), {
      label: `terminal output ${text}`,
      timeoutMs,
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}
