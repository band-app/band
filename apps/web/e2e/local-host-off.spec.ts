/**
 * With BAND_LOCAL_HOST=off the New Workspace dialog does not offer the hub's
 * own machine. Real hub, real `band-worker` processes, no mocking. The control
 * hub (local on) shows Local next to the worker.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorkspacePage } from "./pages/WorkspacePage";

test.use({ viewport: { width: 1280, height: 800 } });

const TOKEN = "e2e-local-host-off-token";
const PROJECT = "local-off-project";
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");

interface Hub {
  server: ServerHandle;
  home: string;
  workers: ChildProcess[];
  workerIds: string[];
  dirs: string[];
}

const hubs: Hub[] = [];

async function trpc<T>(url: string, procedure: string, body?: unknown): Promise<T> {
  const res = await fetch(
    `${url}/trpc/${procedure}`,
    body === undefined
      ? { headers: { Authorization: `Bearer ${TOKEN}` } }
      : {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  if (!res.ok) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
  return ((await res.json()) as { result: { data: T } }).result.data;
}

async function bootHub(localHost: "on" | "off", workerCount: number): Promise<Hub> {
  const home = createTmpHome();
  seedState(home, {
    projects: [
      {
        name: PROJECT,
        path: `/tmp/fake/${PROJECT}`,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: `/tmp/fake/${PROJECT}` },
          { branch: "feat", path: `/tmp/fake/${PROJECT}-feat` },
        ],
      },
    ],
  });
  seedSettings(home, { tokenSecret: TOKEN });
  const server = await startServer({ tmpHome: home, env: { BAND_LOCAL_HOST: localHost } });
  const hub: Hub = { server, home, workers: [], workerIds: [], dirs: [] };
  hubs.push(hub);
  for (let i = 0; i < workerCount; i++) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "band-e2e-worker-")));
    hub.dirs.push(dir);
    const issued = await trpc<{ token: string; hostId: string }>(
      server.url,
      "tokens.issueWorkerBootstrap",
      { hostName: `Worker ${i + 1}` },
    );
    hub.workerIds.push(issued.hostId);
    hub.workers.push(
      spawn(
        process.execPath,
        [
          WORKER_BIN,
          "--hub",
          server.url,
          "--token",
          issued.token,
          "--root",
          join(dir, "root"),
          "--state-dir",
          join(dir, "state"),
        ],
        { env: { ...process.env, HOME: dir, BAND_HOME: join(dir, ".band") }, stdio: "ignore" },
      ),
    );
  }
  await expect
    .poll(
      async () => {
        const { hosts } = await trpc<{ hosts: Array<{ id: string; status: string }> }>(
          server.url,
          "hosts.list",
        );
        return hosts.filter((h) => h.id !== "local" && h.status === "online").length;
      },
      { timeout: 30_000 },
    )
    .toBe(workerCount);
  return hub;
}

test.afterAll(async () => {
  for (const hub of hubs) {
    for (const w of hub.workers) w.kill("SIGKILL");
    await hub.server.close();
    cleanupTmpHome(hub.home);
    for (const d of hub.dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10 });
  }
});

test("the host picker offers Local next to a worker when local workspaces are on", async ({
  page,
}) => {
  const hub = await bootHub("on", 1);
  resetClientState(hub.home);
  const workspacePage = new WorkspacePage(page, hub.server.url, TOKEN);
  await workspacePage.goto(`${PROJECT}-feat`);
  await workspacePage.waitForReady();
  await workspacePage.openNewWorkspaceDialog(PROJECT);
  await expect
    .poll(() => workspacePage.newWorkspaceHostOptionValues())
    .toEqual(["local", ...hub.workerIds]);
});

test("the host picker does not offer Local when local workspaces are off", async ({ page }) => {
  const hub = await bootHub("off", 2);
  resetClientState(hub.home);
  const workspacePage = new WorkspacePage(page, hub.server.url, TOKEN);
  await workspacePage.goto(`${PROJECT}-feat`);
  await workspacePage.waitForReady();
  await workspacePage.openNewWorkspaceDialog(PROJECT);
  await expect.poll(() => workspacePage.newWorkspaceHostOptionValues()).toEqual(hub.workerIds);
});
