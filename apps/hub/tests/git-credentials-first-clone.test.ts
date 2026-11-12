// Integration test for the first clone of a repo on a worker with no git login of its own.
// A real hub (production bundle, temp BAND_HOME, BAND_LOCAL_HOST=off) and real `band-worker`
// processes, each with its own temp HOME. The remote is a local git HTTP server that needs basic
// auth and the vault holds its credential. Fresh workers start with --hub-git-credentials-only,
// so only the hub can give them a credential for the clone it asks for.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GitHttpAuthStub, startGitHttpAuthStub } from "./fixtures/git-http-auth-stub";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { removeTmpHome } from "./helpers/tmp-home";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "git-credentials-no-checkout-secret";
const GIT_TOKEN = "gitpat_s3cr3t_0123456789abcdef";
const GIT_USER = "band-bot";

import { WORKER_BIN } from "./helpers/worker-bin";

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

const identity = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity } });

/** The environment without the `BAND_*` variables of a session that runs inside a Band worker. */
const cleanEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("BAND_")));

let server: ServerHandle;
let stub: GitHttpAuthStub;
const workers: ChildProcess[] = [];
let hubHome: string;

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

const online = (hostId: string) =>
  waitFor(
    async () =>
      (await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list")).hosts.find(
        (h) => h.id === hostId,
      )?.status === "online"
        ? true
        : undefined,
    { label: `worker ${hostId} online`, timeoutMs: 30_000 },
  );

interface TestWorker {
  hostId: string;
  root: string;
}

async function addWorker(): Promise<TestWorker> {
  const home = tmp("band-gitcred-fc-whome-");
  const root = tmp("band-gitcred-fc-root-");
  const state = tmp("band-gitcred-fc-state-");
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: "W",
  });
  workers.push(
    spawn(
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
        "--hub-git-credentials-only",
      ],
      {
        env: {
          ...cleanEnv(),
          ...identity,
          HOME: home,
          BAND_HOME: join(home, ".band"),
          GIT_CONFIG_NOSYSTEM: "1",
          BAND_TERMINAL_DAEMON: "0",
          SHELL_SESSIONS_DISABLE: "1",
          HISTFILE: "/dev/null",
        },
        stdio: "ignore",
      },
    ),
  );
  await online(issued.hostId);
  return { hostId: issued.hostId, root };
}

let source: TestWorker;

interface ListedWorktree {
  name: string;
  hostId?: string | null;
  path: string;
}

/** The worktree as the hub lists it for a worker, and the check that its folder exists there. */
const worktreeOn = async (branch: string, hostId: string) =>
  (await q<{ repos: Array<{ name: string; worktrees: ListedWorktree[] }> }>("repos.list")).repos
    .find((r) => r.name === "proj")
    ?.worktrees.find((x) => x.name === branch && x.hostId === hostId);

beforeAll(async () => {
  hubHome = createTmpHome("band-gitcred-fc-hub-");
  scratch.push(hubHome);
  const base = tmp("band-gitcred-fc-");
  const remotes = join(base, "remotes");
  mkdirSync(remotes, { recursive: true });
  const seed = join(base, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "hello.txt"), "private hello\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  git(base, "clone", "-q", "--bare", seed, join(remotes, "proj.git"));
  stub = await startGitHttpAuthStub(remotes, { username: GIT_USER, password: GIT_TOKEN });

  seedSettings(hubHome, { tokenSecret: TOKEN });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: { BAND_LOCAL_HOST: "off", BAND_SERVE_UI: "false" },
  });

  // The hub learns the repo from a worker that already holds it, then needs a clone elsewhere.
  source = await addWorker();
  const checkout = join(source.root, "proj");
  git(base, "clone", "-q", join(remotes, "proj.git"), checkout);
  git(checkout, "remote", "set-url", "origin", `${stub.url}/proj.git`);
  await m("repos.addFromWorker", { hostId: source.hostId, path: checkout });
  // A repo added from a worker is limited to it. Other workers may take it only when this is lifted.
  await m("repos.update", { name: "proj", allowedHostIds: null });
  await m("vault.put", {
    name: "stub-git",
    kind: "git",
    host: stub.host,
    pathPattern: "proj",
    username: GIT_USER,
    value: GIT_TOKEN,
  });
}, 120_000);

afterAll(async () => {
  await Promise.all(workers.map(stopWorker));
  await server?.close();
  await stub?.stop();
  for (const dir of scratch) removeTmpHome(dir);
});

async function stopWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const fallback = setTimeout(() => child.kill("SIGKILL"), 5_000);
  child.kill("SIGTERM");
  await exited;
  clearTimeout(fallback);
}

describe("the first clone of a repo on a worker with no git login", () => {
  it("creates a worktree there with the vault credential (S1)", async () => {
    const target = await addWorker();
    const before = stub.authenticated.length;
    await m("worktrees.create", { repo: "proj", branch: "feat-create", hostId: target.hostId });
    const created = await worktreeOn("feat-create", target.hostId);
    expect(created).toBeDefined();
    expect(existsSync(join(created?.path ?? "", "hello.txt"))).toBe(true);
    expect(stub.authenticated.length).toBeGreaterThan(before);
  }, 120_000);

  it("receives a moved worktree (S2)", async () => {
    const target = await addWorker();
    await m("worktrees.create", { repo: "proj", branch: "feat-move", hostId: source.hostId });
    const moved = await m<{ worktreeId: string; hostId: string }>("checkpoints.move", {
      worktreeId: toWorktreeId("proj", "feat-move", source.hostId),
      toHostId: target.hostId,
    });
    expect(moved.hostId).toBe(target.hostId);
    const arrived = await worktreeOn("feat-move", target.hostId);
    expect(arrived).toBeDefined();
    expect(existsSync(join(arrived?.path ?? "", "hello.txt"))).toBe(true);
  }, 180_000);
});
