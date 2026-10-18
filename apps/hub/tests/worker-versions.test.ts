// Integration tests for worker versions (version-updates S1, S3, S5, S6): a real hub, a real
// `band-worker` process and stand-in workers on the link protocol (the same `LinkClient` a worker
// uses) that say what version they run. The hub records it, refuses a worker too far from its own
// version with the reason, accepts one that sends no version, and hands the click on "Update" to
// the worker.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LinkClient, LinkRejectedError, RpcError } from "@band-app/link";
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

const ADMIN = "worker-versions-admin";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");
/** The hub under test is told to report this release (`BAND_HUB_VERSION`); a second hub runs the unreleased default. */
const HUB_VERSION = "0.50.0";

interface HostView {
  id: string;
  status: "online" | "offline" | "lost" | "disposed";
  version: string | null;
  workerVersion: string | null;
  versionState: "current" | "behind" | "ahead" | "unknown" | "refused";
  updateRequired: string | null;
  serviceManager: "launchd" | "systemd" | null;
  updateTarget: string | null;
  canUpdate: boolean;
  manualCommand: string | null;
  update: {
    target: string;
    state: "installing" | "restarting" | "failed";
    error: string | null;
  } | null;
}

let home: string;
let server: ServerHandle;
const scratch: string[] = [];
const clients: LinkClient[] = [];
const children: ChildProcess[] = [];

const q = async <T>(procedure: string, input?: unknown, token = ADMIN): Promise<T> => {
  const res = await trpcQuery(server.url, procedure, input, token);
  if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
  return trpcData<T>(res);
};
const mutate = (procedure: string, input: unknown, token = ADMIN) =>
  trpcMutate(server.url, procedure, input, token);
const listHosts = async () => (await q<{ hosts: HostView[] }>("hosts.list")).hosts;
const host = async (id: string) => (await listHosts()).find((h) => h.id === id);

async function issue(name: string): Promise<{ token: string; hostId: string }> {
  return trpcData(await mutate("tokens.issueWorkerBootstrap", { hostName: name, labels: [] }));
}

async function exchange(token: string, workerId: string): Promise<string> {
  const res = await fetch(`${server.url}/api/workers/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, workerId }),
  });
  return ((await res.json()) as { sessionToken: string }).sessionToken;
}

interface Fake {
  hostId: string;
  sessionToken: string;
  client: LinkClient;
}

/** A stand-in worker that says hello with the given version fields. */
async function fakeWorker(
  hello: { version?: string; buildId?: string; serviceManager?: "launchd" | "systemd" },
  existing?: { hostId: string; sessionToken: string },
): Promise<Fake> {
  const issued = existing ?? (await issue(`fake ${hello.version ?? hello.buildId}`));
  const hostId = "hostId" in issued ? issued.hostId : "";
  const sessionToken =
    existing?.sessionToken ?? (await exchange((issued as { token: string }).token, hostId));
  const client = new LinkClient({
    url: `${server.url.replace("http", "ws")}/api/workers/connect`,
    token: sessionToken,
    reconnect: false,
    hello: {
      workerId: hostId,
      buildId: hello.buildId ?? `band-worker@${hello.version}`,
      ...(hello.version ? { version: hello.version } : {}),
      ...(hello.serviceManager ? { serviceManager: hello.serviceManager } : {}),
      mode: "attached",
      capabilities: [],
      labels: {},
      roots: [],
      agents: [],
    },
  });
  clients.push(client);
  return { hostId, sessionToken, client };
}

async function connect(fake: Fake): Promise<void> {
  await fake.client.connect();
  await waitFor(async () => ((await host(fake.hostId))?.status === "online" ? true : undefined), {
    label: `${fake.hostId} online`,
  });
}

beforeAll(async () => {
  home = createTmpHome("band-worker-versions-");
  scratch.push(home);
  seedSettings(home, { tokenSecret: ADMIN });
  // No loopback worker: the one the remote-loopback CI job adds runs this checkout's version,
  // which a hub told to report 0.50.0 correctly refuses. No release check either: the real
  // latest release on GitHub would make a worker on HUB_VERSION look out of date.
  server = await startServer({
    tmpHome: home,
    env: { BAND_HUB_VERSION: HUB_VERSION, BAND_UPDATE_CHECK: "off" },
    remoteHost: false,
  });
}, 120_000);

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
  for (const c of children) c.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("what a host shows (S1, S6)", () => {
  it("marks a worker one minor behind as behind, and offers the hub's version", async () => {
    const w = await fakeWorker({ version: "0.49.0", serviceManager: "systemd" });
    await connect(w);
    expect(await host(w.hostId)).toMatchObject({
      workerVersion: "0.49.0",
      versionState: "behind",
      serviceManager: "systemd",
      updateTarget: HUB_VERSION,
      canUpdate: true,
    });
  });

  it("accepts a worker one minor ahead", async () => {
    const w = await fakeWorker({ version: "0.51.0" });
    await connect(w);
    expect(await host(w.hostId)).toMatchObject({ versionState: "ahead", updateTarget: null });
  });

  it("accepts a worker that sends no version and shows it as unknown with an update prompt", async () => {
    const w = await fakeWorker({ buildId: "legacy-build" });
    await connect(w);
    expect(await host(w.hostId)).toMatchObject({
      workerVersion: null,
      versionState: "unknown",
      updateTarget: HUB_VERSION,
      manualCommand: `npm i -g @band-app/worker@${HUB_VERSION}`,
      // It has no service manager to restart it, so the manual command stands in for the button.
      canUpdate: false,
    });
  });

  it("reads the version from the build id of a worker from before the version field", async () => {
    const w = await fakeWorker({ buildId: "band-worker@0.49.1" });
    await connect(w);
    expect(await host(w.hostId)).toMatchObject({ workerVersion: "0.49.1", versionState: "behind" });
  });
});

describe("a worker too far from the hub (S5)", () => {
  it("is refused with the reason and shown as needing an update", async () => {
    const w = await fakeWorker({ version: "0.53.0" });
    const err = await w.client.connect().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LinkRejectedError);
    expect((err as LinkRejectedError).code).toBe("version-incompatible");
    expect((err as LinkRejectedError).message).toContain(
      `worker 0.53.0 is too new for hub ${HUB_VERSION}`,
    );
    const view = await host(w.hostId);
    expect(view).toMatchObject({
      status: "offline",
      versionState: "refused",
      workerVersion: "0.53.0",
    });
    expect(view?.updateRequired).toContain("too new");
  });

  it("connects normally once it is within a minor again", async () => {
    const first = await fakeWorker({ version: "0.52.0" });
    await first.client.connect().catch(() => undefined);
    const again = await fakeWorker(
      { version: "0.51.0" },
      { hostId: first.hostId, sessionToken: first.sessionToken },
    );
    await connect(again);
    const view = await host(first.hostId);
    expect(view).toMatchObject({ status: "online", versionState: "ahead", updateRequired: null });
  });

  it("is not recorded for a worker without a valid credential", async () => {
    const victim = await fakeWorker({ version: "0.51.0" });
    await connect(victim);
    const intruder = new LinkClient({
      url: `${server.url.replace("http", "ws")}/api/workers/connect`,
      token: "not-a-token",
      reconnect: false,
      hello: {
        workerId: victim.hostId,
        buildId: "x",
        version: "0.99.0",
        mode: "attached",
        capabilities: [],
        labels: {},
        roots: [],
        agents: [],
      },
    });
    clients.push(intruder);
    await expect(intruder.connect()).rejects.toThrow(/invalid or expired token/);
    expect(await host(victim.hostId)).toMatchObject({ status: "online", updateRequired: null });
  });
});

describe("updating a worker (S3)", () => {
  it("answers at once, shows the install and the restart on the host row, and clears when the worker is back", async () => {
    const w = await fakeWorker({ version: "0.49.0", serviceManager: "systemd" });
    const asked: unknown[] = [];
    let finishInstall: () => void = () => undefined;
    w.client.session.handle("worker.update", (params) => {
      asked.push(params);
      return new Promise((resolve) => {
        finishInstall = () => resolve({ ok: true });
      });
    });
    await connect(w);

    // The install has not finished, and the call is already answered: a proxy in front of the
    // hub would give up on a request held open for an npm install.
    const res = await mutate("hosts.update", { hostId: w.hostId });
    expect(res.status).toBe(200);
    expect(await trpcData(res)).toEqual({ target: HUB_VERSION });
    await waitFor(() => (asked.length === 1 ? true : undefined), { label: "worker.update" });
    expect(asked).toEqual([{ version: HUB_VERSION }]);
    expect((await host(w.hostId))?.update).toMatchObject({
      state: "installing",
      target: HUB_VERSION,
    });
    // A second click while it installs is refused.
    expect((await mutate("hosts.update", { hostId: w.hostId })).status).toBe(409);

    finishInstall();
    await waitFor(
      async () => ((await host(w.hostId))?.update?.state === "restarting" ? true : undefined),
      { label: "the restart" },
    );

    // The worker restarts and dials back on the new version.
    await w.client.close();
    const back = await fakeWorker(
      { version: HUB_VERSION, serviceManager: "systemd" },
      { hostId: w.hostId, sessionToken: w.sessionToken },
    );
    await connect(back);
    await waitFor(async () => ((await host(w.hostId))?.update === null ? true : undefined), {
      label: "the update to clear",
    });
    expect(await host(w.hostId)).toMatchObject({
      workerVersion: HUB_VERSION,
      versionState: "current",
    });
  });

  it("shows the error when the install fails, keeps the worker as it was and allows a retry", async () => {
    const w = await fakeWorker({ version: "0.49.0", serviceManager: "launchd" });
    w.client.session.handle("worker.update", () => {
      throw new RpcError(-32020, "npm install failed (exit 243): EACCES permission denied");
    });
    await connect(w);

    expect((await mutate("hosts.update", { hostId: w.hostId })).status).toBe(200);
    await waitFor(
      async () => ((await host(w.hostId))?.update?.state === "failed" ? true : undefined),
      { label: "the failure" },
    );
    expect(await host(w.hostId)).toMatchObject({
      status: "online",
      workerVersion: "0.49.0",
      update: { state: "failed", error: expect.stringContaining("EACCES permission denied") },
    });

    expect((await mutate("hosts.dismissUpdate", { hostId: w.hostId })).status).toBe(200);
    expect((await host(w.hostId))?.update).toBeNull();
  });

  it("says so when the worker is too old to update itself", async () => {
    const w = await fakeWorker({ version: "0.49.0", serviceManager: "systemd" });
    await connect(w);
    expect((await mutate("hosts.update", { hostId: w.hostId })).status).toBe(200);
    await waitFor(
      async () => ((await host(w.hostId))?.update?.state === "failed" ? true : undefined),
      { label: "the failure" },
    );
    expect((await host(w.hostId))?.update?.error).toContain("too old to update itself");
  });

  it("gives the manual command instead of a button for a worker with no service manager", async () => {
    const w = await fakeWorker({ version: "0.49.0" });
    await connect(w);
    expect(await host(w.hostId)).toMatchObject({
      canUpdate: false,
      manualCommand: `npm i -g @band-app/worker@${HUB_VERSION}`,
    });
    const res = await mutate("hosts.update", { hostId: w.hostId });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(`npm i -g @band-app/worker@${HUB_VERSION}`);
  });

  it("does not update a worker that is already current", async () => {
    const w = await fakeWorker({ version: HUB_VERSION, serviceManager: "systemd" });
    await connect(w);
    expect((await mutate("hosts.update", { hostId: w.hostId })).status).toBe(409);
  });

  it("lets only an admin update or list interruptions", async () => {
    const w = await fakeWorker({ version: "0.49.0", serviceManager: "systemd" });
    const asked: unknown[] = [];
    w.client.session.handle("worker.update", (p) => {
      asked.push(p);
      return { ok: true };
    });
    await connect(w);
    const device = await trpcData<{ token: string }>(
      await mutate("tokens.createDevice", { label: "viewer", admin: false }),
    );
    expect((await mutate("hosts.update", { hostId: w.hostId }, device.token)).status).toBe(403);
    const peek = await trpcQuery(
      server.url,
      "hosts.interruptions",
      { hostId: w.hostId },
      device.token,
    );
    expect(peek.status).toBe(403);
    expect(asked).toEqual([]);
    // Any device token can read the host list and the update status.
    expect(
      (await trpcQuery(server.url, "hosts.updateStatus", undefined, device.token)).status,
    ).toBe(200);
    expect(await q("hosts.interruptions", { hostId: w.hostId })).toEqual({ agents: [] });
  });
});
