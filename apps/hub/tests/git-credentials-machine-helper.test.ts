// Integration test for the machine's git credential helpers on a worker. A real hub (production
// bundle, temp BAND_HOME, BAND_LOCAL_HOST=off) and real `band-worker` processes, each with its own
// temp HOME. The remote is a local git HTTP server that needs basic auth. A static worker keeps
// the helpers in its HOME's .gitconfig and asks the hub after them. An ephemeral worker, or one
// started with --hub-git-credentials-only, asks only the hub. The machine helper is a script that
// writes a marker file when git calls it. The hub also reads the origin of a worker folder that
// had no remote when the repo was added.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { TerminalSocket } from "./helpers/terminal-socket";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "git-credentials-machine-secret";
const GIT_TOKEN = "gitpat_m4ch1ne_0123456789abcdef";
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

/**
 * The environment without the `BAND_*` and `GIT_CONFIG_*` variables of a session that runs inside
 * a Band worker, whose credential helper entries would otherwise reset the helpers under test.
 * `GIT_CONFIG_NOSYSTEM` keeps the system gitconfig's keychain helper out, so a test token never
 * reaches the developer's keychain.
 */
const cleanEnv = () => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !k.startsWith("BAND_") && !k.startsWith("GIT_CONFIG_"),
    ),
  ),
  GIT_CONFIG_NOSYSTEM: "1",
});

interface TestWorker {
  hostId: string;
  proc: ChildProcess;
  home: string;
  root: string;
  state: string;
  marker: string;
  args: string[];
}

let server: ServerHandle;
let stub: GitHttpAuthStub;
let base: string;
let remotes: string;
const workers: TestWorker[] = [];

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

async function inShell(worktreeId: string, line: string): Promise<string> {
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

const hostOnline = (hostId: string) =>
  waitFor(
    async () =>
      (await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list")).hosts.find(
        (h) => h.id === hostId,
      )?.status === "online"
        ? true
        : undefined,
    { label: `worker ${hostId} online`, timeoutMs: 30_000 },
  );

function startWorkerProcess(w: Omit<TestWorker, "proc">, token?: string): ChildProcess {
  return spawn(
    process.execPath,
    [
      WORKER_BIN,
      "--hub",
      server.url,
      ...(token ? ["--token", token] : []),
      "--root",
      w.root,
      "--state-dir",
      w.state,
      ...w.args,
    ],
    {
      env: { ...cleanEnv(), ...identity, HOME: w.home, BAND_HOME: join(w.home, ".band") },
      stdio: "ignore",
    },
  );
}

/** Starts a worker with its own HOME. `machineHelper` puts a credential helper in its .gitconfig. */
async function addWorker(opts: { args?: string[]; machineHelper: boolean }): Promise<TestWorker> {
  const home = tmp("band-gitcred-mh-home-");
  const root = tmp("band-gitcred-mh-root-");
  const state = tmp("band-gitcred-mh-state-");
  const marker = join(home, "machine-helper-called");
  if (opts.machineHelper) {
    const script = join(home, "machine-helper.sh");
    writeFileSync(
      script,
      `#!/bin/sh\ncat >/dev/null\nif [ "$1" = get ]; then\n  touch '${marker}'\n  printf 'username=${GIT_USER}\\npassword=${GIT_TOKEN}\\n'\nfi\n`,
    );
    chmodSync(script, 0o755);
    writeFileSync(join(home, ".gitconfig"), `[credential]\n\thelper = ${script}\n`);
  }
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: "W",
  });
  const rest = { hostId: issued.hostId, home, root, state, marker, args: opts.args ?? [] };
  const worker = { ...rest, proc: startWorkerProcess(rest, issued.token) };
  workers.push(worker);
  await hostOnline(worker.hostId);
  return worker;
}

/** A bare repo on the stub and a checkout of it under the worker's root, origin pointing at the stub. */
function makeCheckout(worker: TestWorker, name: string, origin = true): string {
  git(base, "clone", "-q", "--bare", join(base, "seed"), join(remotes, `${name}.git`));
  const checkout = join(worker.root, name);
  git(base, "clone", "-q", join(remotes, `${name}.git`), checkout);
  if (origin) git(checkout, "remote", "set-url", "origin", `${stub.url}/${name}.git`);
  else git(checkout, "remote", "remove", "origin");
  return checkout;
}

/** Registers a checkout from the worker and returns the id of its default branch worktree. */
async function addRepo(worker: TestWorker, checkout: string, name: string): Promise<string> {
  await m("repos.addFromWorker", { hostId: worker.hostId, path: checkout, name });
  return toWorktreeId(name, "main", worker.hostId);
}

beforeAll(async () => {
  const hubHome = createTmpHome("band-gitcred-mh-hub-");
  scratch.push(hubHome);
  base = tmp("band-gitcred-mh-");
  remotes = join(base, "remotes");
  mkdirSync(remotes, { recursive: true });
  const seed = join(base, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "hello.txt"), "private hello\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  stub = await startGitHttpAuthStub(remotes, { username: GIT_USER, password: GIT_TOKEN });

  seedSettings(hubHome, { tokenSecret: TOKEN });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: { BAND_LOCAL_HOST: "off", BAND_SERVE_UI: "false" },
  });
}, 120_000);

afterAll(async () => {
  for (const w of workers) w.proc.kill("SIGKILL");
  await server?.close();
  await stub?.stop();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("the machine's git credential helpers on a worker", () => {
  it("a static worker uses the machine helper when the hub has no credential (S1)", async () => {
    const w = await addWorker({ machineHelper: true });
    const id = await addRepo(w, makeCheckout(w, "plain-a"), "plain-a");
    const before = stub.authenticated.length;
    const out = await inShell(id, "git ls-remote origin >/dev/null && echo LS-OK");
    expect(out).toContain("LS-OK");
    expect(existsSync(w.marker)).toBe(true);
    expect(stub.authenticated.length).toBeGreaterThan(before);
  }, 120_000);

  it("an ephemeral worker never calls the machine helper (S2)", async () => {
    const w = await addWorker({ args: ["--ephemeral"], machineHelper: true });
    const id = await addRepo(w, makeCheckout(w, "plain-b"), "plain-b");
    await m("vault.put", {
      name: "stub-git-b",
      kind: "git",
      host: stub.host,
      pathPattern: "plain-b",
      username: GIT_USER,
      value: GIT_TOKEN,
    });
    const before = stub.authenticated.length;
    expect(await inShell(id, "git ls-remote origin >/dev/null && echo LS-OK")).toContain("LS-OK");
    expect(stub.authenticated.length).toBeGreaterThan(before);
    expect(existsSync(w.marker)).toBe(false);
  }, 120_000);

  it("a static worker with --hub-git-credentials-only never calls the machine helper (S4)", async () => {
    const w = await addWorker({ args: ["--hub-git-credentials-only"], machineHelper: true });
    const id = await addRepo(w, makeCheckout(w, "plain-c"), "plain-c");
    await m("vault.put", {
      name: "stub-git-c",
      kind: "git",
      host: stub.host,
      pathPattern: "plain-c",
      username: GIT_USER,
      value: GIT_TOKEN,
    });
    const before = stub.authenticated.length;
    expect(await inShell(id, "git ls-remote origin >/dev/null && echo LS-OK")).toContain("LS-OK");
    expect(stub.authenticated.length).toBeGreaterThan(before);
    expect(existsSync(w.marker)).toBe(false);
  }, 120_000);

  it("a static worker with no machine credential gets the vault credential from the hub (S3)", async () => {
    const w = await addWorker({ machineHelper: false });
    const id = await addRepo(w, makeCheckout(w, "plain-d"), "plain-d");
    await m("vault.put", {
      name: "stub-git-d",
      kind: "git",
      host: stub.host,
      pathPattern: "plain-d",
      username: GIT_USER,
      value: GIT_TOKEN,
    });
    const before = stub.authenticated.length;
    expect(await inShell(id, "git ls-remote origin >/dev/null && echo LS-OK")).toContain("LS-OK");
    expect(stub.authenticated.length).toBeGreaterThan(before);
  }, 120_000);
});

describe("the remote of a repo added from a worker folder", () => {
  const remoteOf = async (name: string) =>
    (
      await q<{ repos: Array<{ name: string; remoteUrl?: string | null }> }>("repos.list")
    ).repos.find((r) => r.name === name)?.remoteUrl;

  async function restart(w: TestWorker) {
    w.proc.kill("SIGKILL");
    await waitFor(
      async () =>
        (await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list")).hosts.find(
          (h) => h.id === w.hostId,
        )?.status !== "online"
          ? true
          : undefined,
      { label: "worker offline", timeoutMs: 30_000 },
    );
    w.proc = startWorkerProcess(w);
    await hostOnline(w.hostId);
  }

  it("is read from the folder once it has one, and the hub then hands out the credential (S5)", async () => {
    const w = await addWorker({ machineHelper: false });
    const checkout = makeCheckout(w, "late-e", false);
    const id = await addRepo(w, checkout, "late-e");
    expect(await remoteOf("late-e")).toBeFalsy();
    await m("vault.put", {
      name: "stub-git-e",
      kind: "git",
      host: stub.host,
      pathPattern: "late-e",
      username: GIT_USER,
      value: GIT_TOKEN,
    });

    git(checkout, "remote", "add", "origin", `${stub.url}/late-e.git`);
    await restart(w);

    await waitFor(async () => ((await remoteOf("late-e")) ? true : undefined), {
      label: "remote URL stored",
      timeoutMs: 30_000,
    });
    expect(await remoteOf("late-e")).toBe(`${stub.url}/late-e.git`);
    const before = stub.authenticated.length;
    expect(await inShell(id, "git ls-remote origin >/dev/null && echo LS-OK")).toContain("LS-OK");
    expect(stub.authenticated.length).toBeGreaterThan(before);
  }, 180_000);

  it("is left alone when the folder's origin differs (S6)", async () => {
    const w = await addWorker({ machineHelper: false });
    const checkout = makeCheckout(w, "kept-f");
    await addRepo(w, checkout, "kept-f");
    expect(await remoteOf("kept-f")).toBe(`${stub.url}/kept-f.git`);

    git(checkout, "remote", "set-url", "origin", `${stub.url}/elsewhere.git`);
    await restart(w);
    // The backfill runs on connect, so give it a moment to have run before reading.
    await new Promise((r) => setTimeout(r, 2_000));
    expect(await remoteOf("kept-f")).toBe(`${stub.url}/kept-f.git`);
  }, 180_000);
});
