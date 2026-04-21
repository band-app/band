import type { IncomingMessage } from "node:http";
import { createLogger } from "@band-app/logger";
import type { WebSocket } from "ws";
import { getOrSpawnServer, type LspServerSession } from "./lsp-manager";

const log = createLogger("lsp-proxy");

// ---------------------------------------------------------------------------
// Content-Length framing utilities
// ---------------------------------------------------------------------------

/**
 * Wraps a JSON string in the LSP Content-Length frame format.
 * Format: `Content-Length: <byteLength>\r\n\r\n<json>`
 */
export function frameMessage(json: string): Buffer {
  const body = Buffer.from(json, "utf-8");
  const header = `Content-Length: ${body.byteLength}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, "ascii"), body]);
}

/**
 * Creates a stateful parser for Content-Length framed messages from an LSP
 * server's stdout stream. Handles partial headers, partial bodies, and
 * multiple messages in a single chunk.
 */
export function createFrameParser(onMessage: (json: string) => void): (chunk: Buffer) => void {
  let buffer = Buffer.alloc(0);

  return (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    // Try to extract complete messages from the buffer
    while (true) {
      // Look for the header/body separator
      const separatorIdx = buffer.indexOf("\r\n\r\n");
      if (separatorIdx === -1) break; // Need more data for header

      // Parse Content-Length from the header portion
      const headerStr = buffer.subarray(0, separatorIdx).toString("ascii");
      const match = headerStr.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Malformed header — skip past separator and try again
        log.warn("Malformed LSP header: %s", headerStr);
        buffer = buffer.subarray(separatorIdx + 4);
        continue;
      }

      const contentLength = Number.parseInt(match[1], 10);
      const bodyStart = separatorIdx + 4;
      const messageEnd = bodyStart + contentLength;

      if (buffer.byteLength < messageEnd) {
        break; // Need more data for body
      }

      // Extract the complete JSON body
      const body = buffer.subarray(bodyStart, messageEnd).toString("utf-8");
      buffer = buffer.subarray(messageEnd);

      onMessage(body);
    }
  };
}

// ---------------------------------------------------------------------------
// WebSocket connection handler
// ---------------------------------------------------------------------------

export async function handleLspConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const workspaceId = url.searchParams.get("workspaceId");
  const lang = url.searchParams.get("lang");

  if (!workspaceId || !lang) {
    ws.close(4000, "Missing workspaceId or lang");
    return;
  }

  // Buffer messages that arrive while we're spawning the language server.
  // The browser sends `initialize` immediately on WebSocket open, which
  // races with getOrSpawnServer(). Without buffering the message is lost,
  // the server never receives `initialize`, and every request times out.
  const pendingMessages: string[] = [];
  ws.on("message", (data: Buffer | string) => {
    pendingMessages.push(data.toString());
  });

  let session: LspServerSession;
  try {
    session = await getOrSpawnServer(workspaceId, lang);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      "Failed to spawn %s language server for workspace %s: %s",
      lang,
      workspaceId,
      message,
    );
    ws.close(4001, message);
    return;
  }

  const { process: lspProcess } = session;

  if (!lspProcess.stdin || !lspProcess.stdout) {
    ws.close(4002, "Language server stdio not available");
    return;
  }

  log.debug("LSP client connected: %s/%s", workspaceId, lang);

  // Server stdout -> WebSocket (Content-Length framed -> raw JSON)
  const parseFrame = createFrameParser((json: string) => {
    log.debug(
      "LSP stdout [%s/%s]: %s",
      workspaceId,
      lang,
      json.length > 200 ? `${json.slice(0, 200)}…` : json,
    );
    if (ws.readyState === ws.OPEN) {
      ws.send(json);
    }
  });

  const onStdoutData = (chunk: Buffer) => parseFrame(chunk);
  lspProcess.stdout.on("data", onStdoutData);

  // Server exit -> close WebSocket
  const onExit = (code: number | null) => {
    log.debug("LSP server exited (code %s), closing WebSocket", String(code));
    if (ws.readyState === ws.OPEN) {
      ws.close(1000, "Language server exited");
    }
  };
  lspProcess.on("exit", onExit);

  // Helper: forward a JSON message from the client to the language server
  function forwardToStdin(json: string): void {
    log.debug(
      "LSP stdin [%s/%s]: %s",
      workspaceId,
      lang,
      json.length > 200 ? `${json.slice(0, 200)}…` : json,
    );
    if (lspProcess.stdin?.writable) {
      lspProcess.stdin.write(frameMessage(json));
    }
  }

  // Replace the buffering handler with the real forwarding handler.
  // The `ws` library delivers events synchronously on the current tick,
  // so switching listeners here is safe — no gap, no duplicates.
  ws.removeAllListeners("message");
  ws.on("message", (data: Buffer | string) => {
    forwardToStdin(data.toString());
  });

  // Flush any messages that arrived while we were spawning
  for (const msg of pendingMessages) {
    forwardToStdin(msg);
  }

  // WebSocket close -> detach listeners, keep server alive
  ws.on("close", () => {
    lspProcess.stdout?.off("data", onStdoutData);
    lspProcess.off("exit", onExit);
    log.debug("LSP client disconnected: %s/%s (server kept alive)", workspaceId, lang);
  });
}
