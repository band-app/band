// Regression coverage for issue #430 ("DiffView shows 'Unexpected end of JSON
// input' on branches with many changes").
//
// Root cause: `httpBatchLink` in `src/lib/trpc-client.ts` was configured
// without `maxURLLength`, so its default cap is `Infinity`. DiffView fires
// one `workspace.getFileDiff` query per expanded file on every SSE
// `branch-status` tick. On branches with many changed files, all of those
// queries collapse into a single GET whose URL encodes every batched op's
// `workspaceId` + `filePath` + `mergeBase` (40-char SHA). Past Node's default
// 16 KiB header limit the server returns 431 with an empty body and the
// batch link's `response.json()` blows up with "Unexpected end of JSON
// input", failing every op in the batch.
//
// Fix: pass `maxURLLength: 2000` to `httpBatchLink`. tRPC's batch link then
// splits over-long batches into multiple smaller GETs that each stay well
// under the header limit.
//
// This test exercises the real production server with a real tRPC client
// configured exactly like `src/lib/trpc-client.ts` and fires N parallel
// `workspace.getFileDiff` queries — N picked high enough that, without the
// fix, the single batched GET would exceed Node's default
// `--max-http-header-size` of 16 KiB. With the fix, the batch link splits the
// requests into multiple smaller GETs, so every query resolves with a
// `{ diff }` shape instead of rejecting on a parse error.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppRouter } from "../src/trpc/router";
import { seedSettings, seedState } from "./helpers/seed-state";
import { SERVER_RUNTIME, SERVER_SCRIPT } from "./helpers/server-runtime";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const DEFAULT_TOKEN = "trpc-batch-url-token";

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-trpc-batch-")));
  mkdirSync(join(tmp, ".band"), { recursive: true });
  return tmp;
}

function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function startServer(opts: { tmpHome: string }): Promise<ServerHandle> {
  const port = await getRandomPort();

  return new Promise((resolve, reject) => {
    const child = spawn(SERVER_RUNTIME, [SERVER_SCRIPT], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: opts.tmpHome,
        PORT: String(port),
        NODE_ENV: "production",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let settled = false;

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening") && !settled) {
        settled = true;
        resolve({
          url: `http://127.0.0.1:${port}`,
          home: opts.tmpHome,
          close: () =>
            new Promise<void>((r) => {
              child.on("exit", () => r());
              child.kill("SIGTERM");
            }),
        });
      }
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Server exited with code ${code} before listening.\nstderr: ${stderr}`));
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`Server did not start within 15 s.\nstderr: ${stderr}`));
      }
    }, 15_000);
  });
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8" });
}

// Match the production tRPC client configuration in `src/lib/trpc-client.ts`
// as closely as possible — same link, same `maxURLLength`. We omit the
// `wsLink` half of the production `splitLink` because this test only exercises
// queries (no subscriptions) and the WS client there requires a browser
// `location` global that doesn't exist in Node.
function createBatchClient(serverUrl: string) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${serverUrl}/trpc`,
        maxURLLength: 2000,
        headers: { Cookie: `band_token=${DEFAULT_TOKEN}` },
      }),
    ],
  });
}

// Long path components produce realistic per-op payloads. Each filePath is
// ~70 chars, mirroring real-world monorepo paths like
// `packages/dashboard-core/src/components/file-browser/SomeComponent.tsx`.
function buildFilePath(i: number): string {
  const idx = String(i).padStart(3, "0");
  return `packages/dashboard-core/src/components/file-browser/changed-file-${idx}.ts`;
}

describe("tRPC — batch URL splitting (#430)", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repoPath: string;
  let workspaceId: string;
  let mergeBase: string;

  // High enough that, without `maxURLLength`, the single batched GET URL
  // comfortably exceeds Node's default 16 KiB header limit (each batched op
  // carries a ~70-char path, a ~40-char SHA and a workspaceId; the URL-encoded
  // JSON input + the comma-separated procedure list together push past 16 KiB
  // somewhere around N=75). 100 keeps the test fast while leaving a wide
  // safety margin so transient overhead can't mask the regression.
  const FILE_COUNT = 100;

  beforeAll(async () => {
    tmpHome = createTmpHome();

    // Seed a repo with one initial commit per changed file, so that the
    // branch's diff against `main` shows each file as either Added or
    // Modified — getFileDiff exercises the modified path through git.
    repoPath = join(tmpHome, "repo");
    mkdirSync(repoPath, { recursive: true });
    git(repoPath, ["init", "-b", "main"]);
    mkdirSync(join(repoPath, "packages/dashboard-core/src/components/file-browser"), {
      recursive: true,
    });
    for (let i = 0; i < FILE_COUNT; i++) {
      writeFileSync(join(repoPath, buildFilePath(i)), `// original content for file ${i}\n`);
    }
    writeFileSync(join(repoPath, "README.md"), "# repo\n");
    git(repoPath, ["add", "."]);
    git(repoPath, ["commit", "-m", "initial commit"]);

    seedState(tmpHome, {
      projects: [
        {
          name: "repo",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoPath }],
        },
      ],
    });
    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      worktreesDir: join(tmpHome, ".band", "worktrees"),
    });
    server = await startServer({ tmpHome });

    // Create a feature workspace and modify every file on the branch so
    // each one will appear in the diff against the merge-base with main.
    const client = createBatchClient(server.url);
    const createRes = await client.workspaces.create.mutate({
      project: "repo",
      branch: "many-files",
    });
    const wtPath = createRes.path;

    for (let i = 0; i < FILE_COUNT; i++) {
      writeFileSync(join(wtPath, buildFilePath(i)), `// modified content for file ${i}\n`);
    }
    git(wtPath, ["add", "."]);
    git(wtPath, ["commit", "-m", "modify every file"]);

    workspaceId = "repo-many-files";
    // `getDiffSummary` is the procedure DiffView itself uses to discover
    // the merge-base + per-file statuses before fanning out a
    // `getFileDiff` query per expanded file, so use it here too.
    const diffRes = await client.workspace.getDiffSummary.query({
      workspaceId,
      diffMode: "branch",
    });
    mergeBase = diffRes.mergeBase;

    // Sanity check the fixture: every file we plan to query must actually
    // show up in the diff, otherwise the test wouldn't be reproducing the
    // DiffView scenario at all.
    expect(Object.keys(diffRes.fileStatuses).length).toBeGreaterThanOrEqual(FILE_COUNT);
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it(`resolves ${FILE_COUNT} parallel getFileDiff queries through the batch link`, async () => {
    // Reproduces DiffView's behavior on a branch with many expanded files:
    // every file panel fires `getFileDiff` simultaneously, and they all
    // collapse into batched GETs through `httpBatchLink`.
    const client = createBatchClient(server.url);

    const results = await Promise.all(
      Array.from({ length: FILE_COUNT }, (_, i) =>
        client.workspace.getFileDiff.query({
          workspaceId,
          filePath: buildFilePath(i),
          mergeBase,
        }),
      ),
    );

    // Each query must resolve with the documented `{ diff: string }` shape.
    // Without the fix, every promise rejects with "Unexpected end of JSON
    // input" because the over-sized batched GET returns an empty body.
    expect(results).toHaveLength(FILE_COUNT);
    for (let i = 0; i < FILE_COUNT; i++) {
      const { diff } = results[i];
      expect(typeof diff).toBe("string");
      // The diff for file N must mention that file's path — proves the
      // batch link routed inputs to the right ops after splitting.
      expect(diff).toContain(buildFilePath(i));
    }
  });
});
