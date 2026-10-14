// Express stub for the Claude and Codex usage endpoints. The hub and the workers call it through
// `BAND_CLAUDE_USAGE_URL` and `BAND_CODEX_USAGE_URL`, which they read on every request. The bearer
// token picks the answer, so one stub serves several accounts.

import type { Server } from "node:http";
import express from "express";

export interface UsageStubAnswer {
  status: number;
  body?: unknown;
}

export interface UsageStub {
  claudeUrl: string;
  codexUrl: string;
  /** Bearer tokens of every request, in order, per provider. */
  requests: { claude: string[]; codex: string[] };
  /** Headers of the last Codex request. */
  lastCodexHeaders: () => Record<string, string | string[] | undefined>;
  close: () => Promise<void>;
}

export async function startUsageStub(answers: {
  claude: Record<string, UsageStubAnswer>;
  codex: Record<string, UsageStubAnswer>;
}): Promise<UsageStub> {
  const requests = { claude: [] as string[], codex: [] as string[] };
  let codexHeaders: Record<string, string | string[] | undefined> = {};
  const app = express();
  for (const provider of ["claude", "codex"] as const) {
    app.get(`/${provider}`, (req, res) => {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      requests[provider].push(token);
      if (provider === "codex") codexHeaders = req.headers;
      const answer = answers[provider][token];
      if (!answer) {
        res.status(401).json({ error: { message: "unknown token" } });
        return;
      }
      res.status(answer.status).json(answer.body ?? {});
    });
  }
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  return {
    claudeUrl: `http://127.0.0.1:${port}/claude`,
    codexUrl: `http://127.0.0.1:${port}/codex`,
    requests,
    lastCodexHeaders: () => codexHeaders,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
