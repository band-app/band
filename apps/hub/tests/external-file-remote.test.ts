// Integration test for files outside a worktree (`band open /abs/path`, Open File) when the
// worktree lives on a remote worker: `worktree.readExternalFile` and `saveExternalFile` go through
// the worker link and the worker's own path policy, never the hub's disk.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  let workerHomeDir: string;
  let secondRootDir: string;

  beforeAll(async () => {
    hubHome = createTmpHome("band-ext-remote-hub-");
    scratch.push(hubHome);
    const workerRoot = tmp("band-extfile-remote-root-");
    workerRootDir = workerRoot;
    const workerState = tmp("band-ext-remote-state-");
    const workerHome = tmp("band-ext-remote-whome-");
    workerHomeDir = workerHome;
    secondRootDir = tmp("band-ext-remote-root2-");
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
        "--root",
        secondRootDir,
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
      { label: "worker online", timeoutMs: 30_000 },
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

  it("opens, reads and saves a file in the worker user's home, outside every root", async () => {
    const dotfile = join(workerHomeDir, ".claude", "settings.json");
    mkdirSync(join(workerHomeDir, ".claude"), { recursive: true });
    writeFileSync(dotfile, '{"a":1}\n');

    const opened = await trpcMutate(
      server.url,
      "editor.openFile",
      { worktreeId, filePath: dotfile, focus: false },
      TOKEN,
    );
    expect(opened.status).toBe(200);
    expect(await trpcData<{ external: boolean; filePath: string }>(opened)).toMatchObject({
      external: true,
      filePath: dotfile,
    });

    const read = await trpcQuery(
      server.url,
      "worktree.readExternalFile",
      { worktreeId, absolutePath: dotfile },
      TOKEN,
    );
    expect((await trpcData<{ content: string }>(read)).content).toBe('{"a":1}\n');
    const saved = await trpcMutate(
      server.url,
      "worktree.saveExternalFile",
      { worktreeId, absolutePath: dotfile, content: '{"a":2}\n' },
      TOKEN,
    );
    expect(saved.status).toBe(200);
    expect(readFileSync(dotfile, "utf-8")).toBe('{"a":2}\n');
  });

  it("opens a file in another root the worker serves", async () => {
    const file = join(secondRootDir, "README.md");
    writeFileSync(file, "# other root\n");
    const opened = await trpcMutate(
      server.url,
      "editor.openFile",
      { worktreeId, filePath: file, focus: false },
      TOKEN,
    );
    expect(opened.status).toBe(200);
    expect(await trpcData<{ external: boolean }>(opened)).toMatchObject({ external: true });
  });

  it("says why a path cannot be opened: missing, directory, unreadable", async () => {
    const open = async (filePath: string) => {
      const res = await trpcMutate(server.url, "editor.openFile", { worktreeId, filePath }, TOKEN);
      return { status: res.status, text: await res.text() };
    };
    const missing = await open(join(workerHomeDir, "nope.txt"));
    expect(missing.status).toBe(404);
    expect(missing.text).toMatch(/File not found/);

    const dir = await open(workerHomeDir);
    expect(dir.status).toBe(400);
    expect(dir.text).toMatch(/Not a regular file/);

    if (process.getuid?.() !== 0) {
      const locked = join(workerHomeDir, "locked.txt");
      writeFileSync(locked, "secret");
      chmodSync(locked, 0o000);
      const denied = await open(locked);
      expect(denied.status).toBe(400);
      expect(denied.text).toMatch(/Permission denied/);
      const read = await trpcQuery(
        server.url,
        "worktree.readExternalFile",
        { worktreeId, absolutePath: locked },
        TOKEN,
      );
      expect(await read.text()).toMatch(/Permission denied/);
    }
  });

  it("refuses to save over a symlink, a directory or a file that does not exist", async () => {
    const real = join(workerHomeDir, "real.txt");
    writeFileSync(real, "keep");
    const link = join(workerHomeDir, "link.txt");
    symlinkSync(real, link);
    for (const absolutePath of [link, workerHomeDir, join(workerHomeDir, "new.txt")]) {
      const res = await trpcMutate(
        server.url,
        "worktree.saveExternalFile",
        { worktreeId, absolutePath, content: "x" },
        TOKEN,
      );
      expect(res.status, absolutePath).toBe(500);
    }
    expect(readFileSync(real, "utf-8")).toBe("keep");
  });

  it("keeps an agent to the worker's folders: the same call with chat headers is refused", async () => {
    const file = join(workerHomeDir, "agent-target.txt");
    writeFileSync(file, "x");
    const res = await fetch(`${server.url}/trpc/editor.openFile`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `band_token=${TOKEN}`,
        "x-band-worktree-id": worktreeId,
        "x-band-chat-id": "chat-1",
      },
      body: JSON.stringify({ worktreeId, filePath: file }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Agents can only open files inside this worker's folders/);
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
