import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { seedSettings, seedState, seedWorkspaceStatuses } from "./helpers/seed-state";
import { SERVER_RUNTIME, SERVER_SCRIPT } from "./helpers/server-runtime";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const DEFAULT_TOKEN = "needs-attention-test-token";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-needs-attn-test-")));
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
  writeFileSync(join(repoPath, "README.md"), "# Test Project\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial commit"]);
  return repoPath;
}

// ---------------------------------------------------------------------------
// WebSocket subscription helper
// ---------------------------------------------------------------------------

interface WSMessage {
  id: number;
  jsonrpc: string;
  result?: { type: string; data?: unknown };
  error?: unknown;
}

function wsSubscribe(
  serverUrl: string,
  procedure: string,
  input: unknown,
  _opts?: { timeoutMs?: number },
): {
  messages: WSMessage[];
  close: () => void;
  waitForEvent: (predicate: (data: unknown) => boolean, timeoutMs?: number) => Promise<unknown>;
} {
  const wsUrl = `${serverUrl.replace(/^http/, "ws")}/trpc`;
  const messages: WSMessage[] = [];
  const eventListeners: Array<{
    predicate: (data: unknown) => boolean;
    resolve: (data: unknown) => void;
    reject: (err: Error) => void;
  }> = [];

  const ws = new WebSocket(wsUrl, { headers: defaultHeaders });

  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "subscription",
        params: { path: procedure, input },
      }),
    );
  });

  ws.on("message", (raw: Buffer) => {
    const msg = JSON.parse(raw.toString()) as WSMessage;
    messages.push(msg);

    if (msg.result?.type === "data" && msg.result.data !== undefined) {
      for (let i = eventListeners.length - 1; i >= 0; i--) {
        if (eventListeners[i].predicate(msg.result.data)) {
          eventListeners[i].resolve(msg.result.data);
          eventListeners.splice(i, 1);
        }
      }
    }
  });

  return {
    messages,
    close: () => ws.close(),
    waitForEvent: (predicate, timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        // Check already received messages
        for (const msg of messages) {
          if (msg.result?.type === "data" && msg.result.data !== undefined) {
            if (predicate(msg.result.data)) {
              resolve(msg.result.data);
              return;
            }
          }
        }
        const timer = setTimeout(() => {
          const idx = eventListeners.findIndex((l) => l.resolve === resolve);
          if (idx !== -1) eventListeners.splice(idx, 1);
          reject(new Error("Timed out waiting for matching event"));
        }, timeoutMs);
        eventListeners.push({
          predicate,
          resolve: (data) => {
            clearTimeout(timer);
            resolve(data);
          },
          reject,
        });
      }),
  };
}

// ---------------------------------------------------------------------------
// Tests: needs_attention clearing via statuses.update
// ---------------------------------------------------------------------------

describe("needs_attention — clearing via statuses.update", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repoPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    repoPath = createGitRepo(tmpHome, "myrepo");
    seedState(tmpHome, {
      projects: [
        {
          name: "myrepo",
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
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("sets needs_attention status", async () => {
    const res = await trpcMutate(server.url, "statuses.update", {
      workspaceId: "myrepo-main",
      agent: { status: "needs_attention", lastActivity: "user input needed" },
    });
    expect(res.status).toBe(200);

    const getRes = await trpcQuery(server.url, "statuses.get", { workspaceId: "myrepo-main" });
    const data = await trpcData<{ agent: { status: string } }>(getRes);
    expect(data.agent.status).toBe("needs_attention");
  });

  it("clears needs_attention via clearNeedsAttention", async () => {
    // Set needs_attention first
    await trpcMutate(server.url, "statuses.update", {
      workspaceId: "myrepo-main",
      agent: { status: "needs_attention" },
    });

    // Clear it via the dedicated endpoint
    const res = await trpcMutate(server.url, "statuses.clearNeedsAttention", {
      workspaceId: "myrepo-main",
    });
    expect(res.status).toBe(200);

    const getRes = await trpcQuery(server.url, "statuses.get", { workspaceId: "myrepo-main" });
    const data = await trpcData<{ agent: { status: string; lastActivity: string } }>(getRes);
    expect(data.agent.status).toBe("waiting");
    // lastActivity should be preserved from earlier update
    expect(data.agent.lastActivity).toBe("user input needed");
  });

  it("preserves other fields when clearing needs_attention", async () => {
    // Set up with full agent info
    await trpcMutate(server.url, "statuses.update", {
      workspaceId: "myrepo-main",
      agent: { status: "needs_attention", lastActivity: "waiting for approval" },
    });

    // Clear via the dedicated endpoint
    await trpcMutate(server.url, "statuses.clearNeedsAttention", {
      workspaceId: "myrepo-main",
    });

    const getRes = await trpcQuery(server.url, "statuses.get", { workspaceId: "myrepo-main" });
    const data = await trpcData<{
      workspaceId: string;
      project: string;
      branch: string;
      agent: { status: string; lastActivity: string };
    }>(getRes);
    expect(data.workspaceId).toBe("myrepo-main");
    expect(data.project).toBe("myrepo");
    expect(data.branch).toBe("main");
    expect(data.agent.status).toBe("waiting");
    expect(data.agent.lastActivity).toBe("waiting for approval");
  });

  it("clearNeedsAttention is a no-op when status is working", async () => {
    // Set status to working
    await trpcMutate(server.url, "statuses.update", {
      workspaceId: "myrepo-main",
      agent: { status: "working", lastActivity: "coding something" },
    });

    // Attempt to clear — should be a no-op
    const res = await trpcMutate(server.url, "statuses.clearNeedsAttention", {
      workspaceId: "myrepo-main",
    });
    expect(res.status).toBe(200);

    // Status should still be working
    const getRes = await trpcQuery(server.url, "statuses.get", { workspaceId: "myrepo-main" });
    const data = await trpcData<{ agent: { status: string; lastActivity: string } }>(getRes);
    expect(data.agent.status).toBe("working");
    expect(data.agent.lastActivity).toBe("coding something");
  });
});

// ---------------------------------------------------------------------------
// Tests: resetAgentStatuses on server startup
// ---------------------------------------------------------------------------

describe("needs_attention — reset on server startup", () => {
  it("resets needs_attention to waiting on server startup", async () => {
    const tmpHome = createTmpHome();
    const repoPath = createGitRepo(tmpHome, "myrepo");
    seedState(tmpHome, {
      projects: [
        {
          name: "myrepo",
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
    // Seed a workspace status with needs_attention BEFORE starting server
    seedWorkspaceStatuses(tmpHome, [
      {
        workspaceId: "myrepo-main",
        project: "myrepo",
        branch: "main",
        worktreePath: repoPath,
        agentStatus: "needs_attention",
        agentLastActivity: "stale input request",
      },
    ]);

    const server = await startServer({ tmpHome });
    try {
      // After startup, resetAgentStatuses should have cleared needs_attention
      const res = await trpcQuery(server.url, "statuses.get", { workspaceId: "myrepo-main" });
      const data = await trpcData<{ agent: { status: string; lastActivity: string } }>(res);
      expect(data.agent.status).toBe("waiting");
      // lastActivity should still be preserved
      expect(data.agent.lastActivity).toBe("stale input request");
    } finally {
      await server.close();
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("resets working to waiting on server startup", async () => {
    const tmpHome = createTmpHome();
    const repoPath = createGitRepo(tmpHome, "myrepo");
    seedState(tmpHome, {
      projects: [
        {
          name: "myrepo",
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
    seedWorkspaceStatuses(tmpHome, [
      {
        workspaceId: "myrepo-main",
        project: "myrepo",
        branch: "main",
        worktreePath: repoPath,
        agentStatus: "working",
        agentLastActivity: "coding something",
      },
    ]);

    const server = await startServer({ tmpHome });
    try {
      const res = await trpcQuery(server.url, "statuses.get", { workspaceId: "myrepo-main" });
      const data = await trpcData<{ agent: { status: string } }>(res);
      expect(data.agent.status).toBe("waiting");
    } finally {
      await server.close();
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("does not reset waiting status on server startup", async () => {
    const tmpHome = createTmpHome();
    const repoPath = createGitRepo(tmpHome, "myrepo");
    seedState(tmpHome, {
      projects: [
        {
          name: "myrepo",
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
    seedWorkspaceStatuses(tmpHome, [
      {
        workspaceId: "myrepo-main",
        project: "myrepo",
        branch: "main",
        worktreePath: repoPath,
        agentStatus: "waiting",
      },
    ]);

    const server = await startServer({ tmpHome });
    try {
      const res = await trpcQuery(server.url, "statuses.get", { workspaceId: "myrepo-main" });
      const data = await trpcData<{ agent: { status: string } }>(res);
      expect(data.agent.status).toBe("waiting");
    } finally {
      await server.close();
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: WebSocket status stream reflects needs_attention clearing
// ---------------------------------------------------------------------------

describe("needs_attention — status stream via WebSocket", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repoPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    repoPath = createGitRepo(tmpHome, "myrepo");
    seedState(tmpHome, {
      projects: [
        {
          name: "myrepo",
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
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("WebSocket snapshot reflects current status after clearing needs_attention", async () => {
    // Set needs_attention, then clear it
    await trpcMutate(server.url, "statuses.update", {
      workspaceId: "myrepo-main",
      agent: { status: "needs_attention" },
    });
    await trpcMutate(server.url, "statuses.clearNeedsAttention", {
      workspaceId: "myrepo-main",
    });

    // Subscribe — snapshot should show "waiting", not "needs_attention"
    const sub = wsSubscribe(server.url, "status.stream", {});
    try {
      const snapshot = await sub.waitForEvent(
        (data) => (data as { kind: string }).kind === "snapshot",
      );
      const snapshotData = snapshot as {
        kind: string;
        statuses: Array<{ agent: { status: string } }>;
      };
      expect(snapshotData.kind).toBe("snapshot");
      const ws = snapshotData.statuses.find(
        (s: { workspaceId?: string }) => s.workspaceId === "myrepo-main",
      );
      expect(ws).toBeDefined();
      expect(ws!.agent.status).toBe("waiting");
    } finally {
      sub.close();
    }
  });

  it("WebSocket receives update event when needs_attention is cleared", async () => {
    // Set needs_attention
    await trpcMutate(server.url, "statuses.update", {
      workspaceId: "myrepo-main",
      agent: { status: "needs_attention" },
    });

    // Subscribe to get the snapshot, then clear
    const sub = wsSubscribe(server.url, "status.stream", {});
    try {
      // Wait for snapshot first
      await sub.waitForEvent((data) => (data as { kind: string }).kind === "snapshot");

      // Now clear the status via the dedicated endpoint — should arrive as an "update" event
      await trpcMutate(server.url, "statuses.clearNeedsAttention", {
        workspaceId: "myrepo-main",
      });

      const updateEvent = await sub.waitForEvent(
        (data) =>
          (data as { kind: string }).kind === "update" &&
          (data as { status?: { agent?: { status: string } } }).status?.agent?.status === "waiting",
      );

      const eventData = updateEvent as {
        kind: string;
        status: { workspaceId: string; agent: { status: string } };
      };
      expect(eventData.kind).toBe("update");
      expect(eventData.status.workspaceId).toBe("myrepo-main");
      expect(eventData.status.agent.status).toBe("waiting");
    } finally {
      sub.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: statuses.notify — agent hook → status mapping
//
// The CLI's `band notify` forwards the raw hook payload here; the server
// dispatches to the workspace's coding-agent adapter to derive the status.
// This is the authoritative test for the Claude Code event→status matrix
// (the mapping lives in packages/coding-agent's claude-code adapter).
// ---------------------------------------------------------------------------

describe("statuses.notify — agent hook mapping", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repoPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    repoPath = createGitRepo(tmpHome, "myrepo");
    seedState(tmpHome, {
      projects: [
        {
          name: "myrepo",
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
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  async function notifyStatus(payload: Record<string, unknown>): Promise<string | undefined> {
    const res = await trpcMutate(server.url, "statuses.notify", { cwd: repoPath, payload });
    // Surface a server-side failure at its root cause rather than letting it
    // masquerade as a wrong-status assertion failure at the call site.
    if (res.status !== 200) {
      throw new Error(`statuses.notify failed: HTTP ${res.status} — ${await res.text()}`);
    }
    const getRes = await trpcQuery(server.url, "statuses.get", { workspaceId: "myrepo-main" });
    const data = await trpcData<{ agent?: { status: string } } | null>(getRes);
    return data?.agent?.status;
  }

  it("maps Stop → needs_attention", async () => {
    expect(await notifyStatus({ hook_event_name: "Stop" })).toBe("needs_attention");
  });

  // Regression (#571): PermissionRequest fires after PreToolUse for every
  // gated tool (Bash/Write/Edit/…). Band auto-approves those — they don't
  // block the user — so they must stay `working`. Mapping PermissionRequest
  // to needs_attention unconditionally chimed the attention sound per tool
  // call. We drive to needs_attention via Stop first so a `working` result
  // proves the gated tool actively cleared attention rather than the status
  // having been `working` already.
  it("maps PermissionRequest + Bash → working (auto-approved, does not block)", async () => {
    await notifyStatus({ hook_event_name: "Stop" });
    expect(await notifyStatus({ hook_event_name: "PermissionRequest", tool_name: "Bash" })).toBe(
      "working",
    );
  });

  it("maps PermissionRequest + Write → working (auto-approved, does not block)", async () => {
    await notifyStatus({ hook_event_name: "Stop" });
    expect(await notifyStatus({ hook_event_name: "PermissionRequest", tool_name: "Write" })).toBe(
      "working",
    );
  });

  it("maps PermissionRequest + AskUserQuestion → needs_attention", async () => {
    expect(
      await notifyStatus({ hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion" }),
    ).toBe("needs_attention");
  });

  it("maps PermissionRequest + ExitPlanMode → needs_attention", async () => {
    expect(
      await notifyStatus({ hook_event_name: "PermissionRequest", tool_name: "ExitPlanMode" }),
    ).toBe("needs_attention");
  });

  it("maps PreToolUse + ExitPlanMode → needs_attention", async () => {
    expect(await notifyStatus({ hook_event_name: "PreToolUse", tool_name: "ExitPlanMode" })).toBe(
      "needs_attention",
    );
  });

  it("maps PreToolUse + AskUserQuestion → needs_attention", async () => {
    expect(
      await notifyStatus({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }),
    ).toBe("needs_attention");
  });

  it("maps PreToolUse + regular tool → working", async () => {
    expect(await notifyStatus({ hook_event_name: "PreToolUse", tool_name: "Read" })).toBe(
      "working",
    );
  });

  it("maps PostToolUse → working", async () => {
    // Drive to needs_attention first, then confirm PostToolUse restores working.
    await notifyStatus({ hook_event_name: "Stop" });
    expect(await notifyStatus({ hook_event_name: "PostToolUse", tool_name: "Read" })).toBe(
      "working",
    );
  });

  it("stamps a recent lastActivity timestamp", async () => {
    const before = Date.now();
    await notifyStatus({ hook_event_name: "Stop" });
    const getRes = await trpcQuery(server.url, "statuses.get", { workspaceId: "myrepo-main" });
    const data = await trpcData<{ agent?: { lastActivity: string } } | null>(getRes);
    const stamped = data?.agent?.lastActivity;
    expect(typeof stamped).toBe("string");
    // The endpoint writes `new Date().toISOString()` during the call, so the
    // stamp must fall between when we started and now (bounded both sides so a
    // stale or far-future value can't slip through). `before - 50` absorbs
    // sub-millisecond cross-process clock jitter.
    const stampedMs = Date.parse(stamped as string);
    expect(Number.isNaN(stampedMs)).toBe(false);
    expect(stampedMs).toBeGreaterThanOrEqual(before - 50);
    expect(stampedMs).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("is a no-op for an unresolvable cwd", async () => {
    const res = await trpcMutate(server.url, "statuses.notify", {
      cwd: "/no/such/workspace",
      payload: { hook_event_name: "Stop" },
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ ok: boolean }>(res);
    expect(data.ok).toBe(true);

    // Anchor the no-op claim: the bogus cwd resolves to no workspace, so
    // nothing could have been written for it.
    const resolveRes = await trpcQuery(server.url, "statuses.resolve", {
      cwd: "/no/such/workspace",
    });
    const resolved = await trpcData<{ workspaceId: string | null }>(resolveRes);
    expect(resolved.workspaceId).toBeNull();
  });

  it("rejects statuses.notify without the band_token cookie (401)", async () => {
    // The shared `trpcMutate` always sends the cookie, so we call `fetch`
    // directly to omit it. Mirrors the 401 guard in sibling endpoint suites.
    const res = await fetch(`${server.url}/trpc/statuses.notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: repoPath, payload: { hook_event_name: "Stop" } }),
    });
    expect(res.status).toBe(401);
  });
});
