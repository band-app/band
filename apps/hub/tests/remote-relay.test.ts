// Integration tests for what an agent in a remote workspace needs (plan step
// 2.5): uploads and the shared dir on the worker, the worker's local relay for
// the agent's calls to the hub, hooks through the relay, system and editor
// calls on the worker, and removing a workspace while its worker is offline.
// Two real `band-worker` processes dial a real hub (the production bundle on
// a random port with auth on). Agents are the scripted ACP stub, started by
// the worker. Everything lives in temp dirs.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCliBinary } from "@band-app/host-local/process/cli-binary";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openStream, STUB_AGENT_PATH, TEST_TOKEN, trpc, turnEnded } from "./helpers/acp-chat";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { TerminalSocket } from "./helpers/terminal-socket";
import { waitFor } from "./helpers/wait-for";

const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");

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
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "hello.txt"), "hello from the project\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

interface Worker {
  name: string;
  hostId: string;
  root: string;
  state: string;
  home: string;
  /** Where the scripted agent on this worker records what it sent to the hub. */
  httpLog: string;
  stubLog: string;
  child: ChildProcess;
  exited: Promise<number | null>;
}

let hubHome: string;
let hubRepo: string;
let server: ServerHandle;
let a: Worker;
let b: Worker;

const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, TEST_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TEST_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

function startWorkerProcess(w: Omit<Worker, "child" | "exited">, token: string): Worker {
  const child = spawn(
    process.execPath,
    [WORKER_BIN, "--hub", server.url, "--token", token, "--root", w.root, "--state-dir", w.state],
    {
      env: {
        ...process.env,
        HOME: w.home,
        BAND_HOME: join(w.home, ".band"),
        BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
        BAND_TEST_ACP_STATE: join(w.home, "acp-state"),
        BAND_TEST_ACP_LOG: w.stubLog,
        BAND_TEST_ACP_HTTP_LOG: w.httpLog,
        BAND_TEST_ACP_SCENARIO: join(w.home, "scenario.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", () => undefined);
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { ...w, child, exited };
}

async function addWorker(name: string, scenario: object): Promise<Worker> {
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: name,
    labels: [],
  });
  const home = tmp(`band-relay-${name}-home-`);
  const root = tmp(`band-relay-${name}-root-`);
  makeRepo(join(root, "proj"));
  writeFileSync(join(home, "scenario.json"), JSON.stringify(scenario));
  const base = {
    name,
    hostId: issued.hostId,
    root,
    state: tmp(`band-relay-${name}-state-`),
    home,
    httpLog: join(home, "http-log.jsonl"),
    stubLog: join(home, "stub-log.jsonl"),
  };
  const worker = startWorkerProcess(base, issued.token);
  await waitFor(
    async () => {
      const { hosts } = await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list");
      return hosts.find((h) => h.id === issued.hostId)?.status === "online" ? true : undefined;
    },
    { label: `${name} online`, timeoutMs: 20_000 },
  );
  return worker;
}

async function hostStatus(w: Worker): Promise<string | undefined> {
  const { hosts } = await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list");
  return hosts.find((h) => h.id === w.hostId)?.status;
}

async function createWorkspace(w: Worker, branch: string): Promise<string> {
  await m("workspaces.create", {
    project: "proj",
    branch,
    hostId: w.hostId,
    hostProjectPath: join(w.root, "proj"),
  });
  return `proj-${branch}`;
}

const worktreeOf = (w: Worker, branch: string) => join(w.root, ".band-worktrees", "proj", branch);

let chatCounter = 0;
const newChatId = () => `relay-chat-${++chatCounter}`;

/** Sends one message the way the browser does and waits for the turn to end. */
async function submit(
  workspaceId: string,
  text: string,
  files?: { mediaType: string; url: string; filename?: string }[],
  chatId = newChatId(),
) {
  const stream = await openStream(server.url, chatId, { until: turnEnded, timeoutMs: 30_000 });
  const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
    body: JSON.stringify({ workspaceId, text, files }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
  return { chatId, events: await stream.events };
}

const dataUrl = (text: string) => `data:text/plain;base64,${Buffer.from(text).toString("base64")}`;

interface HttpLine {
  name: string;
  status: number;
  body: string;
}
function httpLog(w: Worker): HttpLine[] {
  if (!existsSync(w.httpLog)) return [];
  return readFileSync(w.httpLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as HttpLine);
}

const listChats = (workspaceId: string) =>
  `/trpc/chats.list?input=${encodeURIComponent(JSON.stringify({ workspaceId }))}`;
const mcpChatsList = (workspaceId: string) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "band_chats_list", arguments: { workspaceId } },
});
const MCP_HEADERS = { accept: "application/json, text/event-stream" };

beforeAll(async () => {
  hubHome = createTmpHome("band-relay-hub-");
  scratch.push(hubHome);
  hubRepo = join(tmp("band-relay-hubrepo-"), "proj");
  makeRepo(hubRepo);
  seedSettings(hubHome, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  seedState(hubHome, {
    projects: [
      {
        name: "proj",
        path: hubRepo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: hubRepo }],
      },
    ],
  });
  // The hub's own workspace must stay local, and this file starts its own workers,
  // so the loopback worker would only get in the way.
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: {
      BAND_SERVE_UI: "false",
      BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
      BAND_TEST_ACP_STATE: join(hubHome, "acp-state"),
    },
  });

  const probe = (name: string, path: string, extra: object = {}) => ({
    http: { name, path, ...extra },
  });
  const post = (name: string, path: string, body: object) => ({
    http: { name, path, method: "POST", body },
  });
  const scenario = {
    turns: [
      {
        match: "^relay-probe",
        steps: [
          probe("own-chats", listChats("proj-relay-a")),
          probe("other-worker-chats", listChats("proj-relay-b")),
          probe("hub-chats", listChats("proj-main")),
          probe("no-token", listChats("proj-relay-a"), { auth: "none" }),
          probe("tokens", "/trpc/tokens.list"),
          probe("settings", "/trpc/settings.get"),
          probe("mcp-own", "/mcp", {
            method: "POST",
            body: mcpChatsList("proj-relay-a"),
            headers: MCP_HEADERS,
          }),
          probe("mcp-other", "/mcp", {
            method: "POST",
            body: mcpChatsList("proj-relay-b"),
            headers: MCP_HEADERS,
          }),
          probe("mcp-tokens", "/mcp", {
            method: "POST",
            body: {
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: { name: "band_tokens_list", arguments: {} },
            },
            headers: MCP_HEADERS,
          }),
          probe(
            "batch",
            `/trpc/chats.list,tokens.list?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { workspaceId: "proj-relay-a" }, 1: {} }))}`,
          ),
          probe("decoy-terminal", "/trpc/terminal.kill", {
            method: "POST",
            body: { terminalId: "hub-terminal", workspaceId: "proj-relay-a" },
            headers: { "content-type": "application/json" },
          }),
          probe("decoy-project", "/trpc/workspaces.gitPush", {
            method: "POST",
            body: { project: "proj", name: "main", workspaceId: "proj-relay-a" },
            headers: { "content-type": "application/json" },
          }),
          probe("other-route", "/api/workspace-file/proj-main/hello.txt"),
          { say: "probed" },
        ],
      },
      {
        match: "^id-probe",
        steps: [
          post("b-chat-collide", "/trpc/chats.create", {
            workspaceId: "proj-relay-b",
            id: "a-owned-chat",
          }),
          post("b-browser-collide", "/trpc/browsers.create", {
            workspaceId: "proj-relay-b",
            id: "a-owned-browser",
          }),
          post("b-chat-into-a", "/trpc/chats.create", {
            workspaceId: "proj-relay-a",
            id: "fresh-id",
          }),
          post("b-chat-own", "/trpc/chats.create", {
            workspaceId: "proj-relay-b",
            id: "b-owned-chat",
          }),
          post("b-browser-own", "/trpc/browsers.create", {
            workspaceId: "proj-relay-b",
            id: "b-owned-browser",
          }),
          post("projects-remove", "/trpc/projects.remove", { name: "proj" }),
          post("tokens-list", "/trpc/tokens.list", {}),
          post("chats-unlisted", "/trpc/chats.continueInTerminal", {
            chatId: "b-owned-chat",
            workspaceId: "proj-relay-b",
          }),
          post("tasks-cancel", "/trpc/tasks.cancel", { taskId: "x" }),
          post("workspaces-remove", "/trpc/workspaces.remove", {
            project: "proj",
            name: "relay-a",
          }),
          { say: "probed ids" },
        ],
      },
      {
        match: "^share-file",
        steps: [
          { tool: { toolCallId: "copy-1", title: "Copy a file", kind: "execute" } },
          { writeFile: { path: "{{sharedDir}}/report.txt", content: "shared from the worker\n" } },
          { toolUpdate: { toolCallId: "copy-1", status: "completed" } },
          { say: "shared" },
        ],
      },
    ],
  };
  a = await addWorker("a", scenario);
  b = await addWorker("b", scenario);
}, 180_000);

afterAll(async () => {
  a?.child.kill("SIGKILL");
  b?.child.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("uploads (S1)", () => {
  it("stores a chat upload on the worker and keeps no copy on the hub", async () => {
    await createWorkspace(a, "relay-a");
    await createWorkspace(b, "relay-b");

    const { events } = await submit("proj-relay-a", "look at this file", [
      { mediaType: "text/plain", url: dataUrl("uploaded to a worker\n"), filename: "notes.txt" },
    ]);
    expect(events.find(turnEnded)).toBeDefined();

    // The agent got a path on the worker, under the worker's root and keyed by workspace.
    const prompts = readFileSync(a.stubLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { method: string; params: { prompt?: Array<{ uri?: string }> } })
      .filter((r) => r.method === "session/prompt");
    const uri = prompts.at(-1)?.params.prompt?.find((blk) => blk.uri)?.uri ?? "";
    const path = decodeURIComponent(new URL(uri).pathname);
    expect(path.startsWith(join(a.root, ".band-uploads", "proj-relay-a"))).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("uploaded to a worker\n");

    // The hub's disk has no uploads.
    const hubUploads = join(hubHome, ".band", "uploads");
    expect(existsSync(hubUploads) ? readdirSync(hubUploads) : []).toEqual([]);

    // The chat renders it from the hub, which streams it from the worker.
    const prompt = events.find((e) => e.type === "prompt") as
      | { files?: Array<{ url: string }> }
      | undefined;
    const url = prompt?.files?.[0]?.url ?? "";
    expect(url).toBe(
      `/api/uploads/proj-relay-a/${encodeURIComponent(path.split("/").at(-1) ?? "")}`,
    );
    const served = await fetch(`${server.url}${url}`, {
      headers: { Cookie: `band_token=${TEST_TOKEN}` },
    });
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("uploaded to a worker\n");
  });

  it("keeps a local workspace's uploads on the hub", async () => {
    const { events } = await submit("proj-main", "local upload", [
      { mediaType: "text/plain", url: dataUrl("stays here\n"), filename: "local.txt" },
    ]);
    const prompt = events.find((e) => e.type === "prompt") as
      | { files?: Array<{ url: string }> }
      | undefined;
    const url = prompt?.files?.[0]?.url ?? "";
    expect(url).toMatch(/^\/api\/uploads\/[^/]+-local\.txt$/);
    const files = readdirSync(join(hubHome, ".band", "uploads"));
    expect(files.some((f) => f.endsWith("-local.txt"))).toBe(true);
    const served = await fetch(`${server.url}${url}`, {
      headers: { Cookie: `band_token=${TEST_TOKEN}` },
    });
    expect(await served.text()).toBe("stays here\n");
  });

  it("shows a file the agent shares on the worker as a download in the chat", async () => {
    const { events } = await submit("proj-relay-a", "share-file please");
    const file = events.find((e) => e.type === "file") as
      | { url: string; filename: string }
      | undefined;
    expect(file?.filename).toBe("report.txt");
    expect(readFileSync(join(a.root, ".band-shared", "proj-relay-a", "report.txt"), "utf8")).toBe(
      "shared from the worker\n",
    );
    expect(existsSync(join(hubHome, ".band", "shared", "proj-relay-a"))).toBe(false);
    const served = await fetch(`${server.url}${file?.url}`, {
      headers: { Cookie: `band_token=${TEST_TOKEN}` },
    });
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("shared from the worker\n");
  });
});

describe("the worker relay (S2)", () => {
  it("gives the agent the relay as its server and lets it call the hub for its own workspace", async () => {
    await submit("proj-relay-a", "relay-probe");
    const lines = httpLog(a);
    const by = (name: string) => lines.find((l) => l.name === name);

    // The stub agent saw the relay, not the hub, as its server.
    const request = readFileSync(a.stubLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { env: { BAND_SERVER_URL?: string } })
      .find((r) => r.env.BAND_SERVER_URL);
    expect(request?.env.BAND_SERVER_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(request?.env.BAND_SERVER_URL).not.toBe(server.url);

    expect(by("own-chats")?.status).toBe(200);
    expect(by("own-chats")?.body).toContain('"chats"');
    expect(by("mcp-own")?.status).toBe(200);
    expect(by("mcp-own")?.body).toContain("chats");
  });

  it("refuses a call for another worker's workspace, or the hub's", async () => {
    const by = (name: string) => httpLog(a).find((l) => l.name === name);
    expect(by("other-worker-chats")?.status).toBe(403);
    expect(by("hub-chats")?.status).toBe(403);
    expect(by("mcp-other")?.status).toBe(403);
    // One call of a batch outside the surface refuses the whole batch.
    expect(by("batch")?.status).toBe(403);
  });

  it("refuses what an agent has no business with, and calls without the token", async () => {
    const by = (name: string) => httpLog(a).find((l) => l.name === name);
    expect(by("no-token")?.status).toBe(401);
    expect(by("tokens")?.status).toBe(403);
    expect(by("settings")?.status).toBe(403);
    expect(by("mcp-tokens")?.status).toBe(403);
    expect(by("other-route")?.status).toBe(403);
    // A foreign target next to the agent's own workspaceId does not borrow its scope.
    expect(by("decoy-terminal")?.status).toBe(403);
    expect(by("decoy-project")?.status).toBe(403);
    // Nothing in a refusal gives away a credential.
    for (const line of httpLog(a)) expect(line.body).not.toContain(TEST_TOKEN);
  });

  it("listens on loopback and answers 401 to a call with no registered token", async () => {
    const info = readFileSync(a.stubLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { env: { BAND_SERVER_URL?: string } })
      .find((r) => r.env.BAND_SERVER_URL);
    const relay = info?.env.BAND_SERVER_URL ?? "";
    const res = await fetch(`${relay}${listChats("proj-relay-a")}`, {
      headers: { Cookie: "band_token=brt_not-issued" },
    });
    expect(res.status).toBe(401);
    // The hub's own shared token is no credential for the relay either.
    const withShared = await fetch(`${relay}${listChats("proj-relay-a")}`, {
      headers: { Cookie: `band_token=${TEST_TOKEN}` },
    });
    expect(withShared.status).toBe(401);
  });
});

describe("what an agent may call, and which ids it may take", () => {
  it("refuses a chat or browser id that belongs to a workspace on another worker", async () => {
    await m("chats.create", { workspaceId: "proj-relay-a", id: "a-owned-chat" });
    await m("browsers.create", { workspaceId: "proj-relay-a", id: "a-owned-browser" });

    await submit("proj-relay-b", "id-probe");
    const by = (name: string) => httpLog(b).find((l) => l.name === name);

    expect(by("b-chat-collide")?.status).toBe(403);
    expect(by("b-browser-collide")?.status).toBe(403);
    expect(by("b-chat-into-a")?.status).toBe(403);
    // Its own new ids are fine.
    expect(by("b-chat-own")?.status).toBe(200);
    expect(by("b-browser-own")?.status).toBe(200);

    // Worker A's chat and tab are untouched, and B's calls made nothing in A.
    const chats = await q<{ chats: Array<{ id: string }> }>("chats.list", {
      workspaceId: "proj-relay-a",
    });
    expect(chats.chats.filter((c) => c.id === "a-owned-chat")).toHaveLength(1);
    expect(chats.chats.map((c) => c.id)).not.toContain("fresh-id");
    const aChat = await q<{ chat: { workspaceId?: string } | null }>("chats.get", {
      chatId: "a-owned-chat",
    });
    expect(JSON.stringify(aChat)).toContain("proj-relay-a");
    const bChats = await q<{ chats: Array<{ id: string }> }>("chats.list", {
      workspaceId: "proj-relay-b",
    });
    expect(bChats.chats.map((c) => c.id)).not.toContain("a-owned-chat");
  });

  it("refuses a procedure that is not on the list, even in a router the list uses", async () => {
    const by = (name: string) => httpLog(b).find((l) => l.name === name);
    expect(by("projects-remove")?.status).toBe(403);
    expect(by("tokens-list")?.status).toBe(403);
    expect(by("chats-unlisted")?.status).toBe(403);
    expect(by("tasks-cancel")?.status).toBe(403);
    expect(by("workspaces-remove")?.status).toBe(403);
    // The project and A's workspace are still there.
    const { projects } = await q<{
      projects: Array<{ name: string; worktrees: Array<{ name: string }> }>;
    }>("projects.list");
    expect(projects.find((p) => p.name === "proj")?.worktrees.map((w) => w.name)).toContain(
      "relay-a",
    );
  });

  it("lists only procedures the hub has", async () => {
    const { RELAY_PROCEDURES } = await import("../src/server/services/relay-scope");
    const { appRouter } = await import("../src/server/api/router");
    const known = Object.keys(
      (appRouter._def as unknown as { procedures: Record<string, unknown> }).procedures,
    );
    for (const name of RELAY_PROCEDURES) expect(known).toContain(name);
  });
});

describe("the band CLI through the relay (S2)", () => {
  const cli = findCliBinary();

  it.skipIf(!cli)(
    "runs `band chats list` for its own workspace and is refused another's",
    async () => {
      // The agent's own environment, as the stub recorded it.
      const env = readFileSync(a.stubLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { env: { BAND_SERVER_URL?: string; BAND_TOKEN?: string } })
        .find((r) => r.env.BAND_TOKEN)?.env;
      expect(env?.BAND_SERVER_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const run = (workspace: string) =>
        new Promise<{ code: number | null; out: string }>((resolve) => {
          const child = spawn(cli as string, ["chats", "list", workspace, "--output", "json"], {
            env: {
              PATH: process.env.PATH,
              HOME: tmp("band-relay-cli-home-"),
              BAND_SERVER_URL: env?.BAND_SERVER_URL,
              BAND_TOKEN: env?.BAND_TOKEN,
            },
          });
          let out = "";
          child.stdout.on("data", (d) => {
            out += d;
          });
          child.stderr.on("data", (d) => {
            out += d;
          });
          child.on("close", (code) => resolve({ code, out }));
        });

      const own = await run("proj-relay-a");
      expect(own.code).toBe(0);
      expect(own.out).toContain("a-owned-chat");

      const other = await run("proj-relay-b");
      expect(other.code).not.toBe(0);
      expect(other.out).not.toContain("b-owned-chat");
      const hubs = await run("proj-main");
      expect(hubs.code).not.toBe(0);
    },
  );
});

describe("the band CLI on a worker", () => {
  const cli = findCliBinary();
  const cached = (w: Worker) => join(w.state, "bin", "band");

  it.skipIf(!cli)(
    "caches the hub's CLI in the worker's state dir and installs the skills",
    async () => {
      await waitFor(async () => (existsSync(cached(a)) ? true : undefined), {
        label: "worker caches the band CLI",
        timeoutMs: 30_000,
      });
      // The same bytes the hub has, saved with the owner-only directory around it.
      expect(readFileSync(cached(a)).equals(readFileSync(cli as string))).toBe(true);
      await waitFor(
        async () => (existsSync(join(a.home, ".agents/skills/band/SKILL.md")) ? true : undefined),
        { label: "worker installs the band skills", timeoutMs: 30_000 },
      );
    },
  );

  it.skipIf(!cli)("finds band in a terminal and runs it through the relay (S1, S3)", async () => {
    await waitFor(async () => (existsSync(cached(a)) ? true : undefined), {
      label: "worker caches the band CLI",
      timeoutMs: 30_000,
    });
    const created = await m<{ terminalId: string }>("terminal.create", {
      workspaceId: "proj-relay-a",
    });
    const socket = await TerminalSocket.open(server, {
      workspaceId: "proj-relay-a",
      terminalId: created.terminalId,
      token: TEST_TOKEN,
    });
    try {
      socket.type("echo found=$(command -v band)\r");
      await socket.waitForOutput(`found=${cached(a)}`);

      socket.type("band chats list proj-relay-a --output json >/dev/null; echo own=$?\r");
      await socket.waitForOutput("own=0");

      // The credential is scoped: another worker's workspace, the hub's own, and admin procedures are refused.
      socket.type("band chats list proj-relay-b --output json >/dev/null 2>&1; echo other=$?\r");
      await socket.waitForOutput("other=1");
      socket.type("band chats list proj-main --output json >/dev/null 2>&1; echo hub=$?\r");
      await socket.waitForOutput("hub=1");
      socket.type(
        `curl -s -o /dev/null -w 'admin=%{http_code}\\n' "$BAND_SERVER_URL/trpc/tokens.list" -H "Cookie: band_token=$BAND_TOKEN"\r`,
      );
      await socket.waitForOutput("admin=403");

      // The worker's session token never reaches the shell.
      socket.type("echo ws=$BAND_WORKSPACE_ID\r");
      await socket.waitForOutput("ws=proj-relay-a");
      socket.type(`echo leak=$(env | grep -c -e '${TEST_TOKEN}' -e 'bws_')\r`);
      await socket.waitForOutput("leak=0");
    } finally {
      await socket.close();
    }
  });

  it.skipIf(!cli)("gives the agent process band on its PATH (S2)", async () => {
    await waitFor(async () => (existsSync(cached(a)) ? true : undefined), {
      label: "worker caches the band CLI",
      timeoutMs: 30_000,
    });
    // Starts an agent after the CLI is cached, so its environment carries the PATH.
    await submit("proj-relay-a", "path-probe");
    const env = readFileSync(a.stubLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(
        (l) =>
          JSON.parse(l) as {
            env: {
              PATH?: string;
              BAND_SERVER_URL?: string;
              BAND_TOKEN?: string;
              BAND_WORKSPACE_ID?: string;
              LEAK?: boolean;
            };
          },
      )
      .reverse()
      .find((r) => r.env.BAND_TOKEN)?.env;
    expect(env?.PATH?.split(":")[0]).toBe(join(a.state, "bin"));
    expect(env?.BAND_WORKSPACE_ID).toBe("proj-relay-a");
    expect(env?.LEAK).toBe(false);
    const out = execFileSync(
      "sh",
      ["-c", "command -v band && band chats list proj-relay-a --output json"],
      {
        encoding: "utf8",
        env: {
          PATH: env?.PATH,
          HOME: tmp("band-relay-agent-home-"),
          BAND_SERVER_URL: env?.BAND_SERVER_URL,
          BAND_TOKEN: env?.BAND_TOKEN,
        },
      },
    );
    expect(out.split("\n")[0]).toBe(cached(a));
  });
});

describe("hooks through the relay (S3)", () => {
  it("delivers a hook sent from a terminal on the worker to the hub", async () => {
    // The chats that ran before ask for attention, which outranks a hook's `working` until it is cleared.
    await m("statuses.clearNeedsAttention", { workspaceId: "proj-relay-a" });
    const created = await m<{ terminalId: string }>("terminal.create", {
      workspaceId: "proj-relay-a",
    });
    const socket = await TerminalSocket.open(server, {
      workspaceId: "proj-relay-a",
      terminalId: created.terminalId,
      token: TEST_TOKEN,
    });
    try {
      // The shell sees the relay and a relay token, and none of the hub's or the worker's credentials.
      socket.type("echo server=$BAND_SERVER_URL tok=$(echo $BAND_TOKEN | cut -c1-4)\r");
      await socket.waitForOutput("tok=brt_");
      expect(socket.output).toMatch(/server=http:\/\/127\.0\.0\.1:\d+ tok=brt_/);
      expect(socket.output).not.toContain(`server=${server.url}`);
      socket.type(`echo leak=$(env | grep -c -e '${TEST_TOKEN}' -e 'bws_')\r`);
      await socket.waitForOutput("leak=0");

      // What `band notify` posts for a Claude Code hook, sent with the shell's own environment.
      socket.type(
        `curl -s -o /dev/null -w 'hook=%{http_code}\\n' -X POST "$BAND_SERVER_URL/trpc/statuses.notify" -H "Cookie: band_token=$BAND_TOKEN" -H 'content-type: application/json' -d "{\\"cwd\\":\\"$PWD\\",\\"payload\\":{\\"session_id\\":\\"relay-hook\\",\\"cwd\\":\\"$PWD\\",\\"hook_event_name\\":\\"UserPromptSubmit\\"},\\"agent\\":\\"claude-code\\",\\"dispatch\\":\\"terminal\\"}"\r`,
      );
      await socket.waitForOutput("hook=200");
    } finally {
      await socket.close();
    }
    const status = await waitFor(
      async () => {
        const data = await trpc<{ agent?: { status?: string } } | null>(
          server.url,
          "statuses.get",
          { workspaceId: "proj-relay-a" },
          "query",
        );
        return data?.agent?.status === "working" ? data.agent.status : undefined;
      },
      { label: "hook reaches the workspace status" },
    );
    expect(status).toBe("working");
  });

  it("refuses a hook for a workspace on another host", async () => {
    // Worker B's agent token must not report into worker A's workspace. The call
    // goes through the relay as a terminal on B would send it.
    const created = await m<{ terminalId: string }>("terminal.create", {
      workspaceId: "proj-relay-b",
    });
    const socket = await TerminalSocket.open(server, {
      workspaceId: "proj-relay-b",
      terminalId: created.terminalId,
      token: TEST_TOKEN,
    });
    try {
      socket.type(
        `curl -s -o /dev/null -w 'foreign=%{http_code}\\n' -X POST "$BAND_SERVER_URL/trpc/statuses.notify" -H "Cookie: band_token=$BAND_TOKEN" -H 'content-type: application/json' -d '{"cwd":"${worktreeOf(a, "relay-a")}","payload":{"session_id":"x"},"agent":"claude-code","dispatch":"terminal"}'\r`,
      );
      await socket.waitForOutput("foreign=403");
    } finally {
      await socket.close();
    }
  });
});

describe("system and editor calls on the worker (S4)", () => {
  it("opens a file that is in the worker's worktree, and does not find one on the hub's disk", async () => {
    writeFileSync(join(worktreeOf(a, "relay-a"), "only-on-worker.txt"), "x\n");
    const opened = await m<{ ok: boolean; external: boolean; filePath: string }>(
      "editor.openFile",
      { workspaceId: "proj-relay-a", filePath: "only-on-worker.txt" },
    );
    expect(opened).toMatchObject({ ok: true, external: false, filePath: "only-on-worker.txt" });

    // The hub's own checkout is not on the worker, so it is not found there.
    const outside = await trpcMutate(
      server.url,
      "editor.openFile",
      { workspaceId: "proj-relay-a", filePath: join(hubRepo, "hello.txt") },
      TEST_TOKEN,
    );
    expect(outside.status).toBe(404);
    expect(await outside.text()).toMatch(/File not found/);
  });

  it("formats a file with the config on the worker", async () => {
    writeFileSync(join(worktreeOf(a, "relay-a"), ".prettierrc"), JSON.stringify({ semi: false }));
    const formatted = await m<{ formatted: string; skipped: boolean }>("workspace.formatFile", {
      workspaceId: "proj-relay-a",
      filePath: "x.ts",
      content: "const a = 1;\n",
    });
    expect(formatted.skipped).toBe(false);
    expect(formatted.formatted).toBe("const a = 1\n");
  });

  it("lists the worker's worktrees and measures them on the worker", async () => {
    const { projects } = await q<{
      projects: Array<{
        project: string;
        worktrees: Array<{ branch: string; path: string; hostId?: string }>;
      }>;
    }>("services.resourcesProjects");
    const worktrees = projects.find((p) => p.project === "proj")?.worktrees ?? [];
    const remote = worktrees.find((w) => w.path === worktreeOf(a, "relay-a"));
    expect(remote?.hostId).toBe(a.hostId);
    expect(worktrees.find((w) => w.path === hubRepo)?.hostId).toBeUndefined();

    const size = await q<{
      worktrees: Array<{ path: string; sizeBytes: number; hostId?: string; error?: string }>;
    }>("services.resourcesProjectSize", { project: "proj" });
    const measured = size.worktrees.find((w) => w.path === worktreeOf(a, "relay-a"));
    expect(measured?.error).toBeUndefined();
    expect(measured?.sizeBytes).toBeGreaterThan(0);
  });
});

describe("removing a workspace while its worker is offline (S5)", () => {
  it("removes it at once and deletes the checkout when the worker reconnects", async () => {
    const workspaceId = await createWorkspace(b, "relay-c");
    const dir = worktreeOf(b, "relay-c");
    expect(existsSync(dir)).toBe(true);

    b.child.kill("SIGKILL");
    await b.exited;
    await waitFor(async () => ((await hostStatus(b)) === "offline" ? true : undefined), {
      label: "b offline",
      timeoutMs: 30_000,
    });

    await m("workspaces.remove", { project: "proj", name: "relay-c" });
    const { projects } = await q<{
      projects: Array<{ name: string; worktrees: Array<{ name: string }> }>;
    }>("projects.list");
    expect(projects.find((p) => p.name === "proj")?.worktrees.map((w) => w.name)).not.toContain(
      "relay-c",
    );
    // The worker could not be told, so the checkout is still there.
    expect(existsSync(dir)).toBe(true);
    expect(workspaceId).toBe("proj-relay-c");

    b = startWorkerProcess(b, "bwb_unused-because-the-session-token-is-saved");
    await waitFor(async () => ((await hostStatus(b)) === "online" ? true : undefined), {
      label: "b online again",
      timeoutMs: 30_000,
    });
    await waitFor(async () => (existsSync(dir) ? undefined : true), {
      label: "checkout removed",
      timeoutMs: 30_000,
    });
    // The worker deletes the branch after the directory.
    await waitFor(
      async () =>
        git(join(b.root, "proj"), "branch", "--list", "relay-c").trim() === "" ? true : undefined,
      { label: "branch deleted", timeoutMs: 30_000 },
    );
  }, 120_000);
});
