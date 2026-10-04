// Integration tests for isolation levels (plan step 3.6). A real hub (the
// production bundle on a random port, temp BAND_HOME) runs the bundled `local`
// hook, which starts a real `band-worker`, as a runner that declares an
// isolation level. The hook is a stand-in for the `docker` hook: the hub only
// reads the runner's declared `isolation`, so what is under test is placement
// and leasing, not containers (those are in runner-docker.test.ts and the CI
// docker job).

import { execFileSync } from "node:child_process";
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
interface ProjectsList {
  projects: Array<{ name: string; worktrees: Array<{ name: string; hostId?: string }> }>;
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
  m<CreateResult>("workspaces.create", { project: "proj", branch, placement });
const createRaw = (branch: string, placement: Record<string, unknown>) =>
  trpcMutate(server.url, "workspaces.create", { project: "proj", branch, placement }, TOKEN);
const workspace = (name: string) =>
  waitFor(
    async () =>
      (await q<ProjectsList>("projects.list")).projects
        .find((p) => p.name === "proj")
        ?.worktrees.find((w) => w.name === name),
    { label: `workspace ${name} exists`, timeoutMs: 90_000, intervalMs: 250 },
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
  it("starts a worker of its own for each workspace and never shares it (S3)", async () => {
    await setRunners([workerRunner("boxes", "container", "iso", 2)]);
    const environment = { isolation: "container" };
    const a = await place("iso-a", { labels: { pool: "iso" }, environment });
    const b = await place("iso-b", { labels: { pool: "iso" }, environment });
    expect(a.provisioning?.requestId).toBeTruthy();
    expect(b.provisioning?.requestId).toBeTruthy();

    const [wa, wb] = await Promise.all([workspace("iso-a"), workspace("iso-b")]);
    expect(wa.hostId).toMatch(/^h-/);
    expect(wb.hostId).toMatch(/^h-/);
    expect(wa.hostId).not.toBe(wb.hostId);
    // The host is marked as exclusive.
    expect(await hostLabels(wa.hostId as string)).toContain("band.isolation=container");

    // Another container workspace with the same labels still gets a new worker,
    // although two online ones match the labels.
    const c = await place("iso-c", { labels: { pool: "iso" }, environment });
    expect(c.provisioning?.requestId).toBeTruthy();
    const wc = await workspace("iso-c");
    expect([wa.hostId, wb.hostId]).not.toContain(wc.hostId);

    // A worktree workspace asking for the same labels does not land on a container worker.
    const d = await place("iso-d", { labels: { pool: "iso" } });
    expect(d.provisioning?.requestId).toBeTruthy();
    const wd = await workspace("iso-d");
    expect([wa.hostId, wb.hostId, wc.hostId]).not.toContain(wd.hostId);
  }, 180_000);
});

describe("worktree isolation", () => {
  it("lets two workspaces share one worker (S3)", async () => {
    await setRunners([workerRunner("shared", "process", "wt", 1)]);
    const first = await place("wt-a", { labels: { pool: "wt" } });
    expect(first.provisioning?.requestId).toBeTruthy();
    const wa = await workspace("wt-a");
    expect(await hostLabels(wa.hostId as string)).not.toContain("band.isolation=container");

    // The worker is online and matches, so the second workspace goes straight to it.
    const second = await place("wt-b", { labels: { pool: "wt" } });
    expect(second.provisioning).toBeUndefined();
    expect(second.path).not.toBe("");
    const wb = await workspace("wt-b");
    expect(wb.hostId).toBe(wa.hostId);
  }, 120_000);
});

describe("levels no runner offers", () => {
  it("refuses a vm workspace with the reason when no runner declares vm (S4)", async () => {
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

  it("refuses a container workspace when only process runners exist (S4)", async () => {
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
