import type { IncomingMessage } from "node:http";
import type { Duplex } from "@band-app/host-api";
import { createLogger } from "@band-app/logger";
import type { WebSocket } from "ws";
import { WorkspaceQueries } from "../db/queries/workspaces";
import { hostRegistry } from "../host/registry";

const workspaceQueries = new WorkspaceQueries();

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

function didCloseMessage(uri: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "textDocument/didClose",
    params: { textDocument: { uri } },
  });
}

/**
 * How many connections hold each document open, per language server
 * (`${workspaceId}:${lang}`). Every WebSocket for a workspace and language
 * shares the server, so only the first `didOpen` and the last `didClose` of a
 * URI reach it.
 */
const serverDocuments = new Map<string, Map<string, number>>();

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

  let connection: Duplex;
  try {
    // Direct infra-tier DB read: the proxy is in the infra tier and cannot
    // depend on `WorkspaceService.resolve` (issue #535).
    const workspace = workspaceQueries.findIdentity(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    connection = await hostRegistry
      .hostFor(workspaceId)
      .lsp.connect({ workspaceId, lang, root: workspace.worktreePath });
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

  // The socket closed while the server was starting: no close handler exists yet.
  if (ws.readyState !== ws.OPEN) {
    connection.close();
    return;
  }

  log.debug("LSP client connected: %s/%s", workspaceId, lang);

  // Track pending requests so we can retry on transient "No Project" errors.
  // This happens when a definition request arrives before tsserver has finished
  // loading the configured project for the file (race condition after didOpen).
  const pendingRequests = new Map<number, string>();
  // Documents this connection opened and has not closed. The language server
  // outlives the connection and is shared by every connection to this
  // workspace, so opens and closes are counted on the session: without that,
  // a page reload's `didOpen` of a file the old page left open is rejected as
  // "already open" (tsserver then answers "No Project"), and one tab closing
  // would close a file another tab still has open.
  //
  // Limitation: with two connections holding one file, the server keeps the
  // text of whichever opened it last. If that connection leaves first, the
  // other's edits are applied to that text, which drifts when the two
  // buffers differed.
  const openDocuments = new Set<string>();
  const serverId = `${workspaceId}:${lang}`;

  /** Looked up on every use: `release` may delete an empty map another connection still needs. */
  function documentCounts(): Map<string, number> {
    let counts = serverDocuments.get(serverId);
    if (!counts) {
      counts = new Map<string, number>();
      serverDocuments.set(serverId, counts);
    }
    return counts;
  }

  /** Count an open or close and say whether to forward it to the server. */
  function trackDocument(method: string | undefined, uri: string): boolean {
    const sessionDocuments = documentCounts();
    const count = sessionDocuments.get(uri) ?? 0;
    if (method === "textDocument/didOpen") {
      if (openDocuments.has(uri)) return true;
      openDocuments.add(uri);
      sessionDocuments.set(uri, count + 1);
      // Already open for another connection: the server refuses a second
      // `didOpen`, and this client's `didChange` versions start from its own.
      // Close and reopen so the server holds this client's text.
      if (count > 0) writeToStdin(didCloseMessage(uri));
      return true;
    }
    if (method === "textDocument/didClose") {
      if (!openDocuments.delete(uri)) return false;
      if (count <= 1) {
        sessionDocuments.delete(uri);
        return true;
      }
      sessionDocuments.set(uri, count - 1);
      return false;
    }
    return true;
  }
  const retriedIds = new Set<number>();
  const RETRY_DELAY_MS = 2000;

  // Server stdout -> WebSocket (Content-Length framed -> raw JSON)
  const parseFrame = createFrameParser((json: string) => {
    log.debug(
      "LSP stdout [%s/%s]: %s",
      workspaceId,
      lang,
      json.length > 200 ? `${json.slice(0, 200)}…` : json,
    );

    // Check for "No Project" error responses and retry the original request.
    try {
      const msg = JSON.parse(json) as {
        id?: number;
        error?: { message?: string };
      };
      if (
        msg.id != null &&
        msg.error?.message?.includes("No Project") &&
        !retriedIds.has(msg.id) &&
        pendingRequests.has(msg.id)
      ) {
        const originalRequest = pendingRequests.get(msg.id)!;
        retriedIds.add(msg.id);
        pendingRequests.delete(msg.id);
        log.debug(
          "LSP retrying request %d after 'No Project' error [%s/%s]",
          msg.id,
          workspaceId,
          lang,
        );
        // Retry after a delay to give tsserver time to load the project.
        setTimeout(() => forwardToStdin(originalRequest), RETRY_DELAY_MS);
        return; // Don't forward the error to the client yet
      }
      // Clean up tracking for completed requests
      if (msg.id != null) {
        pendingRequests.delete(msg.id);
        retriedIds.delete(msg.id);
      }
    } catch {
      // Not valid JSON or missing fields — forward as-is
    }

    if (ws.readyState === ws.OPEN) {
      ws.send(json);
    }
  });

  /** Drop this connection's documents, telling the server if it is still there. */
  let released = false;
  function release(): void {
    if (released) return;
    released = true;
    // Copied first: `forwardToStdin` removes each URI from `openDocuments`.
    for (const uri of [...openDocuments]) forwardToStdin(didCloseMessage(uri));
    if (serverDocuments.get(serverId)?.size === 0) serverDocuments.delete(serverId);
  }

  // Server output -> WebSocket. The stream ends when the server exits or
  // this connection closes.
  void (async () => {
    try {
      for await (const chunk of connection.output) parseFrame(Buffer.from(chunk));
    } catch (err) {
      log.warn("LSP output stream failed [%s/%s]: %s", workspaceId, lang, String(err));
    }
    // Server exit -> close WebSocket
    release();
    if (ws.readyState === ws.OPEN) {
      log.debug("LSP server exited, closing WebSocket");
      ws.close(1000, "Language server exited");
    }
  })();

  // Helper: forward a JSON message from the client to the language server
  function forwardToStdin(json: string): void {
    log.debug(
      "LSP stdin [%s/%s]: %s",
      workspaceId,
      lang,
      json.length > 200 ? `${json.slice(0, 200)}…` : json,
    );

    // Track requests (messages with an "id" field) so we can retry on
    // transient errors from the language server, and the documents this
    // connection holds open so they can be closed when it goes away.
    try {
      const msg = JSON.parse(json) as {
        id?: number;
        method?: string;
        params?: { textDocument?: { uri?: string } };
      };
      if (msg.id != null && msg.method) {
        pendingRequests.set(msg.id, json);
      }
      const uri = msg.params?.textDocument?.uri;
      if (
        uri &&
        (msg.method === "textDocument/didOpen" || msg.method === "textDocument/didClose") &&
        !trackDocument(msg.method, uri)
      ) {
        return;
      }
    } catch {
      // Not valid JSON — forward as-is
    }

    writeToStdin(json);
  }

  function writeToStdin(json: string): void {
    connection.write(frameMessage(json));
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
    release();
    connection.close();
    log.debug("LSP client disconnected: %s/%s (server kept alive)", workspaceId, lang);
  });
}
