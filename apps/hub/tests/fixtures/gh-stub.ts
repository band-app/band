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
  fields: Record<string, string | string[]>;
  flags: Record<string, string | true>;
  /** The JSON body given with `--input -`, if any. */
  input?: unknown;
  cwd: string;
  env: { GH_PROMPT_DISABLED: string | null };
}

export interface CheckRunStub {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: string | null;
  html_url?: string;
  head_sha?: string;
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
  /**
   * Answer the branch-status poller's batched CI query
   * (`buildBatchedCIQuery`, one `ws_<n>: repository(...)` alias per
   * workspace). One registration answers the whole query: each alias of
   * `repo` gets `answer(branch)`, a `repository` object, and `null` when that
   * returns undefined; aliases of any other repository get `null`. Called
   * per request.
   */
  setBranchStatusQuery: (repo: RepoCoords, answer: (branch: string) => unknown) => void;
  /**
   * Answer `gh api repos/<repo>/hooks` (create a webhook). `stderr` makes it
   * fail the way `gh` does. Each call is in `requests`, with the JSON body in `input`.
   */
  setHookCreate: (repo: RepoCoords, opts?: { stderr?: string }) => void;
  /**
   * Answer the check-runs query for `sha` of `repo`. A function is called
   * per request, so a test can complete checks between deliveries.
   */
  setCheckRuns: (
    repo: RepoCoords,
    sha: string,
    runs: CheckRunStub[] | (() => CheckRunStub[]),
  ) => void;
  /**
   * Answer the subscription poller's PR activity query for `repo`
   * (`buildPrActivityQuery`, one `pr<n>: pullRequest(number: n)` alias per
   * PR). `answer(number)` is that alias's `pullRequest` object, `null` when it
   * returns undefined. Called per request, so a test can add comments between polls.
   */
  setPrActivityQuery: (repo: RepoCoords, answer: (number: number) => unknown) => void;
  /** Answer `gh api user` (the authenticated account) with this login. */
  setAuthUser: (login: string) => void;
  /** Answer `gh pr merge <number>`; `stderr` makes it fail. */
  setPrMerge: (
    number: number,
    opts?: { stderr?: string; onRequest?: (r: GhInvocation) => void },
  ) => void;
  stop: () => Promise<void>;
}

/**
 * One alias of the poller's batched query:
 * `ws_0: repository(owner: "o", name: "r") { owner { login } pullRequests(headRefName: "b"`.
 */
const BATCHED_ALIAS =
  /(ws_\d+): repository\(owner: "([^"]*)", name: "([^"]*)"\) \{[^(]*pullRequests\(headRefName: "([^"]*)"/g;

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
      setBranchStatusQuery(repo, answer) {
        app.post("/api/graphql", (req, res, next) => {
          const rawQuery = (req.body as GhInvocation).fields.query;
          const query = typeof rawQuery === "string" ? rawQuery : "";
          const aliases = [...query.matchAll(BATCHED_ALIAS)];
          if (aliases.length === 0) {
            next();
            return;
          }
          const data: Record<string, unknown> = {};
          for (const [, alias, owner, name, branch] of aliases) {
            data[alias] =
              owner === repo.owner && name === repo.name ? (answer(branch) ?? null) : null;
          }
          res.json({ stdout: JSON.stringify({ data }) });
        });
      },
      setHookCreate(repo, opts) {
        app.post("/api/:endpoint", (req, res, next) => {
          if (req.params.endpoint !== `repos/${repo.owner}/${repo.name}/hooks`) {
            next();
            return;
          }
          res.json(
            opts?.stderr
              ? { stdout: "", stderr: opts.stderr, exitCode: 1 }
              : { stdout: JSON.stringify({ id: 1, active: true }) },
          );
        });
      },
      setCheckRuns(repo, sha, runs) {
        app.post("/api/:endpoint", (req, res, next) => {
          const endpoint = req.params.endpoint.split("?")[0];
          if (endpoint !== `repos/${repo.owner}/${repo.name}/commits/${sha}/check-runs`) {
            next();
            return;
          }
          const list = typeof runs === "function" ? runs() : runs;
          // Pages the way the REST endpoint does: `per_page` and `page` in the query.
          const query = new URLSearchParams(req.params.endpoint.split("?")[1] ?? "");
          const perPage = Number(query.get("per_page") ?? 30);
          const page = Number(query.get("page") ?? 1);
          const slice = list.slice((page - 1) * perPage, page * perPage);
          res.json({
            stdout: JSON.stringify({ total_count: list.length, check_runs: slice }),
          });
        });
      },
      setPrActivityQuery(repo, answer) {
        app.post("/api/graphql", (req, res, next) => {
          const rawQuery = (req.body as GhInvocation).fields.query;
          const query = typeof rawQuery === "string" ? rawQuery : "";
          const header = `repository(owner: "${repo.owner}", name: "${repo.name}")`;
          if (!query.includes(header)) {
            next();
            return;
          }
          const repository: Record<string, unknown> = {};
          for (const [, number] of query.matchAll(/pr(\d+): pullRequest/g)) {
            repository[`pr${number}`] = answer(Number(number)) ?? null;
          }
          res.json({ stdout: JSON.stringify({ data: { repository } }) });
        });
      },
      setAuthUser(login) {
        app.post("/api/user", (_req, res) => {
          res.json({ stdout: JSON.stringify({ login }) });
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
