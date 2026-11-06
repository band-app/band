// Integration tests for the per-worker automatic update (version-updates, plan step 4.2): a real
// hub told to run 0.50.0 and stand-in workers on the real link protocol. The hub's tick installs
// the hub's version on a worker that has the switch on, is behind, can restart itself and has no
// agent the restart would end. A worker with a live agent waits, and goes ahead once the agent
// is gone or the limit (`BAND_WORKER_UPDATE_MAX_DEFER_H`, short here) passes.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { toWorktreeId } from "@band-app/shared/worktree-id";
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
import { connectStandInWorker, type StandInWorker } from "./helpers/stand-in-worker";
import { removeTmpHome } from "./helpers/tmp-home";
import { waitFor } from "./helpers/wait-for";

const ADMIN = "worker-auto-update-admin";
const HUB_VERSION = "0.50.0";
const REPO = "proj";

interface HostRow {
  id: string;
  autoUpdate: boolean;
  workerVersion: string | null;
  canUpdate: boolean;
  update: { state: string } | null;
}

let home: string;
let server: ServerHandle;
const workers: StandInWorker[] = [];
const installs: string[] = [];

const hostRow = async (id: string, token = ADMIN): Promise<HostRow | undefined> => {
  const res = await trpcQuery(server.url, "hosts.list", undefined, token);
  return (await trpcData<{ hosts: HostRow[] }>(res)).hosts.find((h) => h.id === id);
};
const setAuto = (hostId: string, auto: boolean, token = ADMIN) =>
  trpcMutate(server.url, "workers.setAutoUpdate", { hostId, auto }, token);

/** A stand-in that records `worker.update` and then says hello again on the new version. */
async function worker(
  name: string,
  opts: { version?: string; updateBlocked?: string; agents?: boolean; manager?: boolean } = {},
): Promise<StandInWorker> {
  const w: StandInWorker = await connectStandInWorker(
    {
      hubUrl: server.url,
      adminToken: ADMIN,
      name,
      version: opts.version ?? "0.49.0",
      ...(opts.manager === false ? {} : { serviceManager: "systemd" as const }),
      ...(opts.updateBlocked ? { updateBlocked: opts.updateBlocked } : {}),
      ...(opts.agents ? { agents: { held: false } } : {}),
    },
    () => {
      installs.push(name);
      setTimeout(() => void w.reconnect(HUB_VERSION), 100);
      return { ok: true };
    },
  );
  workers.push(w);
  return w;
}

async function startAgentOn(w: StandInWorker, branch: string): Promise<string> {
  const path = join(home, branch);
  mkdirSync(path, { recursive: true });
  const db = new DatabaseSync(join(home, ".band", "band.db"));
  try {
    db.prepare(
      "INSERT INTO worktrees (repo_name, name, branch, path, host_id) VALUES (?, ?, ?, ?, ?)",
    ).run(REPO, branch, branch, path, w.hostId);
  } finally {
    db.close();
  }
  const worktreeId = toWorktreeId(REPO, branch, w.hostId);
  const chatId = `chat-${branch}`;
  await trpcMutate(server.url, "chats.create", { worktreeId, id: chatId }, ADMIN);
  const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${ADMIN}` },
    body: JSON.stringify({ worktreeId, text: "hello agent" }),
  });
  expect(res.ok).toBe(true);
  await waitFor(
    async () => {
      const res = await trpcQuery(server.url, "workers.interruptions", { hostId: w.hostId }, ADMIN);
      return (await trpcData<{ agents: unknown[] }>(res)).agents.length > 0 ? true : undefined;
    },
    { label: `agent live on ${w.hostId}` },
  );
  return chatId;
}

beforeAll(async () => {
  home = createTmpHome("band-worker-auto-update-");
  const hubRepo = join(home, "hub-repo");
  mkdirSync(hubRepo, { recursive: true });
  seedSettings(home, {
    tokenSecret: ADMIN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  seedState(home, {
    repos: [
      {
        name: REPO,
        path: hubRepo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: hubRepo }],
      },
    ],
  });
  server = await startServer({
    tmpHome: home,
    remoteHost: false,
    env: {
      BAND_HUB_VERSION: HUB_VERSION,
      BAND_UPDATE_CHECK: "off",
      BAND_WORKER_UPDATE_AUTO_POLL_MS: "200",
      // 6 hours is the default; this is about 4 seconds.
      BAND_WORKER_UPDATE_MAX_DEFER_H: "0.0011",
    },
  });
}, 60_000);

afterAll(async () => {
  for (const w of workers) await w.close().catch(() => undefined);
  await server?.close();
  removeTmpHome(home);
});

describe("worker auto-update", () => {
  it("S2: the switch is per worker, persists and shows on the list", async () => {
    const w = await worker("switch-box");
    expect((await hostRow(w.hostId))?.autoUpdate).toBe(false);
    expect((await setAuto(w.hostId, true)).status).toBe(200);
    expect((await hostRow(w.hostId))?.autoUpdate).toBe(true);
    expect((await setAuto(w.hostId, false)).status).toBe(200);
    expect((await hostRow(w.hostId))?.autoUpdate).toBe(false);
  });

  it("S3: an idle worker that is behind updates by itself, one with the switch off does not", async () => {
    const off = await worker("idle-off");
    const on = await worker("idle-on");
    await setAuto(on.hostId, true);
    await waitFor(
      async () => ((await hostRow(on.hostId))?.workerVersion === HUB_VERSION ? true : undefined),
      { label: "idle-on updated" },
    );
    expect(installs).toContain("idle-on");
    expect(installs).not.toContain("idle-off");
    expect((await hostRow(off.hostId))?.workerVersion).toBe("0.49.0");
  });

  it("S3: a worker with a live agent waits, then goes ahead once the agent is gone", async () => {
    const busy = await worker("busy-box", { agents: true });
    const chatId = await startAgentOn(busy, "busy");
    await setAuto(busy.hostId, true);
    // Well inside the limit (about 4 s): nothing is installed while the agent lives.
    await new Promise((r) => setTimeout(r, 1500));
    expect(installs).not.toContain("busy-box");
    await trpcMutate(server.url, "chats.stop", { chatId }, ADMIN);
    await waitFor(
      async () => ((await hostRow(busy.hostId))?.workerVersion === HUB_VERSION ? true : undefined),
      { label: "busy-box updated after the agent stopped" },
    );
    expect(installs).toContain("busy-box");
  });

  it("S3: a worker whose agent never ends is updated after the limit", async () => {
    const stuck = await worker("stuck-box", { agents: true });
    await startAgentOn(stuck, "stuck");
    await setAuto(stuck.hostId, true);
    await new Promise((r) => setTimeout(r, 1000));
    expect(installs).not.toContain("stuck-box");
    await waitFor(
      async () => ((await hostRow(stuck.hostId))?.workerVersion === HUB_VERSION ? true : undefined),
      { label: "stuck-box updated after the limit", timeoutMs: 20_000 },
    );
  });

  it("S4: a worker ahead of the hub, one that cannot update itself and one without a service manager are left alone", async () => {
    const ahead = await worker("ahead-box", { version: "0.51.0" });
    const blocked = await worker("blocked-box", { updateBlocked: "not an npm global install" });
    const bare = await worker("bare-box", { manager: false });
    for (const w of [ahead, blocked, bare]) await setAuto(w.hostId, true);
    await new Promise((r) => setTimeout(r, 1500));
    expect(installs).not.toContain("ahead-box");
    expect(installs).not.toContain("blocked-box");
    expect(installs).not.toContain("bare-box");
    expect((await hostRow(blocked.hostId))?.canUpdate).toBe(false);
  });

  it("S4: a failed automatic update is not retried until it is dismissed", async () => {
    const before = installs.length;
    const failing = await connectStandInWorker(
      {
        hubUrl: server.url,
        adminToken: ADMIN,
        name: "failing-box",
        version: "0.49.0",
        serviceManager: "systemd",
      },
      () => {
        installs.push("failing-box");
        throw new Error("npm exploded");
      },
    );
    workers.push(failing);
    await setAuto(failing.hostId, true);
    await waitFor(
      async () => ((await hostRow(failing.hostId))?.update?.state === "failed" ? true : undefined),
      { label: "failing-box failed" },
    );
    await new Promise((r) => setTimeout(r, 1000));
    expect(installs.slice(before).filter((n) => n === "failing-box")).toHaveLength(1);
  });

  it("S5: only an admin can change the switch or read the setting", async () => {
    const w = await worker("guard-box");
    const person = await trpcData<{ token: string }>(
      await trpcMutate(server.url, "tokens.createDevice", { label: "person" }, ADMIN),
    );
    const refused = await setAuto(w.hostId, true, person.token);
    expect(refused.status).toBe(403);
    expect((await hostRow(w.hostId))?.autoUpdate).toBe(false);
    // The setting is a plain read for a non-admin token, and the settings document hides it.
    expect((await hostRow(w.hostId, person.token))?.autoUpdate).toBe(false);
    await setAuto(w.hostId, true);
    const settings = await trpcData<Record<string, unknown>>(
      await trpcQuery(server.url, "settings.get", undefined, person.token),
    );
    expect(settings.workerUpdate).toBeUndefined();
    const write = await trpcMutate(
      server.url,
      "settings.update",
      { workerUpdate: { autoHostIds: [] } },
      person.token,
    );
    expect(write.status).toBe(403);
  });
});
