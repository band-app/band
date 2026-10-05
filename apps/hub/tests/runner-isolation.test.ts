// Integration tests for isolation levels (plan step 3.6). A real hub (the
// production bundle on a random port, temp BAND_HOME) runs the bundled `local`
// hook, which starts a real `band-worker`, as a runner that declares an
// isolation level. The hook is a stand-in for the `docker` hook: the hub only
// reads the runner's declared `isolation`, so what is under test is placement
// and leasing, not containers (those are in runner-docker.test.ts and the CI
// docker job).

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

const TOKEN = "isolation-shared-secret";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");

interface HostRequest {
  id: string;
  status: "pending" | "leased" | "fulfilled" | "failed" | "cancelled";
}
interface CreateResult {
  path: string;
  provisioning?: { requestId: string };
}
interface ReposList {
  repos: Array<{ name: string; worktrees: Array<{ name: string; hostId?: string }> }>;
}
interface HostsList {
  hosts: Array<{ id: string; status: string; labels: string[] }>;
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

let server: ServerHandle;
const workers: ChildProcess[] = [];

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

/** A runner that starts real workers with the `local` hook and declares `isolation`. */
const workerRunner = (id: string, isolation: string, pool: string, maxConcurrent = 1) => ({
  id,
  spawn: "bundled:local",
  destroy: "bundled:local",
  labels: { pool },
  isolation,
  maxConcurrent,
  timeoutSec: 90,
  env: { BAND_WORKER_BIN: WORKER_BIN, BAND_IDLE_EXIT: "120s" },
});
const setRunners = (runners: unknown[]) => m("settings.update", { runners });
const place = (branch: string, placement: Record<string, unknown>) =>
  m<CreateResult>("worktrees.create", { repo: "proj", branch, placement });
const createRaw = (branch: string, placement: Record<string, unknown>) =>
  trpcMutate(server.url, "worktrees.create", { repo: "proj", branch, placement }, TOKEN);
const worktree = (name: string) =>
  waitFor(
    async () =>
      (await q<ReposList>("repos.list")).repos
        .find((p) => p.name === "proj")
        ?.worktrees.find((w) => w.name === name),
    { label: `worktree ${name} exists`, timeoutMs: 90_000, intervalMs: 250 },
  );
const hostLabels = async (hostId: string) =>
  (await q<HostsList>("hosts.list")).hosts.find((h) => h.id === hostId)?.labels ?? [];

beforeAll(async () => {
  const hubHome = createTmpHome("band-isolation-hub-");
  scratch.push(hubHome);
  const hubRepo = join(tmp("band-isolation-repo-"), "proj");
  mkdirSync(hubRepo, { recursive: true });
  git(hubRepo, "init", "-q", "-b", "main");
  writeFileSync(join(hubRepo, "hello.txt"), "hello\n");
  git(hubRepo, "add", ".");
  git(hubRepo, "commit", "-q", "-m", "init");
  seedSettings(hubHome, { tokenSecret: TOKEN });
  seedState(hubHome, {
    repos: [
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
  for (const w of workers) w.kill();
  // Ephemeral workers the local hook left running.
  const base = join(server?.home ?? "", ".band", "runners");
  if (existsSync(base)) {
    for (const file of readdirSync(base, { recursive: true }).map(String)) {
      if (!file.endsWith("pid")) continue;
      try {
        process.kill(Number(readFileSync(join(base, file), "utf8").trim()), "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("container isolation", () => {
  it("starts a worker of its own for each worktree and never shares it (S3)", async () => {
    await setRunners([workerRunner("boxes", "container", "iso", 2)]);
    const environment = { isolation: "container" };
    const a = await place("iso-a", { labels: { pool: "iso" }, environment });
    const b = await place("iso-b", { labels: { pool: "iso" }, environment });
    expect(a.provisioning?.requestId).toBeTruthy();
    expect(b.provisioning?.requestId).toBeTruthy();

    const [wa, wb] = await Promise.all([worktree("iso-a"), worktree("iso-b")]);
    expect(wa.hostId).toMatch(/^h-/);
    expect(wb.hostId).toMatch(/^h-/);
    expect(wa.hostId).not.toBe(wb.hostId);
    // The host is marked as exclusive.
    expect(await hostLabels(wa.hostId as string)).toContain("band.isolation=container");

    // Another container worktree with the same labels still gets a new worker,
    // although two online ones match the labels.
    const c = await place("iso-c", { labels: { pool: "iso" }, environment });
    expect(c.provisioning?.requestId).toBeTruthy();
    const wc = await worktree("iso-c");
    expect([wa.hostId, wb.hostId]).not.toContain(wc.hostId);

    // A worktree worktree asking for the same labels does not land on a container worker.
    const d = await place("iso-d", { labels: { pool: "iso" } });
    expect(d.provisioning?.requestId).toBeTruthy();
    const wd = await worktree("iso-d");
    expect([wa.hostId, wb.hostId, wc.hostId]).not.toContain(wd.hostId);
  }, 180_000);
});

describe("worktree isolation", () => {
  // A worker a runner starts is ephemeral and belongs to the worktree it was started for
  // (step 3.5). A worker someone registered by hand is shared.
  it("lets two worktrees share one registered worker (S3)", async () => {
    await setRunners([]);
    const root = tmp("band-isolation-root-");
    const repo = join(root, "proj");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "hello.txt"), "hello\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
      hostName: "Shared box",
    });
    const home = tmp("band-isolation-whome-");
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
        tmp("band-isolation-state-"),
        "--labels",
        "pool=shared",
      ],
      { env: { ...process.env, HOME: home, BAND_HOME: join(home, ".band") }, stdio: "ignore" },
    );
    workers.push(child);
    await waitFor(
      async () =>
        (await q<HostsList>("hosts.list")).hosts.find((h) => h.id === issued.hostId)?.status ===
          "online" || undefined,
      { label: "shared worker online", timeoutMs: 20_000 },
    );

    const placement = { labels: { pool: "shared" } };
    for (const branch of ["wt-a", "wt-b"]) {
      const res = await m<CreateResult>("worktrees.create", {
        repo: "proj",
        branch,
        placement,
        hostRepoPath: repo,
      });
      expect(res.provisioning).toBeUndefined();
      expect(res.path).not.toBe("");
    }
    const [wa, wb] = await Promise.all([worktree("wt-a"), worktree("wt-b")]);
    expect(wa.hostId).toBe(issued.hostId);
    expect(wb.hostId).toBe(issued.hostId);
    expect(await hostLabels(issued.hostId)).not.toContain("band.isolation=container");
  }, 120_000);
});

describe("levels no runner offers", () => {
  it("refuses a vm worktree with the reason when no runner declares vm (S4)", async () => {
    await setRunners([
      workerRunner("c", "container", "none"),
      workerRunner("w", "process", "none"),
    ]);
    const res = await createRaw("vm-none", { environment: { isolation: "vm" } });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("No runner offers isolation vm");
    // Nothing was recorded.
    expect((await q<{ requests: HostRequest[] }>("hostRequests.list")).requests).toEqual([]);
  });

  it("refuses a container worktree when only process runners exist (S4)", async () => {
    await setRunners([workerRunner("w", "process", "none")]);
    const res = await createRaw("container-none", { environment: { isolation: "container" } });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("No runner offers isolation container");
  });

  it("leaves a vm request to a runner that offers vm", async () => {
    // The vm runner offers another label, so the hub's own runner service ignores the request.
    await setRunners([workerRunner("vms", "vm", "elsewhere")]);
    const created = await place("vm-ok", {
      labels: { pool: "vm-pool" },
      environment: { isolation: "vm" },
    });
    const id = created.provisioning?.requestId as string;
    expect(id).toBeTruthy();

    const tooWeak = await m<{ request: HostRequest | null }>("hostRequests.lease", {
      runnerId: "ext-container",
      filter: { labels: { pool: "vm-pool" }, isolation: "container" },
    });
    expect(tooWeak.request).toBeNull();
    const strong = await m<{ request: HostRequest | null }>("hostRequests.lease", {
      runnerId: "ext-vm",
      filter: { labels: { pool: "vm-pool" }, isolation: "vm" },
    });
    expect(strong.request?.id).toBe(id);
    const cancelled = await m<{ request: HostRequest }>("hostRequests.cancel", { requestId: id });
    expect(cancelled.request.status).toBe("cancelled");
  });
});
