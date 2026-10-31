// Integration test for worktrees an agent starts on another host. Two real `band-worker`s (A and B, each with its
// own HOME) dial a real hub. A shell on A calls `worktrees.create` with `hostId` B through the relay, the way
// `band worktrees create --host B` does, and a chat on A does the same through the built-in `band` MCP server (the
// scripted ACP agent calls it with the URL and headers Band gave the session). The hub decides: the setting, the
// target's state and the repo's allowed hosts. The host list an agent gets through the relay is redacted.

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
import { toWorktreeId } from "@band-app/shared/worktree-id";
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

import { WORKER_BIN } from "./helpers/worker-bin";

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

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "hello.txt"), "hello\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

interface Worker {
  hostId: string;
  home: string;
  root: string;
  child: ChildProcess;
  httpLog: string;
}

let server: ServerHandle;
let a: Worker;
let b: Worker;
const wt = (repo: string, branch: string, w: Worker) => toWorktreeId(repo, branch, w.hostId);

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

interface Listed {
  worktreeId: string;
  hostId?: string;
  origin: { worktreeId: string; chatId?: string; terminalId?: string } | null;
}
const worktreeOf = async (id: string): Promise<Listed | undefined> => {
  const { repos } = await q<{ repos: Array<{ worktrees: Listed[] }> }>("repos.list");
  return repos.flatMap((r) => r.worktrees).find((w) => w.worktreeId === id);
};

async function startWorker(label: string, hubRepos: string[], scenario?: object): Promise<Worker> {
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: `worker-${label}`,
    labels: [`name=${label}`],
  });
  const home = tmp(`band-xhost-${label}-home-`);
  const root = tmp(`band-xhost-${label}-root-`);
  for (const repo of hubRepos) initRepo(join(root, repo));
  const httpLog = join(home, "http-log.jsonl");
  if (scenario) writeFileSync(join(home, "scenario.json"), JSON.stringify(scenario));
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
      tmp(`band-xhost-${label}-state-`),
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
    { label: `worker ${label} online`, timeoutMs: 20_000 },
  );
  return { hostId: issued.hostId, home, root, child, httpLog };
}

const httpLine = (w: Worker, name: string): { status: number; body: string } | undefined =>
  existsSync(w.httpLog)
    ? readFileSync(w.httpLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { name: string; status: number; body: string })
        .find((l) => l.name === name)
    : undefined;

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

/** Runs curl in a shell on A. The body lands in a file so the test can read what the relay answered. */
class Shell {
  private n = 0;
  constructor(
    private readonly socket: TerminalSocket,
    private readonly dir: string,
  ) {}
  async call(
    kind: "trpc" | "mcp",
    path: string,
    body: unknown,
    method: "POST" | "GET" = "POST",
  ): Promise<{ status: number; body: string }> {
    const id = `c${++this.n}`;
    const out = join(this.dir, `${id}.out`);
    const code = join(this.dir, `${id}.code`);
    const data = method === "POST" ? `-d '${JSON.stringify(body)}'` : "";
    const headers = kind === "mcp" ? "-H 'accept: application/json, text/event-stream'" : "";
    // The marker's `$((0+1))` is only expanded once the shell runs the line, so the typed echo cannot match it.
    this.socket.type(
      `curl -s -o ${out} -w '%{http_code}' -X ${method} "$BAND_SERVER_URL${path}" -H "Cookie: band_token=$BAND_TOKEN" -H 'content-type: application/json' ${headers} ${data} > ${code}; echo fin-${id}-$((0+1))\r`,
    );
    await this.socket.waitForOutput(`fin-${id}-1`);
    return {
      status: Number(readFileSync(code, "utf8")),
      body: existsSync(out) ? readFileSync(out, "utf8") : "",
    };
  }
}

let shell: Shell;
let socket: TerminalSocket;

beforeAll(async () => {
  const hubHome = createTmpHome("band-xhost-hub-");
  scratch.push(hubHome);
  const hubRepos = ["proj", "only-a"].map((name) => {
    const dir = join(tmp(`band-xhost-hub-${name}-`), name);
    initRepo(dir);
    return { name, dir };
  });
  seedSettings(hubHome, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  seedState(hubHome, {
    repos: hubRepos.map(({ name, dir }) => ({
      name,
      path: dir,
      defaultBranch: "main",
      worktrees: [{ branch: "main", path: dir }],
    })),
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

  const call = (name: string, repo: string, branch: string, hostId: string) => ({
    mcpCall: { name, server: "band", tool: "worktrees_create", args: { repo, branch, hostId } },
  });
  b = await startWorker("b", ["proj", "only-a"]);
  a = await startWorker("a", ["proj", "only-a"], {
    turns: [
      { match: "^mcp-to-b", steps: [call("mcp-b", "proj", "mcp-made", b.hostId), { say: "done" }] },
      {
        match: "^mcp-refused",
        steps: [call("mcp-no", "only-a", "mcp-nope", b.hostId), { say: "done" }],
      },
    ],
  });
  // Map each repo on each worker with a first worktree.
  for (const w of [a, b]) {
    for (const repo of ["proj", "only-a"]) {
      await m("worktrees.create", {
        repo,
        branch: `seed-${w === a ? "a" : "b"}`,
        hostId: w.hostId,
        hostRepoPath: join(w.root, repo),
      });
    }
  }
  // `only-a` may run on A only.
  await m("repos.update", { name: "only-a", allowedHostIds: [a.hostId] });

  const created = await m<{ terminalId: string }>("terminal.create", {
    worktreeId: wt("proj", "seed-a", a),
  });
  socket = await TerminalSocket.open(server, {
    worktreeId: wt("proj", "seed-a", a),
    terminalId: created.terminalId,
    token: TEST_TOKEN,
  });
  shell = new Shell(socket, a.home);
}, 240_000);

afterAll(async () => {
  await socket?.close();
  a?.child.kill("SIGKILL");
  b?.child.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

/** The files under `dir` (recursively) whose bytes contain `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesContaining(path, needle));
    else if (entry.isFile() && readFileSync(path).includes(needle)) found.push(path);
  }
  return found;
}

describe("tokens on disk (S5)", () => {
  const cli = findCliBinary();

  it.skipIf(!cli)(
    "leaves no admin or device token under the HOME of a CLI flow or of a worker",
    async () => {
      const cliHome = tmp("band-xhost-cli-home-");
      const env = {
        ...process.env,
        HOME: cliHome,
        BAND_HOME: join(cliHome, ".band"),
        BAND_SERVER_URL: server.url,
        BAND_TOKEN: TEST_TOKEN,
      };
      const band = (token: string, ...args: string[]) =>
        execFileSync(cli as string, args, { env: { ...env, BAND_TOKEN: token }, encoding: "utf8" });

      // Connect with the admin token, mint a device token, then connect with that one.
      expect(band(TEST_TOKEN, "hosts", "list")).toContain("worker-a");
      const created = JSON.parse(
        band(TEST_TOKEN, "tokens", "create-device", "--admin", "--output", "json"),
      ) as { token?: string; secret?: string };
      const device = created.token ?? created.secret;
      expect(device).toBeTruthy();
      expect(band(device as string, "worktrees", "list", "--output", "json")).toContain(
        "worktrees",
      );

      // The hub's own HOME keeps its admin token in settings.json (see docs/agent-host-access.md),
      // so only the HOMEs of the CLI and of the workers are scanned.
      for (const home of [cliHome, a.home, b.home]) {
        expect(filesContaining(home, TEST_TOKEN)).toEqual([]);
        expect(filesContaining(home, device as string)).toEqual([]);
      }
    },
  );
});

describe("worktrees an agent starts on another host", () => {
  it("creates the worktree on B, linked to the A worktree, through the relay (S1)", async () => {
    const res = await shell.call("trpc", "/trpc/worktrees.create", {
      repo: "proj",
      branch: "relay-made",
      hostId: b.hostId,
    });
    expect(res.status).toBe(200);
    const made = await waitFor(() => worktreeOf(wt("proj", "relay-made", b)), {
      label: "relay worktree listed on B",
    });
    expect(made?.hostId).toBe(b.hostId);
    expect(made?.origin?.worktreeId).toBe(wt("proj", "seed-a", a));
    expect(await worktreeOf(wt("proj", "relay-made", a))).toBeUndefined();
  });

  it("creates the worktree on B, linked to the chat, through the MCP tool (S1)", async () => {
    await say("xhost-chat", wt("proj", "seed-a", a), "mcp-to-b");
    expect(httpLine(a, "mcp-b")?.status).toBe(200);
    const made = await waitFor(() => worktreeOf(wt("proj", "mcp-made", b)), {
      label: "mcp worktree listed on B",
    });
    expect(made?.origin).toMatchObject({
      worktreeId: wt("proj", "seed-a", a),
      chatId: "xhost-chat",
    });
  });

  it("keeps the calling worker as the default host", async () => {
    const res = await shell.call("trpc", "/trpc/worktrees.create", {
      repo: "proj",
      branch: "default-host",
    });
    expect(res.status).toBe(200);
    expect((await worktreeOf(wt("proj", "default-host", a)))?.hostId).toBe(a.hostId);
  });

  it("refuses a repo that is not allowed on B, by relay and by MCP (S2)", async () => {
    const res = await shell.call("trpc", "/trpc/worktrees.create", {
      repo: "only-a",
      branch: "not-on-b",
      hostId: b.hostId,
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/only available on/i);
    expect(await worktreeOf(wt("only-a", "not-on-b", b))).toBeUndefined();

    await say("xhost-no-chat", wt("proj", "seed-a", a), "mcp-refused");
    expect(httpLine(a, "mcp-no")?.body).toMatch(/only available on/i);
  });

  it("answers an unknown host and the hub's own machine with a reason (S2)", async () => {
    const unknown = await shell.call("trpc", "/trpc/worktrees.create", {
      repo: "proj",
      branch: "no-such-host",
      hostId: "h-000000000000",
    });
    expect(unknown.status).toBe(403);
    expect(unknown.body).toContain("No worker");
    const hub = await shell.call("trpc", "/trpc/worktrees.create", {
      repo: "proj",
      branch: "on-hub",
      hostId: "local",
    });
    expect(hub.status).toBe(403);
    expect(hub.body).toContain("hub's own machine");
  });

  it("shows agents a host list with no roots, tools or tokens, and still refuses runners (S3)", async () => {
    const hosts = await shell.call("trpc", "/trpc/hosts.list", undefined, "GET");
    expect(hosts.status).toBe(200);
    const list = JSON.parse(hosts.body).result.data.hosts as Array<Record<string, unknown>>;
    const seenB = list.find((h) => h.id === b.hostId);
    expect(seenB).toMatchObject({
      name: "worker-b",
      status: "online",
      labels: ["name=b"],
      os: process.platform,
    });
    expect(Object.keys(seenB ?? {}).sort()).toEqual([
      "agents",
      "arch",
      "capabilities",
      "id",
      "labels",
      "mode",
      "name",
      "os",
      "status",
    ]);
    expect(hosts.body).not.toContain(b.root);
    expect(hosts.body).not.toContain(TEST_TOKEN);

    // An encoded path names the same procedure and gets the same redaction.
    const encoded = await shell.call("trpc", "/trpc/hosts%2Elist", undefined, "GET");
    expect(encoded.body).not.toContain(b.root);
    expect(encoded.body).toBe(hosts.body);

    const mcp = await shell.call("mcp", "/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "band_hosts_forAgents", arguments: {} },
    });
    expect(mcp.status).toBe(200);
    expect(mcp.body).toContain("worker-b");
    expect(mcp.body).not.toContain(b.root);

    const runners = await shell.call("trpc", "/trpc/runners.list", undefined, "GET");
    expect(runners.status).toBe(403);
    expect(runners.body).toContain("not available to agents");
  });

  it("refuses when the hub setting is off (S2)", async () => {
    await m("settings.update", { agents: { crossHostWorktrees: false } });
    try {
      const res = await shell.call("trpc", "/trpc/worktrees.create", {
        repo: "proj",
        branch: "setting-off",
        hostId: b.hostId,
      });
      expect(res.status).toBe(403);
      expect(res.body).toContain("Agents may not start worktrees on other workers");
      expect(await worktreeOf(wt("proj", "setting-off", b))).toBeUndefined();
      // The calling worker stays allowed.
      const own = await shell.call("trpc", "/trpc/worktrees.create", {
        repo: "proj",
        branch: "setting-off-own",
      });
      expect(own.status).toBe(200);
    } finally {
      await m("settings.update", { agents: { crossHostWorktrees: true } });
    }
  });

  it("refuses when B is offline (S2)", async () => {
    b.child.kill("SIGKILL");
    await waitFor(
      async () => {
        const { hosts } = await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list");
        return hosts.find((h) => h.id === b.hostId)?.status !== "online" ? true : undefined;
      },
      { label: "B offline", timeoutMs: 30_000 },
    );
    const res = await shell.call("trpc", "/trpc/worktrees.create", {
      repo: "proj",
      branch: "b-offline",
      hostId: b.hostId,
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/is (offline|lost)/);
  });
});
