// Express stub for the `gh` CLI. The server runs `gh` as a subprocess, so the
// seam is the binary: `BAND_GH_BIN` points the GitHub plugin at
// `gh-stub-bin.mjs`, which forwards every invocation here over HTTP. Both
// variables are read at call time. Shared by backend tests and e2e specs.

import { chmodSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import express, { type Request } from "express";

/** Absolute path to the fake `gh` executable. */
const GH_STUB_BIN = join(import.meta.dirname, "gh-stub-bin.mjs");

/** One `gh` invocation, as `gh-stub-bin.mjs` parsed it. */
export interface GhInvocation {
  args: string[];
  positional: string[];
  fields: Record<string, string>;
  flags: Record<string, string | true>;
  cwd: string;
  env: { GH_PROMPT_DISABLED: string | null };
}

export interface RepoCoords {
  owner: string;
  name: string;
}

export interface GhStub {
  /** Pass to `startServer({ env })`. */
  env: Record<string, string>;
  /** Every `gh` invocation the server made, answered or not, in order. */
  requests: GhInvocation[];
  /**
   * Answer the GitHub plugin's review query for `branch` of `repo` with
   * `data` (the GraphQL `data` object). A function is called per request,
   * so a test can change the answer between lookups.
   */
  setReviewQuery: (
    repo: RepoCoords,
    branch: string,
    data: unknown | (() => unknown),
    opts?: { onRequest?: (r: GhInvocation) => void },
  ) => void;
  /** Fail the review query for `branch` the way `gh` does: stderr and exit 1. */
  setReviewQueryError: (repo: RepoCoords, branch: string, stderr: string) => void;
  /** Answer `gh pr merge <number>`; `stderr` makes it fail. */
  setPrMerge: (
    number: number,
    opts?: { stderr?: string; onRequest?: (r: GhInvocation) => void },
  ) => void;
  stop: () => Promise<void>;
}

/** Whether a `gh api graphql` call is the review query for `branch` of `repo`. */
function isReviewQuery(req: Request, repo: RepoCoords, branch: string): boolean {
  const { fields } = req.body as GhInvocation;
  return fields.owner === repo.owner && fields.name === repo.name && fields.branch === branch;
}

export const ghStub = {
  async start(): Promise<GhStub> {
    // Git keeps the executable bit, but a checkout with `core.fileMode=false`
    // or a copy can drop it, and the server exec()s the file directly.
    chmodSync(GH_STUB_BIN, 0o755);
    const app = express();
    app.use(express.json({ limit: "5mb" }));
    const requests: GhInvocation[] = [];
    app.use((req, _res, next) => {
      requests.push(req.body as GhInvocation);
      next();
    });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    return {
      env: { BAND_GH_BIN: GH_STUB_BIN, BAND_GH_STUB_URL: baseUrl },
      requests,
      setReviewQuery(repo, branch, data, opts) {
        app.post("/api/graphql", (req, res, next) => {
          if (!isReviewQuery(req, repo, branch)) {
            next();
            return;
          }
          opts?.onRequest?.(req.body as GhInvocation);
          const answer = typeof data === "function" ? data() : data;
          res.json({ stdout: JSON.stringify({ data: answer }) });
        });
      },
      setReviewQueryError(repo, branch, stderr) {
        app.post("/api/graphql", (req, res, next) => {
          if (!isReviewQuery(req, repo, branch)) {
            next();
            return;
          }
          res.json({ stdout: "", stderr, exitCode: 1 });
        });
      },
      setPrMerge(number, opts) {
        app.post("/pr/merge", (req, res, next) => {
          const body = req.body as GhInvocation;
          if (body.positional[2] !== String(number)) {
            next();
            return;
          }
          opts?.onRequest?.(body);
          res.json(
            opts?.stderr
              ? { stdout: "", stderr: opts.stderr, exitCode: 1 }
              : { stdout: `✓ Merged pull request #${number}\n` },
          );
        });
      },
      stop: () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
    };
  },
};
