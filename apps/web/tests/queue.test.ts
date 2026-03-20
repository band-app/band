import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedState } from "./helpers/seed-state";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const DEFAULT_TOKEN = "queue-test-token";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-queue-test-")));
  const bandDir = join(tmp, ".band");
  mkdirSync(bandDir, { recursive: true });
  mkdirSync(join(bandDir, "status"), { recursive: true });
  return tmp;
}

function seedSettings(tmpHome: string, settings: object): void {
  writeFileSync(join(tmpHome, ".band", "settings.json"), JSON.stringify(settings));
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

async function startServer(
  opts: { tmpHome?: string; env?: Record<string, string> } = {},
): Promise<ServerHandle> {
  const home = opts.tmpHome || createTmpHome();
  const port = await getRandomPort();

  return new Promise((resolve, reject) => {
    const child = spawn("node", ["dist/start-server.mjs"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: home,
        PORT: String(port),
        NODE_ENV: "production",
        ...opts.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let settled = false;

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.includes("listening") && !settled) {
        settled = true;
        resolve({
          url: `http://127.0.0.1:${port}`,
          home,
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

// ---------------------------------------------------------------------------
// tRPC HTTP helpers
// ---------------------------------------------------------------------------

const defaultHeaders = { Cookie: `band_token=${DEFAULT_TOKEN}` };

async function trpcQuery(serverUrl: string, procedure: string, input?: unknown) {
  const url =
    input !== undefined
      ? `${serverUrl}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`
      : `${serverUrl}/trpc/${procedure}`;
  return fetch(url, { headers: defaultHeaders });
}

async function trpcMutate(serverUrl: string, procedure: string, input?: unknown) {
  return fetch(`${serverUrl}/trpc/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...defaultHeaders },
    body: input !== undefined ? JSON.stringify(input) : "{}",
  });
}

async function trpcData<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

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

function createGitRepo(parentDir: string, name: string): string {
  const repoPath = join(parentDir, name);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", "main"]);
  writeFileSync(join(repoPath, "README.md"), "# Test\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "init"]);
  return repoPath;
}

// ---------------------------------------------------------------------------
// queue.push / queue.set / queue.get / queue.clear — CRUD
// ---------------------------------------------------------------------------

describe("tRPC — queue CRUD", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    const repo = createGitRepo(tmpHome, "proj");

    seedState(tmpHome, {
      projects: [
        {
          name: "proj",
          path: repo,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repo }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns empty array when no queued messages exist", async () => {
    const res = await trpcQuery(server.url, "queue.get", { workspaceId: "proj-main" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ messages: string[] }>(res);
    expect(data.messages).toEqual([]);
  });

  it("pushes a single queued message via queue.push", async () => {
    const res = await trpcMutate(server.url, "queue.push", {
      workspaceId: "proj-main",
      text: "fix the bug",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean }>(res);
    expect(data.ok).toBe(true);

    const getRes = await trpcQuery(server.url, "queue.get", { workspaceId: "proj-main" });
    const getData = await trpcData<{ messages: string[] }>(getRes);
    expect(getData.messages).toEqual(["fix the bug"]);
  });

  it("pushes multiple messages and preserves order", async () => {
    await trpcMutate(server.url, "queue.push", {
      workspaceId: "proj-main",
      text: "add tests",
    });
    await trpcMutate(server.url, "queue.push", {
      workspaceId: "proj-main",
      text: "update docs",
    });

    const res = await trpcQuery(server.url, "queue.get", { workspaceId: "proj-main" });
    const data = await trpcData<{ messages: string[] }>(res);
    expect(data.messages).toEqual(["fix the bug", "add tests", "update docs"]);
  });

  it("replaces the entire queue via queue.set", async () => {
    const res = await trpcMutate(server.url, "queue.set", {
      workspaceId: "proj-main",
      messages: ["new first", "new second"],
    });
    expect(res.status).toBe(200);

    const getRes = await trpcQuery(server.url, "queue.get", { workspaceId: "proj-main" });
    const getData = await trpcData<{ messages: string[] }>(getRes);
    expect(getData.messages).toEqual(["new first", "new second"]);
  });

  it("queue.set with empty array clears the queue", async () => {
    await trpcMutate(server.url, "queue.set", {
      workspaceId: "proj-main",
      messages: [],
    });

    const res = await trpcQuery(server.url, "queue.get", { workspaceId: "proj-main" });
    const data = await trpcData<{ messages: string[] }>(res);
    expect(data.messages).toEqual([]);
  });

  it("removes a single message by value via queue.remove", async () => {
    // Seed: a, b, c
    await trpcMutate(server.url, "queue.clear", { workspaceId: "proj-main" });
    await trpcMutate(server.url, "queue.push", { workspaceId: "proj-main", text: "a" });
    await trpcMutate(server.url, "queue.push", { workspaceId: "proj-main", text: "b" });
    await trpcMutate(server.url, "queue.push", { workspaceId: "proj-main", text: "c" });

    const res = await trpcMutate(server.url, "queue.remove", {
      workspaceId: "proj-main",
      text: "b",
    });
    expect(res.status).toBe(200);

    const getRes = await trpcQuery(server.url, "queue.get", { workspaceId: "proj-main" });
    const getData = await trpcData<{ messages: string[] }>(getRes);
    expect(getData.messages).toEqual(["a", "c"]);

    // cleanup
    await trpcMutate(server.url, "queue.clear", { workspaceId: "proj-main" });
  });

  it("queue.remove only removes the first occurrence of a duplicate", async () => {
    await trpcMutate(server.url, "queue.push", { workspaceId: "proj-main", text: "dup" });
    await trpcMutate(server.url, "queue.push", { workspaceId: "proj-main", text: "dup" });

    await trpcMutate(server.url, "queue.remove", { workspaceId: "proj-main", text: "dup" });

    const getRes = await trpcQuery(server.url, "queue.get", { workspaceId: "proj-main" });
    const getData = await trpcData<{ messages: string[] }>(getRes);
    expect(getData.messages).toEqual(["dup"]);

    // cleanup
    await trpcMutate(server.url, "queue.clear", { workspaceId: "proj-main" });
  });

  it("clears all queued messages via queue.clear", async () => {
    // Seed some messages first
    await trpcMutate(server.url, "queue.push", { workspaceId: "proj-main", text: "a" });
    await trpcMutate(server.url, "queue.push", { workspaceId: "proj-main", text: "b" });

    const clearRes = await trpcMutate(server.url, "queue.clear", { workspaceId: "proj-main" });
    expect(clearRes.status).toBe(200);
    const clearData = await trpcData<{ ok: boolean }>(clearRes);
    expect(clearData.ok).toBe(true);

    const getRes = await trpcQuery(server.url, "queue.get", { workspaceId: "proj-main" });
    const getData = await trpcData<{ messages: string[] }>(getRes);
    expect(getData.messages).toEqual([]);
  });

  it("clearing a non-existent queue is a no-op", async () => {
    const res = await trpcMutate(server.url, "queue.clear", { workspaceId: "nonexistent-ws" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean }>(res);
    expect(data.ok).toBe(true);
  });

  it("queued messages are isolated per workspace", async () => {
    await trpcMutate(server.url, "queue.push", { workspaceId: "ws-a", text: "msg-a1" });
    await trpcMutate(server.url, "queue.push", { workspaceId: "ws-a", text: "msg-a2" });
    await trpcMutate(server.url, "queue.push", { workspaceId: "ws-b", text: "msg-b1" });

    const resA = await trpcQuery(server.url, "queue.get", { workspaceId: "ws-a" });
    const dataA = await trpcData<{ messages: string[] }>(resA);
    expect(dataA.messages).toEqual(["msg-a1", "msg-a2"]);

    const resB = await trpcQuery(server.url, "queue.get", { workspaceId: "ws-b" });
    const dataB = await trpcData<{ messages: string[] }>(resB);
    expect(dataB.messages).toEqual(["msg-b1"]);

    // Clearing one doesn't affect the other
    await trpcMutate(server.url, "queue.clear", { workspaceId: "ws-a" });

    const resA2 = await trpcQuery(server.url, "queue.get", { workspaceId: "ws-a" });
    const dataA2 = await trpcData<{ messages: string[] }>(resA2);
    expect(dataA2.messages).toEqual([]);

    const resB2 = await trpcQuery(server.url, "queue.get", { workspaceId: "ws-b" });
    const dataB2 = await trpcData<{ messages: string[] }>(resB2);
    expect(dataB2.messages).toEqual(["msg-b1"]);

    // cleanup
    await trpcMutate(server.url, "queue.clear", { workspaceId: "ws-b" });
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("tRPC — queue input validation", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    const repo = createGitRepo(tmpHome, "proj");

    seedState(tmpHome, {
      projects: [
        {
          name: "proj",
          path: repo,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repo }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("queue.push fails when workspaceId is missing", async () => {
    const res = await trpcMutate(server.url, "queue.push", { text: "hello" });
    expect(res.ok).toBe(false);
  });

  it("queue.push fails when text is missing", async () => {
    const res = await trpcMutate(server.url, "queue.push", { workspaceId: "proj-main" });
    expect(res.ok).toBe(false);
  });

  it("queue.set fails when workspaceId is missing", async () => {
    const res = await trpcMutate(server.url, "queue.set", { messages: ["hello"] });
    expect(res.ok).toBe(false);
  });

  it("queue.set fails when messages is missing", async () => {
    const res = await trpcMutate(server.url, "queue.set", { workspaceId: "proj-main" });
    expect(res.ok).toBe(false);
  });

  it("queue.get fails when workspaceId is missing", async () => {
    const res = await trpcQuery(server.url, "queue.get", {});
    expect(res.ok).toBe(false);
  });

  it("queue.clear fails when workspaceId is missing", async () => {
    const res = await trpcMutate(server.url, "queue.clear", {});
    expect(res.ok).toBe(false);
  });
});
