// A hub run from source reports the unreleased default version (0.1.0), so there is no release to
// hold workers to: it accepts a worker of any version and logs that it skipped the check. A real
// `band-worker` still shows as current, since it is built from the same source.

import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcQuery,
} from "./helpers/server";
import { connectStandInWorker, type StandInWorker } from "./helpers/stand-in-worker";
import { waitFor } from "./helpers/wait-for";

const ADMIN = "worker-versions-dev-admin";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");

interface HostView {
  id: string;
  status: string;
  workerVersion: string | null;
  versionState: string;
  updateRequired: string | null;
  updateTarget: string | null;
  canUpdate: boolean;
}

let home: string;
let server: ServerHandle;
const scratch: string[] = [];
const standIns: StandInWorker[] = [];
const children: ReturnType<typeof spawn>[] = [];

const host = async (id: string) => {
  const res = await trpcQuery(server.url, "hosts.list", undefined, ADMIN);
  return (await trpcData<{ hosts: HostView[] }>(res)).hosts.find((h) => h.id === id);
};

beforeAll(async () => {
  home = createTmpHome("band-worker-versions-dev-");
  scratch.push(home);
  seedSettings(home, { tokenSecret: ADMIN });
  server = await startServer({ tmpHome: home, remoteHost: false });
}, 120_000);

afterAll(async () => {
  for (const w of standIns) await w.close().catch(() => undefined);
  for (const c of children) c.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("a hub run from source", () => {
  it("accepts a worker far from its version and logs that it skipped the check", async () => {
    const far = await connectStandInWorker({
      hubUrl: server.url,
      adminToken: ADMIN,
      name: "far",
      version: "0.47.0",
    });
    standIns.push(far);
    await waitFor(async () => ((await host(far.hostId))?.status === "online" ? true : undefined), {
      label: "the far worker online",
    });
    expect(await host(far.hostId)).toMatchObject({
      workerVersion: "0.47.0",
      versionState: "ahead",
      updateRequired: null,
      // A hub run from source has no release to move a worker to.
      updateTarget: null,
      canUpdate: false,
    });
    expect(server.output()).toContain("version checks are skipped");
  });

  it("shows a real worker built from the same source as current", async () => {
    const res = await fetch(`${server.url}/trpc/tokens.issueWorkerBootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `band_token=${ADMIN}` },
      body: JSON.stringify({ hostName: "real worker", labels: [] }),
    });
    const issued = (await res.json()) as { result: { data: { token: string; hostId: string } } };
    const { token, hostId } = issued.result.data;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "band-wvd-root-")));
    const state = realpathSync(mkdtempSync(join(tmpdir(), "band-wvd-state-")));
    const workerHome = realpathSync(mkdtempSync(join(tmpdir(), "band-wvd-home-")));
    scratch.push(root, state, workerHome);
    const child = spawn(
      process.execPath,
      [
        WORKER_BIN,
        "--hub",
        server.url,
        "--token",
        token,
        "--worker-id",
        hostId,
        "--root",
        root,
        "--state-dir",
        state,
      ],
      {
        env: { ...process.env, HOME: workerHome, BAND_HOME: join(workerHome, ".band") },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(child);
    let output = "";
    child.stdout?.on("data", (d) => {
      output += d;
    });
    child.stderr?.on("data", (d) => {
      output += d;
    });
    await waitFor(async () => ((await host(hostId))?.status === "online" ? true : undefined), {
      label: "real worker online",
      timeoutMs: 30_000,
    }).catch((err) => {
      throw new Error(`${err.message}\n${output}`);
    });
    expect(await host(hostId)).toMatchObject({ workerVersion: "0.1.0", versionState: "current" });
  }, 60_000);
});
