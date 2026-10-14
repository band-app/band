/**
 * Stand-in for the Claude and Codex usage endpoints. The hub reads their URLs
 * from `BAND_CLAUDE_USAGE_URL` and `BAND_CODEX_USAGE_URL` on every request.
 * `claude` is the JSON body served to the Claude token, `claudeRequests` counts
 * the requests that reached it.
 */

import { createServer, type Server } from "node:http";

export interface UsageStub {
  claudeUrl: string;
  codexUrl: string;
  /** Replaces the body the Claude endpoint serves. */
  setClaude: (body: unknown) => void;
  claudeRequests: () => number;
  close: () => Promise<void>;
}

export async function startUsageStub(initialClaude: unknown, codex: unknown): Promise<UsageStub> {
  let claude = initialClaude;
  let claudeRequests = 0;
  const server: Server = createServer((req, res) => {
    const body = req.url?.startsWith("/claude")
      ? claude
      : req.url?.startsWith("/codex")
        ? codex
        : null;
    if (req.url?.startsWith("/claude")) claudeRequests++;
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    claudeUrl: `http://127.0.0.1:${port}/claude`,
    codexUrl: `http://127.0.0.1:${port}/codex`,
    setClaude: (body) => {
      claude = body;
    },
    claudeRequests: () => claudeRequests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
