import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import { SERVER_RUNTIME, SERVER_SCRIPT } from "./helpers/server-runtime";

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

interface QueuedFile {
  mediaType: string;
  url: string;
  filename?: string;
}

interface QueuedMessage {
  id: string;
  text: string;
  files?: QueuedFile[];
}

function createTmpHome(): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-queue-test-")));
  const bandDir = join(tmp, ".band");
  mkdirSync(bandDir, { recursive: true });
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

async function startServer(
  opts: { tmpHome?: string; env?: Record<string, string> } = {},
): Promise<ServerHandle> {
  const home = opts.tmpHome || createTmpHome();
  const port = await getRandomPort();

  return new Promise((resolve, reject) => {
    const child = spawn(SERVER_RUNTIME, [SERVER_SCRIPT], {
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
    const data = await trpcData<{ messages: QueuedMessage[] }>(res);
    expect(data.messages).toEqual([]);
  });

  it("pushes a single queued message via queue.push", async () => {
    const res = await trpcMutate(server.url, "queue.push", {
      workspaceId: "proj-main",
      text: "fix the bug",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean; message: QueuedMessage }>(res);
    expect(data.ok).toBe(true);
    expect(data.message.text).toBe("fix the bug");
    expect(typeof data.message.id).toBe("string");
    expect(data.message.files).toBeUndefined();

    const getRes = await trpcQuery(server.url, "queue.get", { workspaceId: "proj-main" });
    const getData = await trpcData<{ messages: QueuedMessage[] }>(getRes);
    expect(getData.messages.map((m) => m.text)).toEqual(["fix the bug"]);
  });

  it("pushes a queued message with file attachments", async () => {
    await trpcMutate(server.url, "queue.clear", { workspaceId: "proj-main" });

    const file: QueuedFile = {
      mediaType: "image/png",
      // 1×1 transparent PNG
      url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      filename: "pixel.png",
    };

    const res = await trpcMutate(server.url, "queue.push", {
      workspaceId: "proj-main",
      text: "review this image",
      files: [file],
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean; message: QueuedMessage }>(res);
    expect(data.message.text).toBe("review this image");
    expect(data.message.files).toHaveLength(1);
    expect(data.message.files![0]).toMatchObject({
      mediaType: "image/png",
      filename: "pixel.png",
    });
    expect(data.message.files![0].url).toBe(file.url);

    const getRes = await trpcQuery(server.url, "queue.get", { workspaceId: "proj-main" });
    const getData = await trpcData<{ messages: QueuedMessage[] }>(getRes);
    expect(getData.messages).toHaveLength(1);
    expect(getData.messages[0].files).toHaveLength(1);
    expect(getData.messages[0].files![0].filename).toBe("pixel.png");

    // cleanup
    await trpcMutate(server.url, "queue.clear", { workspaceId: "proj-main" });
  });

  it("pushes multiple messages and preserves order", async () => {
    await trpcMutate(server.url, "queue.clear", { workspaceId: "proj-main" });
    await trpcMutate(server.url, "queue.push", { workspaceId: "proj-main", text: "first" });
    await trpcMutate(server.url, "queue.push", {
      workspaceId: "proj-main",
      text: "add tests",
    });
    await trpcMutate(server.url, "queue.push", {
      workspaceId: "proj-main",
      text: "update docs",
    });

    const res = await trpcQuery(server.url, "queue.get", { workspaceId: "proj-main" });
    const data = await trpcData<{ messages: QueuedMessage[] }>(res);
    expect(data.messages.map((m) => m.text)).toEqual(["first", "add tests", "update docs"]);
  });

  it("replaces the entire queue via queue.set", async () => {
    const res = await trpcMutate(server.url, "queue.set", {
      workspaceId: "proj-main",
      messages: [{ text: "new first" }, { text: "new second" }],
    });
    expect(res.status).toBe(200);

    const getRes = await trpcQuery(server.url, "queue.get", { workspaceId: "proj-main" });
    const getData = await trpcData<{ messages: QueuedMessage[] }>(getRes);
    expect(getData.messages.map((m) => m.text)).toEqual(["new first", "new second"]);
  });

  it("queue.set with empty array clears the queue", async () => {
    await trpcMutate(server.url, "queue.set", {
      workspaceId: "proj-main",
      messages: [],
    });

    const res = await trpcQuery(server.url, "queue.get", { workspaceId: "proj-main" });
    const data = await trpcData<{ messages: QueuedMessage[] }>(res);
    expect(data.messages).toEqual([]);
  });

  it("reorders messages via queue.set, preserving ids and files", async () => {
    // Seed three messages, the middle one with a file attachment.
    await trpcMutate(server.url, "queue.clear", { workspaceId: "proj-main" });
    const pushA = await trpcMutate(server.url, "queue.push", {
      workspaceId: "proj-main",
      text: "alpha",
    });
    const pushB = await trpcMutate(server.url, "queue.push", {
      workspaceId: "proj-main",
      text: "bravo",
      files: [
        {
          mediaType: "image/png",
          url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
          filename: "pixel.png",
        },
      ],
    });
    const pushC = await trpcMutate(server.url, "queue.push", {
      workspaceId: "proj-main",
      text: "charlie",
    });
    const a = (await trpcData<{ message: QueuedMessage }>(pushA)).message;
    const b = (await trpcData<{ message: QueuedMessage }>(pushB)).message;
    const c = (await trpcData<{ message: QueuedMessage }>(pushC)).message;

    // Reorder to C, A, B (mirrors what a drag-end persists).
    const setRes = await trpcMutate(server.url, "queue.set", {
      workspaceId: "proj-main",
      messages: [
        { id: c.id, text: c.text },
        { id: a.id, text: a.text },
        { id: b.id, text: b.text, files: b.files },
      ],
    });
    expect(setRes.status).toBe(200);

    const getRes = await trpcQuery(server.url, "queue.get", { workspaceId: "proj-main" });
    const getData = await trpcData<{ messages: QueuedMessage[] }>(getRes);
    expect(getData.messages.map((m) => m.id)).toEqual([c.id, a.id, b.id]);
    expect(getData.messages.map((m) => m.text)).toEqual(["charlie", "alpha", "bravo"]);
    // File attachment survives the reorder
    const reorderedB = getData.messages.find((m) => m.id === b.id);
    expect(reorderedB?.files).toHaveLength(1);
    expect(reorderedB?.files?.[0].filename).toBe("pixel.png");

    // cleanup
    await trpcMutate(server.url, "queue.clear", { workspaceId: "proj-main" });
  });

  it("removes a single message by id via queue.remove", async () => {
    // Seed: a, b, c
    await trpcMutate(server.url, "queue.clear", { workspaceId: "proj-main" });
    await trpcMutate(server.url, "queue.push", { workspaceId: "proj-main", text: "a" });
    const pushB = await trpcMutate(server.url, "queue.push", {
      workspaceId: "proj-main",
      text: "b",
    });
    const pushBData = await trpcData<{ message: QueuedMessage }>(pushB);
    await trpcMutate(server.url, "queue.push", { workspaceId: "proj-main", text: "c" });

    const res = await trpcMutate(server.url, "queue.remove", {
      workspaceId: "proj-main",
      id: pushBData.message.id,
    });
    expect(res.status).toBe(200);
    const removeData = await trpcData<{ ok: boolean; removed: boolean }>(res);
    expect(removeData.removed).toBe(true);

    const getRes = await trpcQuery(server.url, "queue.get", { workspaceId: "proj-main" });
    const getData = await trpcData<{ messages: QueuedMessage[] }>(getRes);
    expect(getData.messages.map((m) => m.text)).toEqual(["a", "c"]);

    // cleanup
    await trpcMutate(server.url, "queue.clear", { workspaceId: "proj-main" });
  });

  it("queue.remove of an unknown id returns removed=false", async () => {
    await trpcMutate(server.url, "queue.push", { workspaceId: "proj-main", text: "x" });

    const res = await trpcMutate(server.url, "queue.remove", {
      workspaceId: "proj-main",
      id: "unknown-id",
    });
    expect(res.status).toBe(200);
    const removeData = await trpcData<{ ok: boolean; removed: boolean }>(res);
    expect(removeData.removed).toBe(false);

    // cleanup
    await trpcMutate(server.url, "queue.clear", { workspaceId: "proj-main" });
  });

  it("updates the text of a queued message via queue.update", async () => {
    await trpcMutate(server.url, "queue.clear", { workspaceId: "proj-main" });
    const pushRes = await trpcMutate(server.url, "queue.push", {
      workspaceId: "proj-main",
      text: "before",
    });
    const pushData = await trpcData<{ message: QueuedMessage }>(pushRes);

    const updateRes = await trpcMutate(server.url, "queue.update", {
      workspaceId: "proj-main",
      id: pushData.message.id,
      text: "after",
    });
    expect(updateRes.status).toBe(200);
    const updateData = await trpcData<{ ok: boolean; updated: boolean }>(updateRes);
    expect(updateData.updated).toBe(true);

    const getRes = await trpcQuery(server.url, "queue.get", { workspaceId: "proj-main" });
    const getData = await trpcData<{ messages: QueuedMessage[] }>(getRes);
    expect(getData.messages).toHaveLength(1);
    expect(getData.messages[0].id).toBe(pushData.message.id);
    expect(getData.messages[0].text).toBe("after");

    // cleanup
    await trpcMutate(server.url, "queue.clear", { workspaceId: "proj-main" });
  });

  it("queue.update preserves file attachments", async () => {
    await trpcMutate(server.url, "queue.clear", { workspaceId: "proj-main" });
    const file: QueuedFile = {
      mediaType: "image/png",
      url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      filename: "pixel.png",
    };
    const pushRes = await trpcMutate(server.url, "queue.push", {
      workspaceId: "proj-main",
      text: "look at this",
      files: [file],
    });
    const pushData = await trpcData<{ message: QueuedMessage }>(pushRes);

    await trpcMutate(server.url, "queue.update", {
      workspaceId: "proj-main",
      id: pushData.message.id,
      text: "actually, look at this image carefully",
    });

    const getRes = await trpcQuery(server.url, "queue.get", { workspaceId: "proj-main" });
    const getData = await trpcData<{ messages: QueuedMessage[] }>(getRes);
    expect(getData.messages[0].text).toBe("actually, look at this image carefully");
    expect(getData.messages[0].files).toHaveLength(1);
    expect(getData.messages[0].files![0].filename).toBe("pixel.png");

    // cleanup
    await trpcMutate(server.url, "queue.clear", { workspaceId: "proj-main" });
  });

  it("queue.update of an unknown id returns updated=false", async () => {
    const res = await trpcMutate(server.url, "queue.update", {
      workspaceId: "proj-main",
      id: "unknown-id",
      text: "irrelevant",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean; updated: boolean }>(res);
    expect(data.updated).toBe(false);
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
    const getData = await trpcData<{ messages: QueuedMessage[] }>(getRes);
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
    const dataA = await trpcData<{ messages: QueuedMessage[] }>(resA);
    expect(dataA.messages.map((m) => m.text)).toEqual(["msg-a1", "msg-a2"]);

    const resB = await trpcQuery(server.url, "queue.get", { workspaceId: "ws-b" });
    const dataB = await trpcData<{ messages: QueuedMessage[] }>(resB);
    expect(dataB.messages.map((m) => m.text)).toEqual(["msg-b1"]);

    // Clearing one doesn't affect the other
    await trpcMutate(server.url, "queue.clear", { workspaceId: "ws-a" });

    const resA2 = await trpcQuery(server.url, "queue.get", { workspaceId: "ws-a" });
    const dataA2 = await trpcData<{ messages: QueuedMessage[] }>(resA2);
    expect(dataA2.messages).toEqual([]);

    const resB2 = await trpcQuery(server.url, "queue.get", { workspaceId: "ws-b" });
    const dataB2 = await trpcData<{ messages: QueuedMessage[] }>(resB2);
    expect(dataB2.messages.map((m) => m.text)).toEqual(["msg-b1"]);

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
    const res = await trpcMutate(server.url, "queue.set", { messages: [{ text: "hello" }] });
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

  it("queue.remove fails when id is missing", async () => {
    const res = await trpcMutate(server.url, "queue.remove", { workspaceId: "proj-main" });
    expect(res.ok).toBe(false);
  });

  it("queue.update fails when id is missing", async () => {
    const res = await trpcMutate(server.url, "queue.update", {
      workspaceId: "proj-main",
      text: "x",
    });
    expect(res.ok).toBe(false);
  });

  it("queue.update fails when text is missing", async () => {
    const res = await trpcMutate(server.url, "queue.update", {
      workspaceId: "proj-main",
      id: "some-id",
    });
    expect(res.ok).toBe(false);
  });
});
