// Integration tests for the runner service (plan step 3.4). A real hub (the
// production bundle on a random port, temp BAND_HOME) runs runner hooks from
// settings.json. The bundled `local` and `ssh` hooks start the real
// `band-worker` binary. The failure cases use small fake hooks.
//
// The `ssh` hook runs against a test double, not sshd: a fake `ssh` executable
// on the hook's PATH that ignores the options and the target and runs the
// remote script (read from stdin) with `sh -s` on this machine. sshd is not
// available on every CI runner.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
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
import { waitFor } from "./helpers/wait-for";

const TOKEN = "runners-shared-secret";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");

interface HostRequest {
  id: string;
  workspaceId: string;
  status: "pending" | "leased" | "fulfilled" | "failed" | "cancelled";
  hostId: string | null;
  error: string | null;
}
interface RunnerRun {
  requestId: string;
  runnerId: string;
  status: string;
  attempt: number;
}
interface RunnersList {
  runners: Array<{ id: string; running: number; maxConcurrent: number }>;
  runs: RunnerRun[];
  errors: string[];
}
interface CreateResult {
  path: string;
  provisioning?: { requestId: string };
}
interface ProjectsList {
  projects: Array<{ name: string; worktrees: Array<{ name: string; hostId?: string }> }>;
}

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

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "hello.txt"), "hello\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

function script(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

let server: ServerHandle;
let hubRepo: string;
let work: string;

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

const setRunners = (runners: unknown[]) => m("settings.update", { runners });
const request = async (id: string) =>
  (await q<{ requests: HostRequest[] }>("hostRequests.list")).requests.find((r) => r.id === id);
const runnersList = () => q<RunnersList>("runners.list");
const create = (branch: string, placement: Record<string, unknown>) =>
  m<CreateResult>("workspaces.create", { project: "proj", branch, placement });
const requestIdOf = (c: CreateResult) => c.provisioning?.requestId as string;
const workspace = async (name: string) =>
  (await q<ProjectsList>("projects.list")).projects
    .find((p) => p.name === "proj")
    ?.worktrees.find((w) => w.name === name);
const lines = (file: string) =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];

beforeAll(async () => {
  const hubHome = createTmpHome("band-runners-hub-");
  scratch.push(hubHome);
  work = tmp("band-runners-work-");
  hubRepo = join(tmp("band-runners-repo-"), "proj");
  makeRepo(hubRepo);
  seedSettings(hubHome, { tokenSecret: TOKEN });
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
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: { BAND_SERVE_UI: "false" },
  });
}, 120_000);

afterAll(async () => {
  // Ephemeral workers the local and ssh hooks left running.
  for (const base of [join(server?.home ?? "", ".band", "runners"), join(work, "ssh")]) {
    if (!existsSync(base)) continue;
    for (const dir of readdirSync(base, { recursive: true }).map(String)) {
      if (!dir.endsWith("pid")) continue;
      try {
        process.kill(Number(readFileSync(join(base, dir), "utf8").trim()), "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("settings", () => {
  it("lists configured runners and refuses invalid ones", async () => {
    const bad = await trpcMutate(
      server.url,
      "settings.update",
      {
        runners: [
          { id: "a", spawn: "x" },
          { id: "a", spawn: "y" },
        ],
      },
      TOKEN,
    );
    expect(bad.status).toBe(400);
    const badId = await trpcMutate(
      server.url,
      "settings.update",
      { runners: [{ id: "has space", spawn: "x" }] },
      TOKEN,
    );
    expect(badId.status).toBe(400);
    await setRunners([
      { id: "idle", spawn: "/bin/false", labels: { pool: "none" }, maxConcurrent: 3 },
    ]);
    const list = await runnersList();
    expect(list.runners).toMatchObject([{ id: "idle", maxConcurrent: 3, running: 0 }]);
  });

  it("keeps runners behind an admin token", async () => {
    const created = await m<{ token: string }>("tokens.createDevice", { label: "phone" });
    const runners = [{ id: "evil", spawn: "/bin/true" }];
    const refused = await trpcMutate(server.url, "settings.update", { runners }, created.token);
    expect(refused.status).toBe(403);
    expect((await trpcQuery(server.url, "runners.list", undefined, created.token)).status).toBe(
      403,
    );
    const noToken = await trpcQuery(server.url, "runners.list", undefined, "");
    expect(noToken.status).toBe(401);
    const wrong = await trpcQuery(server.url, "runners.log", { requestId: "hr-x" }, "bdt_wrong");
    expect(wrong.status).toBe(401);
  });
});

describe("the local hook", () => {
  it("spawns a real worker for a request and the workspace becomes ready (S1)", async () => {
    await setRunners([
      {
        id: "local",
        spawn: "bundled:local",
        destroy: "bundled:local",
        labels: { pool: "local" },
        isolation: "process",
        maxConcurrent: 1,
        timeoutSec: 90,
        env: { BAND_WORKER_BIN: WORKER_BIN, BAND_IDLE_EXIT: "120s" },
      },
    ]);
    const created = await create("runner-local", { labels: { pool: "local" } });
    const id = requestIdOf(created);
    expect(id).toBeTruthy();
    expect(created.path).toBe("");

    const wt = await waitFor(() => workspace("runner-local"), {
      label: "workspace exists on the spawned worker",
      timeoutMs: 90_000,
      intervalMs: 250,
    });
    expect(wt.hostId).toMatch(/^h-/);
    expect(await request(id)).toBeUndefined();
    const hosts = await q<{ hosts: Array<{ id: string; status: string; labels: string[] }> }>(
      "hosts.list",
    );
    const host = hosts.hosts.find((h) => h.id === wt.hostId);
    expect(host?.status).toBe("online");
    expect(host?.labels).toContain("pool=local");
    const run = (await runnersList()).runs.find((r) => r.requestId === id);
    expect(run).toMatchObject({ runnerId: "local", status: "ready", attempt: 1 });
    const { log } = await q<{ log: string | null }>("runners.log", { requestId: id });
    expect(log).toContain("started worker");
  }, 120_000);
});

describe("the ssh hook", () => {
  it("starts a worker through ssh (a test double that runs the remote script locally) (S4)", async () => {
    const bin = join(work, "fake-bin");
    mkdirSync(bin, { recursive: true });
    const sshLog = join(work, "fake-ssh.log");
    script(
      join(bin, "ssh"),
      // Options and target are ignored; the remote script arrives on stdin.
      `echo "$*" >> ${JSON.stringify(sshLog)}\nexec sh -s`,
    );
    await setRunners([
      {
        id: "ssh",
        spawn: "bundled:ssh",
        destroy: "bundled:ssh",
        labels: { pool: "ssh" },
        timeoutSec: 90,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          BAND_SSH_TARGET: "runner@build-box",
          BAND_SSH_DIR: join(work, "ssh"),
          BAND_SSH_CLONE_LOCAL: "1",
          BAND_WORKER_CMD: `${JSON.stringify(process.execPath)} ${JSON.stringify(WORKER_BIN)}`,
          BAND_IDLE_EXIT: "120s",
        },
      },
    ]);
    const created = await create("runner-ssh", { labels: { pool: "ssh" } });
    const wt = await waitFor(() => workspace("runner-ssh"), {
      label: "workspace exists on the ssh worker",
      timeoutMs: 90_000,
      intervalMs: 250,
    });
    expect(wt.hostId).toMatch(/^h-/);
    expect(lines(sshLog).join("\n")).toContain("runner@build-box sh -s");
    // The token went over stdin: it is in no ssh argument.
    expect(lines(sshLog).join("\n")).not.toContain("bwb_");
    const { log } = await q<{ log: string | null }>("runners.log", {
      requestId: requestIdOf(created),
    });
    expect(log).toContain("started worker");
  }, 120_000);
});

describe("failing hooks", () => {
  it("retries a hook that exits non-zero once, then fails with its log tail and runs destroy (S2)", async () => {
    const marks = join(work, "fail-marks");
    mkdirSync(marks, { recursive: true });
    await setRunners([
      {
        id: "failing",
        spawn: script(
          join(work, "fail-spawn.sh"),
          `echo spawn >> "$MARKS/spawn"\necho "provisioning step 1 ok"\necho "boom: out of capacity" >&2\nexit 3`,
        ),
        destroy: script(
          join(work, "fail-destroy.sh"),
          `echo "$BAND_WORKER_ID" >> "$MARKS/destroy"`,
        ),
        labels: { pool: "failing" },
        timeoutSec: 20,
        env: { MARKS: marks },
      },
    ]);
    const id = requestIdOf(await create("runner-fail", { labels: { pool: "failing" } }));
    const failed = await waitFor(
      async () => {
        const r = await request(id);
        return r?.status === "failed" ? r : undefined;
      },
      { label: "request fails", timeoutMs: 30_000, intervalMs: 250 },
    );
    expect(failed.error).toContain("spawn exited with code 3");
    expect(failed.error).toContain("boom: out of capacity");
    expect(failed.error).toContain("provisioning step 1 ok");
    expect(lines(join(marks, "spawn"))).toHaveLength(2);
    // Each failed attempt is cleaned up, with the worker id it used.
    const destroyed = lines(join(marks, "destroy"));
    expect(destroyed).toHaveLength(2);
    expect(new Set(destroyed).size).toBe(2);
    // The failed attempts' hosts are gone.
    const hosts = await q<{ hosts: Array<{ id: string }> }>("hosts.list");
    for (const hostId of destroyed) expect(hosts.hosts.map((h) => h.id)).not.toContain(hostId);
    const run = (await runnersList()).runs.find((r) => r.requestId === id);
    expect(run).toMatchObject({ status: "failed", attempt: 2 });
    await m("hostRequests.cancel", { requestId: id });
  }, 60_000);

  it("retries a hook whose worker never says hello, then fails (S2)", async () => {
    const marks = join(work, "silent-marks");
    mkdirSync(marks, { recursive: true });
    await setRunners([
      {
        id: "silent",
        spawn: script(join(work, "silent-spawn.sh"), `echo spawn >> "$MARKS/spawn"\nexit 0`),
        destroy: script(
          join(work, "silent-destroy.sh"),
          `echo "$BAND_WORKER_ID" >> "$MARKS/destroy"`,
        ),
        labels: { pool: "silent" },
        timeoutSec: 2,
        env: { MARKS: marks },
      },
    ]);
    const id = requestIdOf(await create("runner-silent", { labels: { pool: "silent" } }));
    const failed = await waitFor(
      async () => {
        const r = await request(id);
        return r?.status === "failed" ? r : undefined;
      },
      { label: "request fails", timeoutMs: 30_000, intervalMs: 250 },
    );
    expect(failed.error).toContain("did not say hello within 2s");
    expect(lines(join(marks, "spawn"))).toHaveLength(2);
    expect(lines(join(marks, "destroy"))).toHaveLength(2);
    await m("hostRequests.cancel", { requestId: id });
  }, 60_000);

  it("kills a spawn that does not finish within the timeout", async () => {
    await setRunners([
      {
        id: "hung",
        spawn: script(join(work, "hung-spawn.sh"), `echo "waiting for the cloud"\nexec sleep 60`),
        labels: { pool: "hung" },
        timeoutSec: 1,
      },
    ]);
    const id = requestIdOf(await create("runner-hung", { labels: { pool: "hung" } }));
    const failed = await waitFor(
      async () => {
        const r = await request(id);
        return r?.status === "failed" ? r : undefined;
      },
      { label: "request fails", timeoutMs: 30_000, intervalMs: 250 },
    );
    expect(failed.error).toContain("spawn did not finish within 1s");
    expect(failed.error).toContain("waiting for the cloud");
    await m("hostRequests.cancel", { requestId: id });
  }, 60_000);
});

describe("concurrency", () => {
  it("respects maxConcurrent and never gives a request to two runners (S3)", async () => {
    const marks = join(work, "conc-marks");
    mkdirSync(marks, { recursive: true });
    const gate = join(marks, "gate");
    const hook = script(
      join(work, "conc-spawn.sh"),
      `echo "$BAND_RUNNER_ID $BAND_REQUEST_ID" >> "$MARKS/starts"\nwhile [ ! -f "$GATE" ]; do sleep 0.1; done\nexit 1`,
    );
    const base = {
      spawn: hook,
      labels: { pool: "conc" },
      timeoutSec: 60,
      env: { MARKS: marks, GATE: gate },
    };
    await setRunners([
      { id: "one", maxConcurrent: 1, ...base },
      { id: "two", maxConcurrent: 2, ...base },
    ]);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(requestIdOf(await create(`runner-conc-${i}`, { labels: { pool: "conc" } })));
    }
    await waitFor(async () => lines(join(marks, "starts")).length >= 3 || undefined, {
      label: "three hooks started",
      timeoutMs: 15_000,
      intervalMs: 100,
    });
    // Leave time for a fourth to start if the limit were not enforced.
    await new Promise((r) => setTimeout(r, 2500));
    const started = lines(join(marks, "starts")).map((l) => l.split(" "));
    expect(started).toHaveLength(3);
    expect(new Set(started.map(([, req]) => req)).size).toBe(3);
    const list = await runnersList();
    const count = (id: string) => list.runners.find((r) => r.id === id)?.running;
    expect(count("one")).toBe(1);
    expect(count("two")).toBe(2);
    const running = list.runs.filter((r) => r.status === "running");
    expect(new Set(running.map((r) => r.requestId)).size).toBe(running.length);

    writeFileSync(gate, "");
    await waitFor(
      async () => {
        const all = await Promise.all(ids.map(request));
        return all.every((r) => r?.status === "failed") || undefined;
      },
      { label: "all requests fail", timeoutMs: 60_000, intervalMs: 250 },
    );
    // Every request was run by exactly one runner.
    const final = (await runnersList()).runs.filter((r) => ids.includes(r.requestId));
    expect(final).toHaveLength(5);
    expect(new Set(final.map((r) => r.requestId)).size).toBe(5);
    for (const id of ids) await m("hostRequests.cancel", { requestId: id });
  }, 120_000);

  it("leaves a request alone when its requires are beyond what the runner provides", async () => {
    await setRunners([
      {
        id: "small",
        spawn: "/bin/false",
        labels: { pool: "needs" },
        provides: { node: "20.1.0" },
      },
    ]);
    const id = requestIdOf(
      await create("runner-requires", { labels: { pool: "needs" }, requires: { node: ">=24" } }),
    );
    await new Promise((r) => setTimeout(r, 2500));
    expect((await request(id))?.status).toBe("pending");
    expect((await runnersList()).runs.find((r) => r.requestId === id)).toBeUndefined();
    await m("hostRequests.cancel", { requestId: id });
  });
});

describe("the hook contract", () => {
  it("fails a request whose environment is not valid, without starting a machine", async () => {
    const marks = join(work, "badenv-marks");
    mkdirSync(marks, { recursive: true });
    await setRunners([
      {
        id: "badenv",
        spawn: script(join(work, "badenv-spawn.sh"), `echo spawn >> "$MARKS/spawn"`),
        labels: { pool: "badenv" },
        env: { MARKS: marks },
      },
    ]);
    const id = requestIdOf(
      await create("runner-badenv", {
        labels: { pool: "badenv" },
        environment: { isolation: "spaceship", nope: 1 },
      }),
    );
    const failed = await waitFor(
      async () => {
        const r = await request(id);
        return r?.status === "failed" ? r : undefined;
      },
      { label: "request fails", timeoutMs: 20_000, intervalMs: 250 },
    );
    expect(failed.error).toContain("Invalid placement environment");
    expect(failed.error).toContain("isolation");
    expect(failed.error).toContain("nope: unknown key");
    expect(lines(join(marks, "spawn"))).toHaveLength(0);
    await m("hostRequests.cancel", { requestId: id });
  });

  it("passes the contract environment and no hub secrets, and scrubs the token from logs (S5)", async () => {
    const marks = join(work, "env-marks");
    mkdirSync(marks, { recursive: true });
    await setRunners([
      {
        id: "envdump",
        spawn: script(
          join(work, "env-spawn.sh"),
          [
            `env > "$MARKS/env"`,
            `printf '%s' "$BAND_BOOTSTRAP_TOKEN" > "$MARKS/token"`,
            `echo "token is $BAND_BOOTSTRAP_TOKEN"`,
            `echo "token again $BAND_BOOTSTRAP_TOKEN" >&2`,
            `echo "other bwb_abcdefghijklmnop and bdt_abcdefghijklmnop"`,
            `exit 1`,
          ].join("\n"),
        ),
        labels: { pool: "env", zone: "x" },
        isolation: "vm",
        timeoutSec: 20,
        env: { MARKS: marks },
      },
    ]);
    const environment = {
      build: { image: "node:24" },
      start: "pnpm dev",
      isolation: "container",
    };
    const id = requestIdOf(
      await create("runner-env", { labels: { pool: "env", zone: "x" }, environment }),
    );
    const failed = await waitFor(
      async () => {
        const r = await request(id);
        return r?.status === "failed" ? r : undefined;
      },
      { label: "request fails", timeoutMs: 30_000, intervalMs: 250 },
    );

    const env = Object.fromEntries(
      readFileSync(join(marks, "env"), "utf8")
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    expect(env.BAND_HUB_URL).toBe(server.url);
    expect(env.BAND_WORKER_ID).toMatch(/^h-[0-9a-f]{12}$/);
    expect(env.BAND_BOOTSTRAP_TOKEN).toMatch(/^bwb_/);
    expect(env.BAND_REPO_URLS).toBe(hubRepo);
    expect(JSON.parse(env.BAND_ENVIRONMENT)).toEqual(environment);
    // The environment's own isolation wins over the runner's.
    expect(env.BAND_ISOLATION).toBe("container");
    expect(env.BAND_LABELS.split(",").sort()).toEqual(["pool=env", "zone=x"]);
    expect(env.BAND_RUNNER_ID).toBe("envdump");
    expect(env.BAND_REQUEST_ID).toBe(id);
    // The hub's own secrets and home do not reach the hook.
    const dump = readFileSync(join(marks, "env"), "utf8");
    expect(dump).not.toContain(TOKEN);
    expect(env.BAND_HOME).toBeUndefined();
    expect(env.BAND_TOKEN).toBeUndefined();
    expect(env.BAND_ADMIN_TOKEN).toBeUndefined();

    // The token is in no log line and not in the failure reason.
    const token = readFileSync(join(marks, "token"), "utf8");
    expect(token).toMatch(/^bwb_/);
    const { log } = await q<{ log: string }>("runners.log", { requestId: id });
    expect(log).toContain("token is [redacted]");
    expect(log).toContain("token again [redacted]");
    expect(log).not.toContain(token);
    expect(log).not.toMatch(/bwb_[A-Za-z0-9]/);
    expect(log).not.toMatch(/bdt_[A-Za-z0-9]/);
    expect(failed.error).not.toContain(token);
    expect(failed.error).not.toMatch(/bw[bs]_[A-Za-z0-9]/);
    await m("hostRequests.cancel", { requestId: id });
  }, 60_000);
});
