// Integration tests for placement and host requests (plan step 3.3): a real
// `band-worker` process dials a real hub (the production bundle on a random
// port, temp BAND_HOME). `workspaces.create` with `placement` goes to a worker
// whose labels fit, or records a host request that a test "runner" leases over
// tRPC and fulfils by starting a second real worker.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

const TOKEN = "placement-shared-secret";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");

interface HostRequest {
  id: string;
  workspaceId: string;
  status: "pending" | "leased" | "fulfilled" | "failed" | "cancelled";
  leasedBy: string | null;
  hostId: string | null;
  error: string | null;
  labels: Record<string, string>;
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

/** Issues a host, starts a real worker for it with `labels`, and waits until it is online. */
async function startWorker(name: string, labels: string, waitOnline = true, sharedRoot?: string) {
  // Workers given the same root share one checkout, so the test need not know which one is picked.
  const root = sharedRoot ?? tmp("band-place-root-");
  if (!sharedRoot) makeRepo(join(root, "proj"));
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: name,
  });
  const home = tmp("band-place-whome-");
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
      tmp("band-place-state-"),
      "--labels",
      labels,
    ],
    {
      env: { ...process.env, HOME: home, BAND_HOME: join(home, ".band") },
      stdio: "ignore",
    },
  );
  workers.push(child);
  const online = async () => {
    const { hosts } = await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list");
    return hosts.find((h) => h.id === issued.hostId)?.status === "online" ? true : undefined;
  };
  if (waitOnline) await waitFor(online, { label: `${name} online`, timeoutMs: 20_000 });
  return { hostId: issued.hostId, root, projectPath: join(root, "proj") };
}

const requests = async () => (await q<{ requests: HostRequest[] }>("hostRequests.list")).requests;
const request = async (id: string) => (await requests()).find((r) => r.id === id);
const workspaceHost = async (name: string) =>
  (await q<ProjectsList>("projects.list")).projects
    .find((p) => p.name === "proj")
    ?.worktrees.find((w) => w.name === name);

beforeAll(async () => {
  const hubHome = createTmpHome("band-place-hub-");
  scratch.push(hubHome);
  const hubRepo = join(tmp("band-place-hubrepo-"), "proj");
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
  server = await startServer({ tmpHome: hubHome });
}, 120_000);

afterAll(async () => {
  for (const w of workers) w.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("placement onto an online host", () => {
  it("assigns a worker whose labels match at once (S1)", async () => {
    const home = await startWorker("Home box", "zone=home");
    const created = await m<CreateResult>("workspaces.create", {
      project: "proj",
      branch: "placed-home",
      placement: { labels: { zone: "home" } },
      hostProjectPath: home.projectPath,
    });
    expect(created.provisioning).toBeUndefined();
    expect(created.path).toBe(join(home.root, ".band-worktrees", "proj", "placed-home"));
    expect((await workspaceHost("placed-home"))?.hostId).toBe(home.hostId);
    expect(await requests()).toEqual([]);
  });

  it("prefers the least loaded of several matching workers", async () => {
    const a = await startWorker("Pool A", "pool=gpu");
    const b = await startWorker("Pool B", "pool=gpu", true, a.root);
    const first = await m<CreateResult>("workspaces.create", {
      project: "proj",
      branch: "pool-1",
      placement: { labels: { pool: "gpu" } },
      hostProjectPath: a.projectPath,
    });
    const firstHost = (await workspaceHost("pool-1"))?.hostId;
    expect([a.hostId, b.hostId]).toContain(firstHost);
    expect(first.path).not.toBe("");
    // The next workspace goes to the other worker.
    const other = firstHost === a.hostId ? b : a;
    await m<CreateResult>("workspaces.create", {
      project: "proj",
      branch: "pool-2",
      placement: { labels: { pool: "gpu" } },
      hostProjectPath: a.projectPath,
    });
    expect((await workspaceHost("pool-2"))?.hostId).toBe(other.hostId);
  });

  it("honours requires against the worker's facts", async () => {
    const created = await m<CreateResult>("workspaces.create", {
      project: "proj",
      branch: "needs-future-node",
      placement: { labels: { zone: "home" }, requires: { node: ">=999" } },
    });
    expect(created.provisioning?.requestId).toBeTruthy();
    await m("hostRequests.cancel", { requestId: created.provisioning?.requestId });
  });
});

describe("a host request", () => {
  it("shows provisioning, then completes when a runner fulfils it with a connecting worker (S2)", async () => {
    const created = await m<CreateResult>("workspaces.create", {
      project: "proj",
      branch: "needs-cloud",
      placement: { labels: { zone: "cloud" } },
    });
    const requestId = created.provisioning?.requestId as string;
    expect(requestId).toBeTruthy();
    expect(created.path).toBe("");
    expect((await request(requestId))?.status).toBe("pending");
    expect(await workspaceHost("needs-cloud")).toBeUndefined();

    // A runner that offers zone=cloud takes the lease and starts a machine.
    const leased = await m<{ request: HostRequest | null }>("hostRequests.lease", {
      runnerId: "test-runner",
      filter: { labels: { zone: "cloud" } },
    });
    expect(leased.request?.id).toBe(requestId);
    expect((await request(requestId))?.status).toBe("leased");

    const cloud = await startWorker("Cloud box", "zone=cloud");
    await m("hostRequests.fulfil", {
      requestId,
      runnerId: "test-runner",
      hostId: cloud.hostId,
      hostProjectPath: cloud.projectPath,
    });
    const wt = await waitFor(() => workspaceHost("needs-cloud"), {
      label: "workspace exists",
      timeoutMs: 20_000,
    });
    expect(wt.hostId).toBe(cloud.hostId);
    // The request is done, so the UI no longer lists it.
    expect(await request(requestId)).toBeUndefined();
  });

  it("waits for a fulfilled host that is not online yet", async () => {
    const created = await m<CreateResult>("workspaces.create", {
      project: "proj",
      branch: "needs-late",
      placement: { labels: { zone: "late" } },
    });
    const requestId = created.provisioning?.requestId as string;
    await m("hostRequests.lease", { runnerId: "runner-2" });
    const late = await startWorker("Late box", "zone=late", false);
    await m("hostRequests.fulfil", {
      requestId,
      runnerId: "runner-2",
      hostId: late.hostId,
      hostProjectPath: late.projectPath,
    });
    const wt = await waitFor(() => workspaceHost("needs-late"), {
      label: "workspace exists",
      timeoutMs: 20_000,
    });
    expect(wt.hostId).toBe(late.hostId);
  });

  it("never gives one request to two concurrent leases (S3)", async () => {
    const ids: string[] = [];
    for (const branch of ["lease-a", "lease-b"]) {
      const c = await m<CreateResult>("workspaces.create", {
        project: "proj",
        branch,
        placement: { labels: { zone: "nowhere" } },
      });
      ids.push(c.provisioning?.requestId as string);
    }
    const leases = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        m<{ request: HostRequest | null }>("hostRequests.lease", {
          runnerId: `runner-${i}`,
          filter: { labels: { zone: "nowhere" } },
        }),
      ),
    );
    const got = leases.map((l) => l.request?.id).filter(Boolean) as string[];
    expect(got.sort()).toEqual([...ids].sort());
    expect(new Set(got).size).toBe(2);
    for (const id of ids) await m("hostRequests.cancel", { requestId: id });
  });

  it("makes an expired lease leasable again and refuses the old holder (S3)", async () => {
    const c = await m<CreateResult>("workspaces.create", {
      project: "proj",
      branch: "lease-expiry",
      placement: { labels: { zone: "elsewhere" } },
    });
    const id = c.provisioning?.requestId as string;
    const first = await m<{ request: HostRequest | null }>("hostRequests.lease", {
      runnerId: "slow",
      filter: { labels: { zone: "elsewhere" } },
      ttlMs: 200,
    });
    expect(first.request?.id).toBe(id);
    // While the lease is live nobody else gets it.
    const during = await m<{ request: HostRequest | null }>("hostRequests.lease", {
      runnerId: "other",
      filter: { labels: { zone: "elsewhere" } },
    });
    expect(during.request).toBeNull();
    const second = await waitFor(
      async () =>
        (
          await m<{ request: HostRequest | null }>("hostRequests.lease", {
            runnerId: "other",
            filter: { labels: { zone: "elsewhere" } },
          })
        ).request,
      { label: "lease expires", timeoutMs: 10_000 },
    );
    expect(second.id).toBe(id);
    expect(second.leasedBy).toBe("other");
    const stale = await trpcMutate(
      server.url,
      "hostRequests.fulfil",
      { requestId: id, runnerId: "slow", hostId: "local" },
      TOKEN,
    );
    expect(stale.status).toBe(409);
    // A live lease can be renewed by its holder only.
    await m("hostRequests.renew", { requestId: id, runnerId: "other", ttlMs: 60_000 });
    const wrong = await trpcMutate(
      server.url,
      "hostRequests.renew",
      { requestId: id, runnerId: "slow" },
      TOKEN,
    );
    expect(wrong.status).toBe(409);
    await m("hostRequests.cancel", { requestId: id });
  });

  it("cancels a request (S4)", async () => {
    const c = await m<CreateResult>("workspaces.create", {
      project: "proj",
      branch: "to-cancel",
      placement: { labels: { zone: "never" } },
    });
    const id = c.provisioning?.requestId as string;
    await m("hostRequests.cancel", { requestId: id });
    expect(await request(id)).toBeUndefined();
    // Nothing is left for a runner to take.
    const leased = await m<{ request: HostRequest | null }>("hostRequests.lease", {
      runnerId: "late",
      filter: { labels: { zone: "never" } },
    });
    expect(leased.request).toBeNull();
    expect(await workspaceHost("to-cancel")).toBeUndefined();
  });

  it("returns the open request when the same workspace is asked for twice", async () => {
    const input = {
      project: "proj",
      branch: "twice",
      placement: { labels: { zone: "nope" } },
    };
    const a = await m<CreateResult>("workspaces.create", input);
    const b = await m<CreateResult>("workspaces.create", input);
    expect(b.provisioning?.requestId).toBe(a.provisioning?.requestId);
    await m("hostRequests.cancel", { requestId: a.provisioning?.requestId });
  });

  it("refuses the lease API without an admin token", async () => {
    const badList = await trpcQuery(server.url, "hostRequests.list", undefined, "not-a-token");
    expect(badList.status).toBe(401);
    const bad = await trpcMutate(
      server.url,
      "hostRequests.lease",
      { runnerId: "r" },
      "not-a-token",
    );
    expect(bad.status).toBe(401);
  });

  it("refuses hostId together with placement", async () => {
    const both = await trpcMutate(
      server.url,
      "workspaces.create",
      { project: "proj", branch: "both", hostId: "local", placement: {} },
      TOKEN,
    );
    expect(both.status).toBe(500);
  });
});
