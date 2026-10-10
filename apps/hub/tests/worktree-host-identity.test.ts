// A worktree is identified by host, repo and branch. A real hub with BAND_LOCAL_HOST=off and two
// real `band-worker` processes that both hold the same repo: the same branch on the two hosts is
// two worktrees, a worktree whose folder or branch was deleted outside Band can be removed, and a
// folder that vanished shows as missing and is pruned by the next scan. The hub's own machine
// gets no clone and no worktree.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { removeTmpHome } from "./helpers/tmp-home";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "worktree-host-identity-secret";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");

interface WorktreeView {
  name: string;
  hostId?: string;
  worktreeId: string;
  missing?: boolean;
}
interface RepoView {
  name: string;
  path: string;
  worktrees: WorktreeView[];
}
interface HostView {
  id: string;
  status: string;
}

interface Worker {
  hostId: string;
  child: ChildProcess;
  root: string;
}

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "hello.txt"), "hello\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

let server: ServerHandle;
let hubHome: string;
let hubRepo: string;
const workers: Worker[] = [];

const query = async <T>(procedure: string, input?: unknown) =>
  trpcData<T>(await trpcQuery(server.url, procedure, input, TOKEN));
const mutate = (procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TOKEN);
const listProj = async () =>
  (await query<{ repos: RepoView[] }>("repos.list")).repos.find((r) => r.name === "proj");

async function startWorker(label: string): Promise<Worker> {
  const root = tmp(`band-host-id-${label}-root-`);
  const state = tmp(`band-host-id-${label}-state-`);
  const home = tmp(`band-host-id-${label}-home-`);
  makeRepo(join(root, "proj"));
  const issued = await trpcData<{ token: string; hostId: string }>(
    await trpcMutate(server.url, "tokens.issueWorkerBootstrap", { hostName: label }, TOKEN),
  );
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
    { env: { ...process.env, HOME: home, BAND_HOME: join(home, ".band") }, stdio: "ignore" },
  );
  await waitFor(
    async () =>
      (await query<{ hosts: HostView[] }>("hosts.list")).hosts.find((h) => h.id === issued.hostId)
        ?.status === "online"
        ? true
        : undefined,
    { label: `worker ${label} online`, timeoutMs: 20_000 },
  );
  return { hostId: issued.hostId, child, root };
}

const createOn = (w: Worker, branch: string) =>
  mutate("worktrees.create", {
    repo: "proj",
    branch,
    hostId: w.hostId,
    hostRepoPath: join(w.root, "proj"),
  });
const checkoutOf = (w: Worker, branch: string) => join(w.root, ".band-worktrees", "proj", branch);

beforeAll(async () => {
  hubHome = createTmpHome("band-host-id-hub-");
  scratch.push(hubHome);
  hubRepo = join(tmp("band-host-id-hubrepo-"), "hubonly");
  makeRepo(hubRepo);
  seedSettings(hubHome, { tokenSecret: TOKEN });
  // "proj" lives on the workers. "hubonly" was checked out on the hub before the local host was
  // turned off, so it has a hub path and a local worktree record.
  seedState(hubHome, {
    repos: [
      { name: "proj", path: "", defaultBranch: "main", worktrees: [] },
      {
        name: "hubonly",
        path: hubRepo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: hubRepo }],
      },
    ],
  });
  server = await startServer({
    tmpHome: hubHome,
    env: { BAND_LOCAL_HOST: "off", BAND_SERVE_UI: "false" },
    remoteHost: false,
  });
  workers.push(await startWorker("a"), await startWorker("b"));
}, 180_000);

afterAll(async () => {
  await Promise.all(
    workers.map(
      (w) =>
        new Promise<void>((resolve) => {
          if (w.child.exitCode !== null || w.child.signalCode !== null) return resolve();
          w.child.once("exit", () => resolve());
          w.child.kill("SIGKILL");
        }),
    ),
  );
  await server?.close();
  for (const dir of scratch) removeTmpHome(dir);
});

describe("auth", () => {
  it("refuses host-qualified routes without a token", async () => {
    expect((await trpcQuery(server.url, "repos.list", undefined, "")).status).toBe(401);
    const res = await trpcMutate(server.url, "terminal.create", { worktreeId: "proj-feat@x" }, "");
    expect(res.status).toBe(401);
  });
});

describe("the same branch on two hosts", () => {
  it("is two worktrees with their own ids", async () => {
    const [a, b] = workers;
    expect((await createOn(a, "feat")).status).toBe(200);
    expect((await createOn(b, "feat")).status).toBe(200);
    const proj = await listProj();
    const feats = proj?.worktrees.filter((w) => w.name === "feat") ?? [];
    expect(feats.map((w) => w.worktreeId).sort()).toEqual(
      [`proj-feat@${a.hostId}`, `proj-feat@${b.hostId}`].sort(),
    );
  });

  it("opens a terminal on the host of the worktree that was picked", async () => {
    const [a, b] = workers;
    const created = await trpcData<{ terminalId: string }>(
      await mutate("terminal.create", { worktreeId: `proj-feat@${b.hostId}` }),
    );
    const socket = await TerminalSocket.open(server, {
      worktreeId: `proj-feat@${b.hostId}`,
      terminalId: created.terminalId,
      token: TOKEN,
    });
    try {
      socket.type("echo where=$PWD\r");
      await socket.waitForOutput(`where=${checkoutOf(b, "feat")}`);
    } finally {
      await socket.close();
    }
    expect(checkoutOf(a, "feat")).not.toBe(checkoutOf(b, "feat"));
  });
});

describe("BAND_LOCAL_HOST=off leaves the hub's own machine empty", () => {
  it("forgot the hub's worktree records and checkout at boot", async () => {
    const hubonly = (await query<{ repos: RepoView[] }>("repos.list")).repos.find(
      (r) => r.name === "hubonly",
    );
    expect(hubonly?.path).toBe("");
    expect(hubonly?.worktrees ?? []).toEqual([]);
    // The files stay.
    expect(existsSync(join(hubRepo, "hello.txt"))).toBe(true);
  });

  it("refuses to add a repo by path on the hub", async () => {
    const res = await mutate("repos.add", { path: hubRepo });
    expect(res.status).not.toBe(200);
  });

  it("makes no clone or worktree on the hub, and never lists a local host", async () => {
    const res = await mutate("worktrees.create", { repo: "hubonly", branch: "nope" });
    expect(res.status).not.toBe(200);
    expect(await res.text()).toMatch(/local host|host/i);
    expect(existsSync(join(hubHome, "band"))).toBe(false);
    const all = (await query<{ repos: RepoView[] }>("repos.list")).repos.flatMap(
      (r) => r.worktrees,
    );
    expect(all.filter((w) => !w.hostId || w.hostId === "local")).toEqual([]);
  });

  it("clones nothing on the hub when a repo is added from a worker or by URL", async () => {
    const [a, b] = workers;
    const bare = (name: string) => {
      const dir = join(tmp(`band-host-id-${name}-`), `${name}.git`);
      git(tmp("band-host-id-seed-"), "init", "-q", "--bare", "-b", "main", dir);
      return dir;
    };
    // A repo found on worker A whose remote is a local bare repo.
    const extraRemote = bare("extra");
    const extra = join(a.root, "extra");
    makeRepo(extra);
    git(extra, "remote", "add", "origin", extraRemote);
    git(extra, "push", "-q", "origin", "main");
    git(extra, "remote", "set-head", "origin", "main");
    expect((await mutate("repos.addFromWorker", { hostId: a.hostId, path: extra })).status).toBe(
      200,
    );
    // A repo added by URL.
    const urlSeed = join(tmp("band-host-id-urlseed-"), "byurl");
    makeRepo(urlSeed);
    const urlRemote = bare("byurl");
    git(urlSeed, "remote", "add", "origin", urlRemote);
    git(urlSeed, "push", "-q", "origin", "main");
    expect(
      (await mutate("repos.addByUrl", { remoteUrl: urlRemote, defaultBranch: "main" })).status,
    ).toBe(200);
    // Worktrees on the workers, which clone there and not on the hub.
    expect(
      (await mutate("worktrees.create", { repo: "extra", branch: "x1", hostId: b.hostId })).status,
    ).toBe(200);
    expect(
      (await mutate("worktrees.create", { repo: "byurl", branch: "x2", hostId: a.hostId })).status,
    ).toBe(200);
    expect(existsSync(join(hubHome, "band"))).toBe(false);
    const all = (await query<{ repos: RepoView[] }>("repos.list")).repos;
    expect(
      all.flatMap((r) => r.worktrees).filter((w) => !w.hostId || w.hostId === "local"),
    ).toEqual([]);
    expect(all.filter((r) => r.name === "extra" || r.name === "byurl").map((r) => r.path)).toEqual([
      "",
      "",
    ]);
  }, 120_000);
});

describe("a worktree that is gone from its host", () => {
  it("is removed even though its folder and branch were deleted outside Band", async () => {
    const [a] = workers;
    expect((await createOn(a, "gone")).status).toBe(200);
    const checkout = checkoutOf(a, "gone");
    rmSync(checkout, { recursive: true, force: true });
    git(join(a.root, "proj"), "worktree", "prune");
    git(join(a.root, "proj"), "branch", "-D", "gone");
    const res = await mutate("worktrees.remove", { repo: "proj", name: "gone", hostId: a.hostId });
    expect(res.status).toBe(200);
    const names = (await listProj())?.worktrees.map((w) => w.worktreeId) ?? [];
    expect(names).not.toContain(`proj-gone@${a.hostId}`);
    expect(git(join(a.root, "proj"), "worktree", "list")).not.toContain("gone");
  });

  it("shows as missing, and the next scan prunes it without deleting its branch", async () => {
    const [, b] = workers;
    expect((await createOn(b, "vanish")).status).toBe(200);
    rmSync(checkoutOf(b, "vanish"), { recursive: true, force: true });
    const id = `proj-vanish@${b.hostId}`;
    await waitFor(
      async () => {
        const wt = (await listProj())?.worktrees.find((w) => w.worktreeId === id);
        return wt?.missing ? true : undefined;
      },
      { label: "worktree marked missing", timeoutMs: 20_000 },
    );
    await waitFor(
      async () =>
        (await listProj())?.worktrees.some((w) => w.worktreeId === id) ? undefined : true,
      { label: "missing worktree pruned", timeoutMs: 30_000 },
    );
    expect(git(join(b.root, "proj"), "worktree", "list")).not.toContain("vanish");
    expect(git(join(b.root, "proj"), "branch", "--list", "vanish")).toContain("vanish");
  }, 120_000);
});
