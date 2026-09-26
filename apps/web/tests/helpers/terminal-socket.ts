// A client of the `/terminal` WebSocket, for tests that drive a real shell.

import WebSocket from "ws";
import type { ServerHandle } from "./server";
import { waitFor } from "./wait-for";

/**
 * A `/terminal` WebSocket that sends `attach`, then collects everything the
 * terminal prints: the replayed snapshot first, then live output.
 */
export class TerminalSocket {
  output = "";
  attached = false;
  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.output += data.toString("utf8");
        return;
      }
      const frame = JSON.parse(data.toString()) as { type: string };
      if (frame.type === "attached") this.attached = true;
    });
  }

  static async open(
    server: ServerHandle,
    { workspaceId, terminalId, token }: { workspaceId: string; terminalId: string; token: string },
  ): Promise<TerminalSocket> {
    const url = new URL(server.url);
    const ws = new WebSocket(
      `ws://${url.host}/terminal?workspaceId=${encodeURIComponent(workspaceId)}&terminalId=${terminalId}`,
      { headers: { Cookie: `band_token=${token}` } },
    );
    const socket = new TerminalSocket(ws);
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

  async waitForOutput(text: string): Promise<void> {
    await waitFor(async () => (this.output.includes(text) ? true : undefined), {
      label: `terminal output ${text}`,
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}
