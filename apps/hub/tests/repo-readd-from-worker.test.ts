// Integration tests for adding a repo that already exists from a second worker, and for a repo
// whose primary host has no default-branch checkout. A real hub (production bundle, temp
// BAND_HOME, BAND_LOCAL_HOST=off) and two real `band-worker` processes with their own temp HOME,
// root and state dir. Remotes are local bare repos.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

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

const TOKEN = "repo-readd-secret";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");

interface RepoView {
  name: string;
  defaultBranch: string;
  primaryHostId: string | null;
  mainMissing: { hostId: string } | null;
  clones: Array<{ hostId: string; path: string }>;
  worktrees: Array<{ worktreeId: string; branch: string; hostId?: string }>;
}

interface Added extends RepoView {
  existed?: true;
  clone?: { hostId: string; hostName: string; path: string };
}

interface Host {
  id: string;
  name: string;
  root: string;
  process: ChildProcess;
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

let server: ServerHandle;
let remotes: string;
let a: Host;
let b: Host;

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

async function startHost(name: string): Promise<Host> {
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: name,
  });
  const home = tmp(`band-readd-${name}-home-`);
  const root = tmp(`band-readd-${name}-root-`);
  const process_ = spawn(
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
      tmp(`band-readd-${name}-state-`),
    ],
    { env: { ...process.env, HOME: home, BAND_HOME: join(home, ".band") }, stdio: "ignore" },
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
  return { id: issued.hostId, name, root, process: process_ };
}

beforeAll(async () => {
  const hubHome = createTmpHome("band-readd-hub-");
  scratch.push(hubHome);
  remotes = tmp("band-readd-remotes-");
  seedSettings(hubHome, { tokenSecret: TOKEN });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: { BAND_LOCAL_HOST: "off", BAND_SERVE_UI: "false" },
  });
  a = await startHost("alpha");
  b = await startHost("bravo");
}, 120_000);

afterAll(async () => {
  a?.process.kill("SIGKILL");
  b?.process.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("a repo added again from a second worker (S4)", () => {
  it("registers that worker's clone, records its checkouts and reports the clone", async () => {
    const remote = makeRemote(remotes, "lib");
    git(a.root, "clone", "-q", remote, "lib");
    git(b.root, "clone", "-q", remote, "lib");

    await m("repos.addFromWorker", {
      hostId: a.id,
      path: join(a.root, "lib"),
      allowedHostIds: null,
    });
    expect((await repo("lib"))?.primaryHostId).toBe(a.id);

    const again = await m<Added>("repos.addFromWorker", {
      hostId: b.id,
      path: join(b.root, "lib"),
    });
    expect(again.existed).toBe(true);
    expect(again.clone).toEqual({ hostId: b.id, hostName: "bravo", path: join(b.root, "lib") });

    const view = await repo("lib");
    expect(view?.clones.map((c) => c.hostId).sort()).toEqual([a.id, b.id].sort());
    // The first host stays the primary until the user changes it, and B's main is hidden behind it.
    expect(view?.primaryHostId).toBe(a.id);
    await m("repos.update", { name: "lib", primaryHostId: b.id });
    const switched = await repo("lib");
    expect(switched?.primaryHostId).toBe(b.id);
    expect(switched?.worktrees.map((w) => w.worktreeId)).toContain(`lib-main@${b.id}`);
  });

  it("refuses a worker the repo is not allowed on, with the reason", async () => {
    const remote = makeRemote(remotes, "only-a");
    git(a.root, "clone", "-q", remote, "only-a");
    git(b.root, "clone", "-q", remote, "only-a");
    await m("repos.addFromWorker", { hostId: a.id, path: join(a.root, "only-a") });
    const res = await trpcMutate(
      server.url,
      "repos.addFromWorker",
      { hostId: b.id, path: join(b.root, "only-a") },
      TOKEN,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).toContain("only available on alpha");
  });
});

describe("a repo whose primary host has no default-branch checkout (S3)", () => {
  it("shows a main-missing marker, then lists main from another host once it has one", async () => {
    const remote = makeRemote(remotes, "tool");
    git(a.root, "clone", "-q", remote, "tool");
    git(join(a.root, "tool"), "checkout", "-q", "-b", "feat");
    git(b.root, "clone", "-q", remote, "tool");

    await m("repos.addFromWorker", {
      hostId: a.id,
      path: join(a.root, "tool"),
      allowedHostIds: null,
    });
    const solo = await repo("tool");
    expect(solo?.primaryHostId).toBe(a.id);
    expect(solo?.mainMissing).toEqual({ hostId: a.id });
    expect(solo?.worktrees.map((w) => w.worktreeId)).not.toContain(`tool-main@${b.id}`);

    await m("repos.addFromWorker", { hostId: b.id, path: join(b.root, "tool") });
    const after = await repo("tool");
    // A stays the primary, but main is listed from B because A has none checked out.
    expect(after?.primaryHostId).toBe(a.id);
    expect(after?.mainMissing).toBeNull();
    expect(after?.worktrees.map((w) => w.worktreeId)).toContain(`tool-main@${b.id}`);
  });
});
