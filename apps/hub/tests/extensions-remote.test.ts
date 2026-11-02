// Integration test for the extension editor's file routes when the worktree lives on a remote
// worker: `GET` and `PUT /api/worktree-file/...` go through the worker link, and the bytes written
// are read back through `host.fs` (the worktree route) exactly.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { WORKER_BIN } from "./helpers/worker-bin";

const TOKEN = "extensions-remote-token";
const BINARY = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x80, 0x00, 0x01]);

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
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
  mkdirSync(join(dir, "docs"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "docs", "book.xlsx"), Buffer.from([9, 9, 9]));
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

describe("extension editor file routes for a worktree on a remote worker", () => {
  let hubHome: string;
  let server: ServerHandle;
  let worker: ChildProcess | undefined;
  let worktreeId: string;
  let worktreePath: string;

  const url = (path: string) =>
    `${server.url}/api/worktree-file/${encodeURIComponent(worktreeId)}/${path}`;
  const auth = { Cookie: `band_token=${TOKEN}` };

  beforeAll(async () => {
    hubHome = createTmpHome("band-ext-remote-hub-");
    scratch.push(hubHome);
    const workerRoot = tmp("band-ext-remote-root-");
    const workerState = tmp("band-ext-remote-state-");
    const workerHome = tmp("band-ext-remote-whome-");
    const hubRepo = join(tmp("band-ext-remote-hubrepo-"), "proj");
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
    worktreeId = toWorktreeId("proj", "ext-feat", hostId);
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
    let output = "";
    worker.stdout?.on("data", (d) => {
      output += d;
    });
    worker.stderr?.on("data", (d) => {
      output += d;
    });
    await waitFor(
      async () => {
        const res = await trpcQuery(server.url, "hosts.list", undefined, TOKEN);
        const { hosts } = await trpcData<{ hosts: Array<{ id: string; status: string }> }>(res);
        return hosts.find((h) => h.id === hostId)?.status === "online" ? true : undefined;
      },
      { label: "worker online", timeoutMs: 15_000 },
    ).catch((err) => {
      throw new Error(`${err.message}\n${output}`);
    });
    const created = await trpcData<{ path: string }>(
      await trpcMutate(
        server.url,
        "worktrees.create",
        { repo: "proj", branch: "ext-feat", hostId, hostRepoPath: join(workerRoot, "proj") },
        TOKEN,
      ),
    );
    worktreePath = created.path;
  }, 120_000);

  afterAll(async () => {
    worker?.kill("SIGKILL");
    await server?.close();
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  it("reads the file, saves new bytes on the worker and reads them back", async () => {
    const before = await fetch(url("docs/book.xlsx"), { headers: auth });
    expect(before.status).toBe(200);
    expect(Buffer.from(await before.arrayBuffer()).equals(Buffer.from([9, 9, 9]))).toBe(true);

    const saved = await fetch(url("docs/book.xlsx"), {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/octet-stream" },
      body: BINARY,
    });
    expect(saved.status).toBe(204);

    // The bytes are on the worker's disk (this test shares the machine), and the GET route
    // streams them back through the worker link.
    expect(readFileSync(join(worktreePath, "docs", "book.xlsx")).equals(BINARY)).toBe(true);
    const after = await fetch(url("docs/book.xlsx"), { headers: auth });
    expect(Buffer.from(await after.arrayBuffer()).equals(BINARY)).toBe(true);
  });

  it("refuses a path outside the worktree and a missing file", async () => {
    const outside = await fetch(url("..%2F..%2Fescape.txt"), {
      method: "PUT",
      headers: auth,
      body: "x",
    });
    expect(outside.status).toBe(400);

    const missing = await fetch(url("docs/missing.xlsx"), {
      method: "PUT",
      headers: auth,
      body: "x",
    });
    expect(missing.status).toBe(404);
  });
});
