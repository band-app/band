// Integration test for extension panels and tools (docs/extensions.md). A real hub and two real
// `band-worker` processes, each running the scripted ACP stub as its agent. The echo-service fixture
// extension (service, panel, tools) is installed on the hub. Worker A runs its service. Worker B is
// restricted, so it never does. Agents reach the tools through the `band` MCP server, with no tab open.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { openStream, STUB_AGENT_PATH, TEST_TOKEN, turnEnded } from "./helpers/acp-chat";
import { echoArchive } from "./helpers/extension-archive";
import { makeTarGz } from "./helpers/make-tar";
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

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  writeFileSync(join(dir, "hello.txt"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env });
}

interface Worker {
  hostId: string;
  home: string;
  child: ChildProcess;
  worktreeId: string;
  httpLog: string;
}

let server: ServerHandle;
let a: Worker;
let b: Worker;

const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TEST_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, TEST_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

const SCENARIO = {
  turns: [
    {
      match: "^tools",
      steps: [
        {
          mcpCall: { name: "list", server: "band", tool: "", method: "tools/list", fullBody: true },
        },
        {
          mcpCall: {
            name: "echo",
            server: "band",
            tool: "echo-service_echo",
            args: { text: "hi" },
            fullBody: true,
          },
        },
        { say: "done" },
      ],
    },
  ],
};

async function startWorker(label: string): Promise<Worker> {
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: `worker-${label}`,
    labels: [],
  });
  const home = tmp(`band-extpanel-${label}-home-`);
  const root = tmp(`band-extpanel-${label}-root-`);
  const state = tmp(`band-extpanel-${label}-state-`);
  initRepo(join(root, "proj"));
  const httpLog = join(home, "http-log.jsonl");
  writeFileSync(join(home, "scenario.json"), JSON.stringify(SCENARIO));
  const child = spawn(
    process.execPath,
    [
      WORKER_BIN,
      "--hub",
      server.url,
      "--token",
      issued.token,
      "--root",
      root,
      "--state-dir",
      state,
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        BAND_HOME: join(home, ".band"),
        BAND_TERMINAL_DAEMON: "0",
        BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
        BAND_TEST_ACP_STATE: join(home, "acp-state"),
        BAND_TEST_ACP_HTTP_LOG: httpLog,
        BAND_TEST_ACP_SCENARIO: join(home, "scenario.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", () => undefined);
  await waitFor(
    async () => {
      const { hosts } = await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list");
      return hosts.find((h) => h.id === issued.hostId)?.status === "online" ? true : undefined;
    },
    { label: `worker ${label} online`, timeoutMs: 30_000 },
  );
  await m("worktrees.create", {
    repo: "proj",
    branch: `seed-${label}`,
    hostId: issued.hostId,
    hostRepoPath: join(root, "proj"),
  });
  return {
    hostId: issued.hostId,
    home,
    child,
    httpLog,
    worktreeId: toWorktreeId("proj", `seed-${label}`, issued.hostId),
  };
}

beforeAll(async () => {
  const hubHome = createTmpHome("band-extpanel-hub-");
  scratch.push(hubHome);
  const dir = join(tmp("band-extpanel-hub-proj-"), "proj");
  initRepo(dir);
  seedSettings(hubHome, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  seedState(hubHome, {
    repos: [
      {
        name: "proj",
        path: dir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: dir }],
      },
    ],
  });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: { BAND_SERVE_UI: "false" },
  });
  a = await startWorker("a");
  b = await startWorker("b");
  await m("hosts.setTrust", { hostId: b.hostId, trust: "restricted" });
  const res = await fetch(`${server.url}/api/extensions/install`, {
    method: "POST",
    headers: { Cookie: `band_token=${TEST_TOKEN}` },
    body: echoArchive({ version: "1.0.0" }).bytes,
  });
  expect(res.status).toBe(200);
  await waitFor(
    async () => {
      const { hosts } = await q<{
        hosts: Array<{ id: string; capabilities: string[] }>;
      }>("hosts.list");
      return hosts.find((h) => h.id === a.hostId)?.capabilities.includes("echo") ? true : undefined;
    },
    { label: "the echo capability on A", timeoutMs: 40_000 },
  );
}, 240_000);

afterAll(async () => {
  a?.child.kill("SIGKILL");
  b?.child.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

/** The text the `band` server answered with, from a JSON-RPC body (plain or an SSE frame). */
function parse(body: string) {
  const json = body.includes("data:") ? body.slice(body.indexOf("data:") + 5).trim() : body;
  return JSON.parse(json.split("\n")[0]) as {
    result?: { content?: { text?: string }[]; isError?: boolean; tools?: { name: string }[] };
  };
}
const httpLog = (w: Worker): Array<{ name: string; status: number; body: string }> =>
  existsSync(w.httpLog)
    ? readFileSync(w.httpLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

async function runTools(w: Worker, chatId: string) {
  const stream = await openStream(server.url, chatId, { until: turnEnded, timeoutMs: 40_000 });
  const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
    body: JSON.stringify({ worktreeId: w.worktreeId, text: "tools" }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
  await stream.events;
  return httpLog(w);
}

describe("extension panels and tools", () => {
  it("S3: an agent calls an extension tool with no tab open; agent:false tools are not listed", async () => {
    const lines = await runTools(a, "chat-on-a");
    const names = (parse(lines.find((l) => l.name === "list")?.body ?? "").result?.tools ?? []).map(
      (t) => t.name,
    );
    expect(names).toContain("echo-service_echo");
    expect(names).not.toContain("echo-service_hidden");
    const echo = parse(lines.find((l) => l.name === "echo")?.body ?? "").result;
    expect(echo?.isError).toBeUndefined();
    expect(JSON.parse(echo?.content?.[0]?.text ?? "null")).toEqual({ text: "hi" });
  }, 90_000);

  it("S3: a chat on a worker without the service gets an error naming the worker", async () => {
    const lines = await runTools(b, "chat-on-b");
    const echo = parse(lines.find((l) => l.name === "echo")?.body ?? "").result;
    expect(echo?.isError).toBe(true);
    expect(echo?.content?.[0]?.text).toContain(b.hostId);
  }, 90_000);

  it("S2: the panel stream sends frames, drops input until control, then delivers it", async () => {
    const params = encodeURIComponent(JSON.stringify({ frames: 3 }));
    const url = `${server.url.replace("http", "ws")}/api/extensions/echo-service/worktrees/${encodeURIComponent(
      a.worktreeId,
    )}/stream?panel=screen&name=screen&params=${params}`;
    const ws = new WebSocket(url, { headers: { Cookie: `band_token=${TEST_TOKEN}` } });
    const received: string[] = [];
    ws.on("message", (data, isBinary) => {
      received.push(isBinary ? `bytes:${[...(data as Buffer)].join(",")}` : data.toString());
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    await waitFor(() => (received.length >= 3 ? true : undefined), {
      label: "3 frames",
      timeoutMs: 20_000,
    });
    expect(received.slice(0, 3)).toEqual(["frame-0", "bytes:1", "frame-2"]);

    // View-only: the input is dropped.
    ws.send("before");
    await new Promise((r) => setTimeout(r, 500));
    expect(received.some((r) => r.startsWith("echo:"))).toBe(false);

    ws.send(JSON.stringify({ type: "control", enabled: true }));
    ws.send("after");
    await waitFor(() => (received.includes("echo:after") ? true : undefined), {
      label: "the service received the input after control",
      timeoutMs: 20_000,
    });
    expect(received).not.toContain("echo:before");
    ws.close();
  }, 60_000);

  it("a stream for an unknown panel closes with 4001 and a reason", async () => {
    const url = `${server.url.replace("http", "ws")}/api/extensions/echo-service/worktrees/${encodeURIComponent(
      a.worktreeId,
    )}/stream?panel=nope&name=screen`;
    const ws = new WebSocket(url, { headers: { Cookie: `band_token=${TEST_TOKEN}` } });
    const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    expect(closed.code).toBe(4001);
    expect(closed.reason).toContain("no panel");
  });

  it("a panel call reaches the service of its own extension on the worktree's worker", async () => {
    const reply = await m<{ result: unknown }>("extensions.panelCall", {
      extensionId: "echo-service",
      panelId: "screen",
      worktreeId: a.worktreeId,
      method: "echo",
      params: { x: 1 },
    });
    expect(reply.result).toEqual({ x: 1 });
    await expect(
      m("extensions.panelCall", {
        extensionId: "echo-service",
        panelId: "screen",
        worktreeId: b.worktreeId,
        method: "echo",
      }),
    ).rejects.toThrow(/echo/);
    await expect(
      m("extensions.panelCall", {
        extensionId: "echo-service",
        panelId: "missing",
        worktreeId: a.worktreeId,
        method: "echo",
      }),
    ).rejects.toThrow(/no panel/);
  });

  it("an install is refused when a panel names a capability no service reports", async () => {
    const manifest = {
      id: "bad-panel",
      name: "Bad panel",
      version: "1.0.0",
      extensionApi: 1,
      contributes: {
        workerServices: [{ id: "main", entry: "service.mjs", capability: "one" }],
        panels: [{ id: "p", label: "P", entry: "p.html", capability: "other" }],
        tools: [{ name: "t", description: "d", service: "missing", method: "m" }],
      },
    };
    const bytes = makeTarGz([
      { name: "bad-panel/", type: "5" },
      { name: "bad-panel/band-extension.json", data: JSON.stringify(manifest) },
      { name: "bad-panel/service.mjs", data: "// nothing\n" },
      { name: "bad-panel/p.html", data: "<p></p>" },
    ]);
    const res = await fetch(`${server.url}/api/extensions/install`, {
      method: "POST",
      headers: { Cookie: `band_token=${TEST_TOKEN}` },
      body: bytes,
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("No worker service reports");
  });
});
