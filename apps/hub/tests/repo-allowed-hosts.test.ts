// Integration tests for repos limited to chosen hosts and for one host per branch. A real hub
// (production bundle, temp BAND_HOME, BAND_LOCAL_WORKER=off) and two real `band-worker` processes
// with their own temp HOMEs. Remotes are local bare repos.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "repo-allowed-hosts-secret";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");

interface RepoView {
  name: string;
  allowedHostIds: string[] | null;
  primaryHostId: string | null;
  clones: Array<{ hostId: string; path: string }>;
  worktrees: Array<{ name: string; hostId?: string; worktreeId: string }>;
}

interface TrpcFailure {
  error: { message: string; data: { existingWorktreeId?: string; existingHostId?: string } };
}

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });

/** A bare repo with one commit on main, standing in for a remote. */
function makeRemote(parent: string, name: string): string {
  const seed = join(parent, `${name}-seed`);
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "hello.txt"), `hello from ${name}\n`);
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  const bare = join(parent, `${name}.git`);
  git(parent, "clone", "-q", "--bare", seed, bare);
  git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
  return bare;
}

interface Worker {
  hostId: string;
  name: string;
  home: string;
  root: string;
  child: ChildProcess;
}

let server: ServerHandle;
let remotes: string;
let alpha: Worker;
let bravo: Worker;

const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const repo = async (name: string) =>
  (await q<{ repos: RepoView[] }>("repos.list")).repos.find((r) => r.name === name);

/** A mutation that must fail: the status and the parsed tRPC error. */
async function refused(procedure: string, input: unknown) {
  const res = await trpcMutate(server.url, procedure, input, TOKEN);
  return { status: res.status, body: (await res.json()) as TrpcFailure };
}

/** Calls a tool of the hub's MCP endpoint and returns the text the tool answered with. */
async function mcpTool(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  const res = await fetch(`${server.url}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Cookie: `band_token=${TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const raw = await res.text();
  const data = raw
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  const message = JSON.parse(data ?? raw) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  return { text: message.result.content[0].text, isError: message.result.isError === true };
}

async function startWorker(name: string, labels: string[]): Promise<Worker> {
  const home = tmp(`band-allowed-${name}-home-`);
  const root = tmp(`band-allowed-${name}-root-`);
  const state = tmp(`band-allowed-${name}-state-`);
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: name,
    labels,
  });
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
      env: { ...process.env, HOME: home, BAND_HOME: join(home, ".band") },
      stdio: "ignore",
    },
  );
  await waitFor(
    async () =>
      (await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list")).hosts.find(
        (h) => h.id === issued.hostId,
      )?.status === "online"
        ? true
        : undefined,
    { label: `${name} online`, timeoutMs: 20_000 },
  );
  return { hostId: issued.hostId, name, home, root, child };
}

beforeAll(async () => {
  const hubHome = createTmpHome("band-allowed-hub-");
  scratch.push(hubHome);
  remotes = tmp("band-allowed-remotes-");
  seedSettings(hubHome, { tokenSecret: TOKEN });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: { BAND_LOCAL_HOST: "off", BAND_SERVE_UI: "false" },
  });
  alpha = await startWorker("Alpha", ["pool=a"]);
  bravo = await startWorker("Bravo", ["pool=b"]);
}, 120_000);

afterAll(async () => {
  const exits = [alpha, bravo].filter(Boolean).map(
    (w) =>
      new Promise<void>((resolve) => {
        if (w.child.exitCode !== null || w.child.signalCode !== null) return resolve();
        w.child.once("exit", () => resolve());
        w.child.kill("SIGKILL");
      }),
  );
  await Promise.all(exits);
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("who may change the hosts of a repo", () => {
  it("answers 401 without a token and 403 to a non-admin device token, and stores nothing", async () => {
    const remote = makeRemote(remotes, "guarded");
    await m("repos.addByUrl", { remoteUrl: remote });
    const anon = await trpcMutate(
      server.url,
      "repos.update",
      { name: "guarded", allowedHostIds: [alpha.hostId] },
      "",
    );
    expect(anon.status).toBe(401);
    const device = await m<{ token: string }>("tokens.createDevice", { label: "plain" });
    const denied = await trpcMutate(
      server.url,
      "repos.update",
      { name: "guarded", allowedHostIds: [alpha.hostId] },
      device.token,
    );
    expect(denied.status).toBe(403);
    expect((await repo("guarded"))?.allowedHostIds).toBeNull();
  });
});

describe("the defaults a repo gets when it is added (S2)", () => {
  it("limits a repo added from a worker to that worker and makes it the primary", async () => {
    const remote = makeRemote(remotes, "epic");
    git(alpha.root, "clone", "-q", remote, "epic");
    await m("repos.addFromWorker", { hostId: alpha.hostId, path: join(alpha.root, "epic") });
    const added = await repo("epic");
    expect(added?.allowedHostIds).toEqual([alpha.hostId]);
    expect(added?.primaryHostId).toBe(alpha.hostId);
  });

  it("lets a repo added by URL run anywhere, and the first host to clone it becomes the primary", async () => {
    const remote = makeRemote(remotes, "shared");
    await m("repos.addByUrl", { remoteUrl: remote });
    const added = await repo("shared");
    expect(added?.allowedHostIds).toBeNull();
    expect(added?.primaryHostId).toBeNull();

    await m("worktrees.create", { repo: "shared", branch: "first", hostId: bravo.hostId });
    await m("worktrees.create", { repo: "shared", branch: "second", hostId: alpha.hostId });
    // The first clone decided. The second host's clone did not move it.
    const stored = await repo("shared");
    expect(stored?.allowedHostIds).toBeNull();
    expect(stored?.primaryHostId).toBe(bravo.hostId);
    expect(stored?.clones.map((c) => c.hostId).sort()).toEqual([alpha.hostId, bravo.hostId].sort());
  });

  it("takes the policy a caller chooses when adding by URL", async () => {
    const remote = makeRemote(remotes, "chosen");
    await m("repos.addByUrl", {
      remoteUrl: remote,
      allowedHostIds: [bravo.hostId],
      primaryHostId: bravo.hostId,
    });
    const added = await repo("chosen");
    expect(added?.allowedHostIds).toEqual([bravo.hostId]);
    expect(added?.primaryHostId).toBe(bravo.hostId);
  });

  it("edits the policy and refuses an empty list, an unknown host and a primary outside the list", async () => {
    await m("repos.update", { name: "shared", allowedHostIds: [alpha.hostId, bravo.hostId] });
    expect((await repo("shared"))?.allowedHostIds).toEqual([alpha.hostId, bravo.hostId]);
    await m("repos.update", { name: "shared", allowedHostIds: null });
    expect((await repo("shared"))?.allowedHostIds).toBeNull();

    expect((await refused("repos.update", { name: "shared", allowedHostIds: [] })).status).toBe(
      400,
    );
    const unknown = await refused("repos.update", { name: "shared", allowedHostIds: ["h-nope"] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.message).toContain("Unknown worker");
    const outside = await refused("repos.update", {
      name: "epic",
      primaryHostId: bravo.hostId,
    });
    expect(outside.status).toBe(400);
    expect(outside.body.error.message).toContain("must be one of the allowed workers");
  });
});

/** Where Bravo would clone `epic` by URL. The repo is limited to Alpha, so nothing may appear here. */
const epicCloneOnBravo = () => join(bravo.home, "band", "repos", "local", "epic");

describe("a repo limited to one host (S1)", () => {
  const message = () => `epic is only available on ${alpha.name}`;

  it("refuses an explicit host through tRPC, and clones nothing there", async () => {
    const res = await refused("worktrees.create", {
      repo: "epic",
      branch: "on-bravo",
      hostId: bravo.hostId,
    });
    expect(res.status).toBe(412);
    expect(res.body.error.message).toBe(message());
    expect(existsSync(epicCloneOnBravo())).toBe(false);
    expect(existsSync(join(bravo.root, ".band-worktrees", "epic"))).toBe(false);
    expect((await repo("epic"))?.clones.map((c) => c.hostId)).toEqual([alpha.hostId]);
  });

  it("refuses an explicit host through the MCP tool", async () => {
    const result = await mcpTool("band_worktrees_create", {
      repo: "epic",
      branch: "on-bravo-mcp",
      hostId: bravo.hostId,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(message());
    expect(existsSync(epicCloneOnBravo())).toBe(false);
  });

  it("refuses automatic placement that only another host fits", async () => {
    const res = await refused("worktrees.create", {
      repo: "epic",
      branch: "placed-on-bravo",
      placement: { labels: { pool: "b" } },
    });
    expect(res.status).toBe(412);
    expect(res.body.error.message).toContain(message());
    const viaMcp = await mcpTool("band_worktrees_create", {
      repo: "epic",
      branch: "placed-on-bravo-mcp",
      placement: { labels: { pool: "b" } },
    });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.text).toContain(message());
    expect(existsSync(epicCloneOnBravo())).toBe(false);
    // No runner was asked for a machine either.
    expect((await q<{ requests: unknown[] }>("hostRequests.list", {})).requests).toEqual([]);
  });

  it("places automatically on the allowed host", async () => {
    const created = await m<{ hostId?: string }>("worktrees.create", {
      repo: "epic",
      branch: "auto",
      placement: {},
    });
    expect(created.hostId).toBe(alpha.hostId);
  });

  it("accepts the allowed host, and lets the repo onto another host once the rule is widened", async () => {
    await m("worktrees.create", { repo: "epic", branch: "on-alpha", hostId: alpha.hostId });
    await m("repos.update", { name: "epic", allowedHostIds: [alpha.hostId, bravo.hostId] });
    const created = await m<{ hostId?: string }>("worktrees.create", {
      repo: "epic",
      branch: "now-on-bravo",
      hostId: bravo.hostId,
    });
    expect(created.hostId).toBe(bravo.hostId);
    await m("repos.update", { name: "epic", allowedHostIds: [alpha.hostId] });
  });

  it("refuses to record a folder on a host the repo is not allowed on", async () => {
    git(bravo.root, "clone", "-q", join(remotes, "epic.git"), "epic");
    const res = await refused("repos.addFromWorker", {
      hostId: bravo.hostId,
      path: join(bravo.root, "epic"),
    });
    expect(res.status).toBe(412);
    expect(res.body.error.message).toBe(message());
  });

  it("flags worktrees on a host that is no longer allowed and keeps their files", async () => {
    const before = await repo("epic");
    const onBravo = before?.worktrees.find((w) => w.name === "now-on-bravo");
    expect(onBravo).toBeDefined();
    const folder = join(bravo.root, ".band-worktrees", "epic", "now-on-bravo");
    expect(existsSync(folder)).toBe(true);

    // Narrow the rule again; the worktree on Bravo stays listed, flagged.
    await m("repos.update", { name: "epic", allowedHostIds: [alpha.hostId] });
    const listed = await q<{
      repos: Array<{ name: string; worktrees: Array<{ name: string; hostNotAllowed?: boolean }> }>;
    }>("repos.list");
    const worktrees = listed.repos.find((r) => r.name === "epic")?.worktrees ?? [];
    expect(worktrees.find((w) => w.name === "now-on-bravo")?.hostNotAllowed).toBe(true);
    expect(worktrees.find((w) => w.name === "on-alpha")?.hostNotAllowed).toBeUndefined();
    expect(existsSync(folder)).toBe(true);
    // It still opens: git answers on that worktree.
    const changes = await q<{ headBranch: string }>("worktree.getChanges", {
      worktreeId: onBravo?.worktreeId,
    });
    expect(changes.headBranch).toBe("now-on-bravo");
  });
});

describe("one host per branch (S3)", () => {
  it("refuses a branch that is on another host and names its worktree", async () => {
    const first = await m<{ hostId?: string }>("worktrees.create", {
      repo: "shared",
      branch: "feat-x",
      hostId: alpha.hostId,
    });
    expect(first.hostId).toBe(alpha.hostId);

    const res = await refused("worktrees.create", {
      repo: "shared",
      branch: "feat-x",
      hostId: bravo.hostId,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe(`feat-x is already on ${alpha.name}`);
    expect(res.body.error.data.existingWorktreeId).toBe(`shared-feat-x@${alpha.hostId}`);
    expect(res.body.error.data.existingHostId).toBe(alpha.hostId);
    expect(existsSync(join(bravo.root, ".band-worktrees", "shared", "feat-x"))).toBe(false);

    const viaMcp = await mcpTool("band_worktrees_create", {
      repo: "shared",
      branch: "feat-x",
      hostId: bravo.hostId,
    });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.text).toContain(`feat-x is already on ${alpha.name}`);
  });

  it("still answers a repeat on the same host with the existing worktree", async () => {
    const again = await m<{ hostId?: string; path: string }>("worktrees.create", {
      repo: "shared",
      branch: "feat-x",
      hostId: alpha.hostId,
    });
    expect(again.hostId).toBe(alpha.hostId);
    expect(again.path).toContain("feat-x");
  });

  it("refuses the branch when placement would choose another host", async () => {
    const res = await refused("worktrees.create", {
      repo: "shared",
      branch: "feat-x",
      placement: { labels: { pool: "b" } },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe(`feat-x is already on ${alpha.name}`);
  });
});
