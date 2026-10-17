// Integration test for git credentials when the hub holds no checkout of the repo. A real hub
// (production bundle, temp BAND_HOME, BAND_LOCAL_HOST=off) and a real `band-worker` with its own
// temp HOME. The repo is registered from the worker's checkout, so the hub knows only the remote
// URL it stored (`repos.path` is ""). The remote is a local git HTTP server that needs basic auth.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

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
import { TerminalSocket } from "./helpers/terminal-socket";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "git-credentials-no-checkout-secret";
const GIT_TOKEN = "gitpat_s3cr3t_0123456789abcdef";
const GIT_USER = "band-bot";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");

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
let worker: ChildProcess;
let hubHome: string;
let hubPort: number;
let hostId = "";
let worktreeId = "";

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

async function inWorkerShell(line: string): Promise<string> {
  const { terminalId } = await m<{ terminalId: string }>("terminal.create", { worktreeId });
  const socket = await TerminalSocket.open(server, { worktreeId, terminalId, token: TOKEN });
  try {
    socket.type(`${line}; echo END-$((6*7))\r`);
    await socket.waitForOutput("END-42", 30_000);
    return socket.output;
  } finally {
    await socket.close();
  }
}

const ask = (path: string) =>
  inWorkerShell(
    `printf 'protocol=http\\nhost=${stub.host}\\npath=${path}\\n\\n' | git credential fill 2>&1 | grep -v '^$' | head -6; true`,
  );

const workerOnline = () =>
  waitFor(
    async () =>
      (await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list")).hosts.find(
        (h) => h.id === hostId,
      )?.status === "online"
        ? true
        : undefined,
    { label: "worker online", timeoutMs: 30_000 },
  );

beforeAll(async () => {
  hubHome = createTmpHome("band-gitcred-nc-hub-");
  scratch.push(hubHome);
  const base = tmp("band-gitcred-nc-");
  const workerHome = tmp("band-gitcred-nc-whome-");
  const workerRoot = tmp("band-gitcred-nc-root-");
  const workerState = tmp("band-gitcred-nc-state-");
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

  // The worker's checkout, with the stub as origin and no credential in the URL.
  const checkout = join(workerRoot, "proj");
  git(base, "clone", "-q", join(remotes, "proj.git"), checkout);
  git(checkout, "remote", "set-url", "origin", `${stub.url}/proj.git`);

  seedSettings(hubHome, { tokenSecret: TOKEN });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: { BAND_LOCAL_HOST: "off", BAND_SERVE_UI: "false" },
  });
  hubPort = Number(new URL(server.url).port);

  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: "W",
  });
  hostId = issued.hostId;
  worker = spawn(
    process.execPath,
    [
      WORKER_BIN,
      "--hub",
      server.url,
      "--token",
      issued.token,
      "--root",
      workerRoot,
      "--state-dir",
      workerState,
    ],
    {
      env: { ...cleanEnv(), ...identity, HOME: workerHome, BAND_HOME: join(workerHome, ".band") },
      stdio: "ignore",
    },
  );
  await workerOnline();

  await m("repos.addFromWorker", { hostId, path: checkout });
  await m("vault.put", {
    name: "stub-git",
    kind: "git",
    host: stub.host,
    pathPattern: "proj",
    username: GIT_USER,
    value: GIT_TOKEN,
  });
  await m("worktrees.create", { repo: "proj", branch: "feat", hostId });
  worktreeId = toWorktreeId("proj", "feat", hostId);
}, 120_000);

afterAll(async () => {
  worker?.kill("SIGKILL");
  await server?.close();
  await stub?.stop();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("a repo the hub has no checkout of", () => {
  it("gives the worker the vault credential for the stored remote (S1)", async () => {
    const repo = (
      await q<{ repos: Array<{ name: string; path: string }> }>("repos.list")
    ).repos.find((r) => r.name === "proj");
    expect(repo?.path).toBe("");
    const before = stub.authenticated.length;
    expect(await ask("proj.git")).toContain(`password=${GIT_TOKEN}`);
    expect(await inWorkerShell("git ls-remote origin >/dev/null && echo LS-OK")).toContain("LS-OK");
    expect(stub.authenticated.length).toBeGreaterThan(before);
  }, 60_000);

  it("refuses another repository, even one added to the worker's own checkout (S2)", async () => {
    const out = await inWorkerShell(
      `cd ../../proj 2>/dev/null; git remote add sneaky http://${stub.host}/other/repo.git; printf 'protocol=http\\nhost=${stub.host}\\npath=other/repo.git\\n\\n' | git credential fill 2>&1 | grep -v '^$' | head -3; git remote remove sneaky; true`,
    );
    expect(out).toContain("not placed on this worker");
    expect(out).not.toContain(GIT_TOKEN);
    expect(await ask("other/repo.git")).toContain("not placed on this worker");
  }, 60_000);

  it("still answers after a hub restart (S3)", async () => {
    await server.close({ keepTerminalDaemon: true });
    server = await startServer({
      tmpHome: hubHome,
      remoteHost: false,
      port: hubPort,
      env: { BAND_LOCAL_HOST: "off", BAND_SERVE_UI: "false" },
    });
    await workerOnline();
    expect(await ask("proj.git")).toContain(`password=${GIT_TOKEN}`);
    expect(await ask("other/repo.git")).toContain("not placed on this worker");
  }, 120_000);
});
