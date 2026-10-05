// A real MCP server (the TS SDK's McpServer over streamable HTTP, stateless like the hub's own /mcp) for
// the MCP proxy tests. It checks the credential on every request with `authorize`, records the headers and
// the tool calls it saw, and offers one tool (`slow`) that streams a progress notification and then waits
// for the test to release it, so a test can prove the proxy streams instead of buffering.

import type { Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

export interface McpStubRequest {
  method: string;
  headers: Record<string, string>;
  /** JSON-RPC methods in the body, for a POST. */
  rpc: string[];
}

export interface McpStub {
  /** The server's MCP endpoint: `<origin>/mcp`. */
  url: string;
  requests: McpStubRequest[];
  /** Tool names the server actually ran, in order. */
  calls: string[];
  /** Lets a pending `slow` call finish. */
  release: () => void;
  /** Resolves when a `slow` call has sent its progress notification and is waiting. */
  slowWaiting: () => Promise<void>;
  close: () => Promise<void>;
}

export interface McpStubOptions {
  /** Whether a request's headers carry an acceptable credential. */
  authorize: (headers: Record<string, string | string[] | undefined>) => boolean;
  /** Answer POSTs as one JSON body instead of an SSE stream. */
  json?: boolean;
}

export async function startMcpStub(opts: McpStubOptions): Promise<McpStub> {
  const requests: McpStubRequest[] = [];
  const calls: string[] = [];
  let release: () => void = () => undefined;
  let slowReady: () => void = () => undefined;
  let slowPromise = new Promise<void>((resolve) => {
    slowReady = resolve;
  });
  let origin = "";

  function buildServer(): McpServer {
    const server = new McpServer({ name: "mcp-stub", version: "1.0.0" });
    server.registerTool(
      "echo",
      {
        description: "Returns its input",
        inputSchema: { text: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ text }) => {
        calls.push("echo");
        return { content: [{ type: "text" as const, text: `echo:${text}` }] };
      },
    );
    server.registerTool(
      "add",
      {
        description: "Adds two numbers",
        inputSchema: { a: z.number(), b: z.number() },
        annotations: { readOnlyHint: true },
      },
      async ({ a, b }) => {
        calls.push("add");
        return { content: [{ type: "text" as const, text: String(a + b) }] };
      },
    );
    server.registerTool(
      "write_note",
      {
        description: "Writes a note",
        inputSchema: { text: z.string() },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async ({ text }) => {
        calls.push("write_note");
        return { content: [{ type: "text" as const, text: `wrote:${text}` }] };
      },
    );
    server.registerTool(
      "wipe",
      { description: "Has no annotations, so it is not known to be read-only" },
      async () => {
        calls.push("wipe");
        return { content: [{ type: "text" as const, text: "wiped" }] };
      },
    );
    server.registerTool("boom", { description: "Always fails" }, async () => {
      calls.push("boom");
      return { content: [{ type: "text" as const, text: "failed" }], isError: true };
    });
    server.registerTool(
      "slow",
      { description: "Streams, then waits", inputSchema: { note: z.string().optional() } },
      async (_args, extra) => {
        calls.push("slow");
        const token = extra._meta?.progressToken;
        if (token !== undefined) {
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken: token, progress: 1, total: 2 },
          });
        }
        slowReady();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { content: [{ type: "text" as const, text: "slow done" }] };
      },
    );
    return server;
  }

  const app = express();
  app.use(express.json());
  app.all("/mcp", async (req, res) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers[name] = value;
    }
    const body = req.body as unknown;
    const messages = Array.isArray(body) ? body : body ? [body] : [];
    requests.push({
      method: req.method,
      headers,
      rpc: messages.map((m) => String((m as { method?: unknown }).method)),
    });
    if (!opts.authorize(req.headers)) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
      return;
    }
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: opts.json ?? false,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  const http: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  origin = `http://127.0.0.1:${address.port}`;

  return {
    url: `${origin}/mcp`,
    requests,
    calls,
    release: () => {
      release();
      slowPromise = new Promise<void>((resolve) => {
        slowReady = resolve;
      });
    },
    slowWaiting: () => slowPromise,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
