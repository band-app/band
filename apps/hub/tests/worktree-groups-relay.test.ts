// Integration test for worktree groups on a worker. A real `band-worker` dials a real hub (the
// production bundle on a random port, auth on). A chat on the worker (built-in `band` MCP server) and a
// shell on the worker (the relay, with `curl`) create a child of a grouped worktree, and the child joins the
// parent's group. The relay lets an agent list groups and assign its own host's worktrees, never change groups.

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
// A worktree on the worker is named after its host.
const wt = (repo: string, branch: string) => toWorktreeId(repo, branch, hostId);

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
  groupId: string | null;
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

let groupG: string;
let groupH: string;
let sock: TerminalSocket;

/** Runs a relay call from the shell on the worker and returns the HTTP status it printed. */
let seq = 0;
async function relayStatus(procedure: string, body: object, query = false): Promise<number> {
  const label = `rs${seq++}`;
  const request = query
    ? `"$BAND_SERVER_URL/trpc/${procedure}"`
    : `-X POST "$BAND_SERVER_URL/trpc/${procedure}" -H 'content-type: application/json' -d '${JSON.stringify(body)}'`;
  sock.type(
    `curl -s -o /dev/null -w '${label}=%{http_code}\\n' ${request} -H "Cookie: band_token=$BAND_TOKEN"\r`,
  );
  // The shell echoes the command with `%{http_code}` in it, so only a printed number counts.
  const status = await waitFor(
    () => {
      const hit = new RegExp(`${label}=(\\d{3})`).exec(sock.output);
      return hit ? Number(hit[1]) : undefined;
    },
    { label: `${procedure} status`, timeoutMs: 20_000 },
  );
  return status as number;
}

beforeAll(async () => {
  const hubHome = createTmpHome("band-groups-hub-");
  scratch.push(hubHome);
  const hubBorko = join(tmp("band-groups-hubborko-"), "borko");
  const hubSvc = join(tmp("band-groups-hubsvc-"), "svc");
  initRepo(hubBorko);
  initRepo(hubSvc);
  seedSettings(hubHome, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  seedState(hubHome, {
    groups: [
      { id: "g-work", name: "Work", color: "#ff0000" },
      { id: "g-home", name: "Home", color: "#00ff00" },
    ],
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
  groupG = "g-work";
  groupH = "g-home";
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
    hostName: "groups-worker",
    labels: [],
  });
  hostId = issued.hostId;

  workerHome = tmp("band-groups-home-");
  const root = tmp("band-groups-root-");
  const workerBorko = join(root, "borko");
  const workerSvc = join(root, "svc");
  initRepo(workerBorko);
  initRepo(workerSvc);
  httpLogFile = join(workerHome, "http-log.jsonl");
  const call = (name: string, repo: string, branch: string) => ({
    mcpCall: { name, server: "band", tool: "worktrees_create", args: { repo, branch } },
  });
  writeFileSync(
    join(workerHome, "scenario.json"),
    JSON.stringify({
      turns: [
        { match: "^start-svc", steps: [call("svc-call", "svc", "from-chat"), { say: "done" }] },
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
      tmp("band-groups-state-"),
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
  await m("worktrees.create", {
    repo: "borko",
    branch: "start",
    hostId,
    hostRepoPath: workerBorko,
    groupId: groupG,
  });
  await m("worktrees.create", { repo: "svc", branch: "seed", hostId, hostRepoPath: workerSvc });
  const created = await m<{ terminalId: string }>("terminal.create", {
    worktreeId: wt("borko", "start"),
  });
  sock = await TerminalSocket.open(server, {
    worktreeId: wt("borko", "start"),
    terminalId: created.terminalId,
    token: TEST_TOKEN,
  });
}, 180_000);

afterAll(async () => {
  await sock?.close();
  workerChild?.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("worktree groups through a worker", () => {
  it("puts a worktree created with groupId in that group, and others in none", async () => {
    expect((await worktreeOf(wt("borko", "start")))?.groupId).toBe(groupG);
    expect((await worktreeOf(wt("svc", "seed")))?.groupId).toBeNull();
  });

  it("gives a child created by a chat through the built-in MCP tool the parent's group (S2)", async () => {
    await say("groups-chat", wt("borko", "start"), "start-svc");
    expect(httpLog().find((l) => l.name === "svc-call")?.status).toBe(200);
    const child = await waitFor(() => worktreeOf(wt("svc", "from-chat")), {
      label: "child listed",
    });
    expect(child?.groupId).toBe(groupG);
  });

  it("gives a child created from a shell through the relay the parent's group (S2)", async () => {
    expect(await relayStatus("worktrees.create", { repo: "svc", branch: "from-shell" })).toBe(200);
    const child = await waitFor(() => worktreeOf(wt("svc", "from-shell")), {
      label: "shell child listed",
    });
    expect(child?.groupId).toBe(groupG);
  });

  it("moves only the parent, or the parent and its children, with setGroup (S3)", async () => {
    await m("worktrees.setGroup", { worktreeId: wt("borko", "start"), groupId: groupH });
    expect((await worktreeOf(wt("borko", "start")))?.groupId).toBe(groupH);
    expect((await worktreeOf(wt("svc", "from-chat")))?.groupId).toBe(groupG);
    expect((await worktreeOf(wt("svc", "from-shell")))?.groupId).toBe(groupG);

    await m("worktrees.setGroup", {
      worktreeId: wt("borko", "start"),
      groupId: groupG,
      withChildren: true,
    });
    for (const branch of ["from-chat", "from-shell"]) {
      expect((await worktreeOf(wt("svc", branch)))?.groupId).toBe(groupG);
    }
    await m("worktrees.setGroup", {
      worktreeId: wt("borko", "start"),
      groupId: groupH,
      withChildren: true,
    });
    for (const id of [wt("borko", "start"), wt("svc", "from-chat"), wt("svc", "from-shell")]) {
      expect((await worktreeOf(id))?.groupId, id).toBe(groupH);
    }
  });

  it("lets an agent list groups and assign its own host's worktrees, nothing else (S4)", async () => {
    expect(await relayStatus("groups.list", {}, true)).toBe(200);
    expect(await relayStatus("groups.create", { name: "Sneaky" })).toBe(403);
    expect(await relayStatus("groups.update", { id: groupG, name: "Renamed" })).toBe(403);
    expect(await relayStatus("groups.remove", { id: groupG })).toBe(403);
    expect(await relayStatus("groups.reorder", { ids: [groupH, groupG] })).toBe(403);

    expect(
      await relayStatus("worktrees.setGroup", { worktreeId: wt("svc", "seed"), groupId: groupG }),
    ).toBe(200);
    expect((await worktreeOf(wt("svc", "seed")))?.groupId).toBe(groupG);
    // withChildren would move worktrees the relay did not check.
    expect(
      await relayStatus("worktrees.setGroup", {
        worktreeId: wt("borko", "start"),
        groupId: groupG,
        withChildren: true,
      }),
    ).toBe(403);
    // A worktree on the hub's own machine is not on this worker's host.
    expect(
      await relayStatus("worktrees.setGroup", {
        worktreeId: toWorktreeId("borko", "main", "local"),
        groupId: groupG,
      }),
    ).toBe(403);
    expect((await worktreeOf(toWorktreeId("borko", "main", "local")))?.groupId).toBeNull();

    const { groups } = await q<{ groups: Array<{ id: string; name: string }> }>("groups.list");
    expect(groups.map((g) => g.name)).toEqual(["Work", "Home"]);
  });

  it("lets an agent title its own worker's worktrees, not another worker's (rename S7)", async () => {
    const titleOf = async (id: string) =>
      ((await worktreeOf(id)) as { title?: string | null } | undefined)?.title;
    expect(
      await relayStatus("worktrees.setTitle", { worktreeId: wt("svc", "seed"), title: "Seeded" }),
    ).toBe(200);
    expect(await titleOf(wt("svc", "seed"))).toBe("Seeded");
    // A worktree on the hub's own machine is not on this worker.
    const local = toWorktreeId("borko", "main", "local");
    expect(await relayStatus("worktrees.setTitle", { worktreeId: local, title: "Nope" })).toBe(403);
    expect(await titleOf(local)).toBeNull();
  });
});
