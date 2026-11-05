// Integration test for files outside a worktree (`band open /abs/path`, Open File) when the
// worktree lives on a remote worker: `worktree.readExternalFile` and `saveExternalFile` go through
// the worker link and the worker's own path policy, never the hub's disk.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
import { removeTmpHome } from "./helpers/tmp-home";
import { waitFor } from "./helpers/wait-for";
import { WORKER_BIN } from "./helpers/worker-bin";

const TOKEN = "external-file-remote-token";

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

describe("external files for a worktree on a remote worker", () => {
  let hubHome: string;
  let server: ServerHandle;
  let worker: ChildProcess | undefined;
  let worktreeId: string;

  let workerRootDir: string;

  beforeAll(async () => {
    hubHome = createTmpHome("band-ext-remote-hub-");
    scratch.push(hubHome);
    const workerRoot = tmp("band-extfile-remote-root-");
    workerRootDir = workerRoot;
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
    expect(created.path).not.toBe("");
  }, 120_000);

  afterAll(async () => {
    if (worker && worker.exitCode === null) {
      const exited = new Promise((resolve) => worker?.once("exit", resolve));
      worker.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      if (worker.exitCode === null) worker.kill("SIGKILL");
    }
    await server?.close();
    for (const dir of scratch) removeTmpHome(dir);
  });

  it("reads a file outside the worktree from the worker, saves it there and reads it back", async () => {
    const notes = join(workerRootDir, "notes.txt");
    writeFileSync(notes, "on the worker\n");

    const read = await trpcQuery(
      server.url,
      "worktree.readExternalFile",
      { worktreeId, absolutePath: notes },
      TOKEN,
    );
    expect(read.status).toBe(200);
    expect((await trpcData<{ content: string }>(read)).content).toBe("on the worker\n");

    const saved = await trpcMutate(
      server.url,
      "worktree.saveExternalFile",
      { worktreeId, absolutePath: notes, content: "edited in Band\n" },
      TOKEN,
    );
    expect(saved.status).toBe(200);
    expect(readFileSync(notes, "utf-8")).toBe("edited in Band\n");

    const again = await trpcQuery(
      server.url,
      "worktree.readExternalFile",
      { worktreeId, absolutePath: notes },
      TOKEN,
    );
    expect((await trpcData<{ content: string }>(again)).content).toBe("edited in Band\n");
  });

  it("applies the worker's path policy: a file outside its roots and home is refused", async () => {
    // /etc/hosts exists on this machine, which is also the hub's, and was readable through the
    // old hub route. Through the worker it lies outside the roots and the worker's home.
    const read = await trpcQuery(
      server.url,
      "worktree.readExternalFile",
      { worktreeId, absolutePath: "/etc/hosts" },
      TOKEN,
    );
    expect(read.status).toBe(500);
    expect(await read.text()).toMatch(/outside|allowed|root|permission|not allowed/i);
    const save = await trpcMutate(
      server.url,
      "worktree.saveExternalFile",
      { worktreeId, absolutePath: "/etc/hosts", content: "evil" },
      TOKEN,
    );
    expect(save.status).toBe(500);
    expect(readFileSync("/etc/hosts", "utf-8")).not.toBe("evil");
  });

  it("refuses a call with no device token", async () => {
    const read = await trpcQuery(
      server.url,
      "worktree.readExternalFile",
      { worktreeId, absolutePath: join(workerRootDir, "notes.txt") },
      "not-a-device-token",
    );
    expect(read.status).toBe(401);
    const save = await trpcMutate(
      server.url,
      "worktree.saveExternalFile",
      { worktreeId, absolutePath: join(workerRootDir, "notes.txt"), content: "x" },
      "not-a-device-token",
    );
    expect(save.status).toBe(401);
  });
});
