// Integration test for origin links on a worker (plan section 15, step O.2). A real `band-worker` dials a real
// hub (the production bundle on a random port, auth on). A chat on the worker starts linked work in another
// repo through the built-in `band` MCP server, the way the scripted ACP agent calls it with the URL and headers
// Band gave the session. A shell on the worker does the same through the relay with `curl`, as `band worktrees
// create` does. The hub, not the caller, decides which chat or terminal the new worktree came from.

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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openStream, STUB_AGENT_PATH, TEST_TOKEN, turnEnded } from "./helpers/acp-chat";
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

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "hello.txt"), "hello\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

let server: ServerHandle;
let workerChild: ChildProcess;
let workerHome: string;
let hostId: string;
let httpLogFile: string;

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

interface ListedWorktree {
  worktreeId: string;
  hostId?: string;
  origin: {
    worktreeId: string;
    chatId?: string;
    terminalId?: string;
    removed: boolean;
    repo?: string;
    branch?: string;
  } | null;
  children: string[];
}
const worktreeOf = async (id: string): Promise<ListedWorktree | undefined> => {
  const { repos } = await q<{ repos: Array<{ worktrees: ListedWorktree[] }> }>("repos.list");
  return repos.flatMap((r) => r.worktrees).find((w) => w.worktreeId === id);
};

interface HttpLine {
  name: string;
  status: number;
  body: string;
}
const httpLog = (): HttpLine[] =>
  existsSync(httpLogFile)
    ? readFileSync(httpLogFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as HttpLine)
    : [];

async function say(chatId: string, worktreeId: string, text: string): Promise<void> {
  const stream = await openStream(server.url, chatId, { until: turnEnded, timeoutMs: 60_000 });
  const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
    body: JSON.stringify({ worktreeId, text }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
  await stream.events;
}

beforeAll(async () => {
  const hubHome = createTmpHome("band-origin-hub-");
  scratch.push(hubHome);
  const hubBorko = join(tmp("band-origin-hubborko-"), "borko");
  const hubSvc = join(tmp("band-origin-hubsvc-"), "svc");
  initRepo(hubBorko);
  initRepo(hubSvc);
  seedSettings(hubHome, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  seedState(hubHome, {
    repos: [
      {
        name: "borko",
        path: hubBorko,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: hubBorko }],
      },
      {
        name: "svc",
        path: hubSvc,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: hubSvc }],
      },
    ],
  });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: {
      BAND_SERVE_UI: "false",
      BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
      BAND_TEST_ACP_STATE: join(hubHome, "acp-state"),
    },
  });

  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: "origin-worker",
    labels: [],
  });
  hostId = issued.hostId;

  workerHome = tmp("band-origin-home-");
  const root = tmp("band-origin-root-");
  const workerBorko = join(root, "borko");
  const workerSvc = join(root, "svc");
  initRepo(workerBorko);
  initRepo(workerSvc);
  httpLogFile = join(workerHome, "http-log.jsonl");
  const call = (name: string, repo: string, branch: string, extra: object = {}) => ({
    mcpCall: { name, server: "band", tool: "worktrees_create", args: { repo, branch, ...extra } },
  });
  writeFileSync(
    join(workerHome, "scenario.json"),
    JSON.stringify({
      turns: [
        { match: "^start-svc", steps: [call("svc-call", "svc", "from-chat"), { say: "done" }] },
        {
          match: "^start-grandchild",
          steps: [call("grandchild-call", "borko", "grandchild"), { say: "done" }],
        },
        {
          // Claims another host. The built-in server does not take it on trust.
          match: "^start-elsewhere",
          steps: [call("elsewhere-call", "svc", "elsewhere", { hostId: "local" }), { say: "done" }],
        },
        {
          match: "^start-none",
          steps: [call("none-call", "svc", "no-origin", { noOrigin: true }), { say: "done" }],
        },
      ],
    }),
  );
  workerChild = spawn(
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
      tmp("band-origin-state-"),
    ],
    {
      env: {
        ...process.env,
        HOME: workerHome,
        BAND_HOME: join(workerHome, ".band"),
        BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
        BAND_TEST_ACP_STATE: join(workerHome, "acp-state"),
        BAND_TEST_ACP_HTTP_LOG: httpLogFile,
        BAND_TEST_ACP_SCENARIO: join(workerHome, "scenario.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  workerChild.stdout?.on("data", () => undefined);
  workerChild.stderr?.on("data", () => undefined);
  await waitFor(
    async () => {
      const { hosts } = await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list");
      return hosts.find((h) => h.id === hostId)?.status === "online" ? true : undefined;
    },
    { label: "worker online", timeoutMs: 20_000 },
  );
  // The first worktree of a repo on the worker maps the repo there. The MCP tool needs that mapping.
  await m("worktrees.create", {
    repo: "borko",
    branch: "start",
    hostId,
    hostRepoPath: workerBorko,
  });
  await m("worktrees.create", { repo: "svc", branch: "seed", hostId, hostRepoPath: workerSvc });
}, 180_000);

afterAll(async () => {
  workerChild?.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("origin links through a worker", () => {
  it("records the worktree and chat a chat started work from, across repos (S1)", async () => {
    await say("origin-chat", "borko-start", "start-svc");
    const line = httpLog().find((l) => l.name === "svc-call");
    expect(line?.status).toBe(200);
    expect(line?.body).toContain("svc-from-chat");

    const child = await waitFor(() => worktreeOf("svc-from-chat"), { label: "child listed" });
    expect(child?.hostId).toBe(hostId);
    expect(child?.origin).toMatchObject({
      worktreeId: "borko-start",
      chatId: "origin-chat",
      removed: false,
      repo: "borko",
      branch: "start",
    });
    expect(child?.origin?.terminalId).toBeUndefined();
  });

  it("builds a tree when the child's own chat starts work (S3)", async () => {
    await say("child-chat", "svc-from-chat", "start-grandchild");
    expect(httpLog().find((l) => l.name === "grandchild-call")?.status).toBe(200);

    const grandchild = await worktreeOf("borko-grandchild");
    expect(grandchild?.origin).toMatchObject({
      worktreeId: "svc-from-chat",
      chatId: "child-chat",
    });
    const child = await worktreeOf("svc-from-chat");
    expect(child?.children).toEqual(["borko-grandchild"]);
    expect((await worktreeOf("borko-start"))?.children).toContain("svc-from-chat");
    expect((await worktreeOf("borko-start"))?.origin).toBeNull();
  });

  it("keeps a chat on a worker on that worker, and honours noOrigin", async () => {
    await say("elsewhere-chat", "borko-start", "start-elsewhere");
    const refused = httpLog().find((l) => l.name === "elsewhere-call");
    expect(refused?.body).toContain("on that worker only");
    expect(await worktreeOf("svc-elsewhere")).toBeUndefined();

    await say("none-chat", "borko-start", "start-none");
    expect(httpLog().find((l) => l.name === "none-call")?.status).toBe(200);
    expect((await worktreeOf("svc-no-origin"))?.origin).toBeNull();
  });

  it("sets the origin from a shell on the worker, with its terminal, and ignores forged identity (S2)", async () => {
    const created = await m<{ terminalId: string }>("terminal.create", {
      worktreeId: "borko-start",
    });
    const socket = await TerminalSocket.open(server, {
      worktreeId: "borko-start",
      terminalId: created.terminalId,
      token: TEST_TOKEN,
    });
    const post = (label: string, body: object, extraHeader = "") =>
      `curl -s -o /dev/null -w '${label}=%{http_code}\\n' -X POST "$BAND_SERVER_URL/trpc/worktrees.create" -H "Cookie: band_token=$BAND_TOKEN" -H 'content-type: application/json' ${extraHeader} -d '${JSON.stringify(body)}'\r`;
    try {
      socket.type(
        post("shell", { repo: "svc", branch: "from-shell" }, "-H 'x-band-chat-id: forged-chat'"),
      );
      await socket.waitForOutput("shell=200");
      // An origin on the hub's machine is not a worktree on this worker, so the relay refuses it.
      socket.type(post("foreign", { repo: "svc", branch: "from-foreign", origin: "borko-main" }));
      await socket.waitForOutput("foreign=403");
    } finally {
      await socket.close();
    }
    const child = await waitFor(() => worktreeOf("svc-from-shell"), {
      label: "shell child listed",
    });
    expect(child?.origin).toMatchObject({
      worktreeId: "borko-start",
      terminalId: created.terminalId,
    });
    expect(child?.origin?.chatId).toBeUndefined();
    expect(await worktreeOf("svc-from-foreign")).toBeUndefined();
  });

  it("reports the origin as removed once the parent is gone (S4)", async () => {
    await m("worktrees.remove", { repo: "borko", name: "grandchild" });
    await m("worktrees.remove", { repo: "svc", name: "from-chat" });
    const gone = await worktreeOf("svc-from-chat");
    expect(gone).toBeUndefined();
    // `from-shell` still points at `borko-start`, which exists. Remove that to see the flag.
    await m("worktrees.remove", { repo: "borko", name: "start" });
    const orphan = await worktreeOf("svc-from-shell");
    expect(orphan?.origin).toMatchObject({ worktreeId: "borko-start", removed: true });
    expect(orphan?.origin?.repo).toBeUndefined();
  });
});
