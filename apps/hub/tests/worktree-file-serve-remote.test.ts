// Integration test for `GET /api/worktree-file/<worktreeId>/<path>` when the
// worktree lives on a remote worker. A real `band-worker` dials a real hub, and
// the route streams the file through the worker link. The bytes (NUL and high
// bytes, so any text decoding corrupts them) must arrive unchanged for a PNG
// under a git-excluded dot folder, a PNG in a tracked folder and a PDF, with
// the token in a cookie or in the query string (how an <img> authenticates
// against a hub on another origin). A request without a valid token gets 401.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "worktree-file-serve-remote-token";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x00, 0x80,
]);
const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from([0x00, 0xff, 0xc3, 0x28])]);

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

function makeRepo(dir: string): void {
  mkdirSync(join(dir, "assets"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "assets", "tracked.png"), PNG_BYTES);
  writeFileSync(join(dir, "assets", "doc.pdf"), PDF_BYTES);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

describe("GET /api/worktree-file for a worktree on a remote worker", () => {
  let hubHome: string;
  let server: ServerHandle;
  let worker: ChildProcess | undefined;
  let worktreeId: string;

  const get = (path: string, init: { cookie?: string; query?: string } = {}) =>
    fetch(
      `${server.url}/api/worktree-file/${encodeURIComponent(worktreeId)}/${path}${init.query ?? ""}`,
      {
        headers: init.cookie === undefined ? {} : { Cookie: `band_token=${init.cookie}` },
      },
    );

  beforeAll(async () => {
    hubHome = createTmpHome("band-wtfile-remote-hub-");
    scratch.push(hubHome);
    const workerRoot = tmp("band-wtfile-remote-root-");
    const workerState = tmp("band-wtfile-remote-state-");
    const workerHome = tmp("band-wtfile-remote-whome-");
    const hubRepo = join(tmp("band-wtfile-remote-hubrepo-"), "proj");
    makeRepo(hubRepo);
    makeRepo(join(workerRoot, "proj"));
    seedSettings(hubHome, { tokenSecret: TOKEN });
    seedState(hubHome, {
      repos: [
        {
          name: "proj",
          path: hubRepo,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: hubRepo }],
        },
      ],
    });
    server = await startServer({ tmpHome: hubHome });

    const { token, hostId } = await trpcData<{ token: string; hostId: string }>(
      await trpcMutate(
        server.url,
        "tokens.issueWorkerBootstrap",
        { hostName: "W", labels: [] },
        TOKEN,
      ),
    );
    worktreeId = toWorktreeId("proj", "img-feat", hostId);

    worker = spawn(
      process.execPath,
      [
        WORKER_BIN,
        "--hub",
        server.url,
        "--token",
        token,
        "--worker-id",
        hostId,
        "--root",
        workerRoot,
        "--state-dir",
        workerState,
      ],
      {
        env: { ...process.env, HOME: workerHome, BAND_HOME: join(workerHome, ".band") },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let workerOutput = "";
    worker.stdout?.on("data", (d) => {
      workerOutput += d;
    });
    worker.stderr?.on("data", (d) => {
      workerOutput += d;
    });
    await waitFor(
      async () => {
        const res = await trpcQuery(server.url, "hosts.list", undefined, TOKEN);
        const { hosts } = await trpcData<{ hosts: Array<{ id: string; status: string }> }>(res);
        return hosts.find((h) => h.id === hostId)?.status === "online" ? true : undefined;
      },
      { label: "worker online", timeoutMs: 15_000 },
    ).catch((err) => {
      throw new Error(`${err.message}\n${workerOutput}`);
    });

    const created = await trpcData<{ path: string }>(
      await trpcMutate(
        server.url,
        "worktrees.create",
        { repo: "proj", branch: "img-feat", hostId, hostRepoPath: join(workerRoot, "proj") },
        TOKEN,
      ),
    );
    // A PNG under a dot folder that git excludes, like `.am/evidence/x.png`.
    const excludeFile = git(created.path, "rev-parse", "--git-path", "info/exclude").trim();
    mkdirSync(join(created.path, ".am", "evidence"), { recursive: true });
    writeFileSync(join(created.path, ".am", "evidence", "x.png"), PNG_BYTES);
    appendFileSync(resolve(created.path, excludeFile), "\n.am/\n");
  }, 120_000);

  afterAll(async () => {
    worker?.kill("SIGKILL");
    await server?.close();
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  it.each([
    ["a PNG under a git-excluded dot folder", ".am/evidence/x.png", "image/png", PNG_BYTES],
    ["a PNG in a tracked folder", "assets/tracked.png", "image/png", PNG_BYTES],
    ["a PDF", "assets/doc.pdf", "application/pdf", PDF_BYTES],
  ])("serves %s with exact bytes", async (_name, path, type, bytes) => {
    const res = await get(path, { cookie: TOKEN });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(type);
    expect(res.headers.get("content-length")).toBe(String(bytes.length));
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it("serves the file when the token is in the query string", async () => {
    const res = await get(".am/evidence/x.png", { query: `?token=${TOKEN}` });

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
  });

  it("refuses a request without a token or with a wrong one", async () => {
    expect((await get(".am/evidence/x.png")).status).toBe(401);
    expect((await get(".am/evidence/x.png", { cookie: "wrong" })).status).toBe(401);
    expect((await get(".am/evidence/x.png", { query: "?token=wrong" })).status).toBe(401);
  });
});
