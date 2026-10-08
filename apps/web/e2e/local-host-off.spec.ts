/**
 * With BAND_LOCAL_HOST=off the New Worktree dialog does not offer the hub's
 * own machine. Real hub, real `band-worker` processes, no mocking. The control
 * hub (local on) shows Local next to the worker.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { ProjectsPage } from "./pages/ProjectsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorktreePage } from "./pages/WorktreePage";

test.use({ viewport: { width: 1280, height: 800 } });

const TOKEN = "e2e-local-host-off-token";
const REPO = "local-off-repo";
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

/** A stub `claude` CLI that reports a version and a login, found through BAND_AGENT_BIN_DIRS. */
function stubClaudeDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "band-e2e-claude-")));
  const file = join(dir, "claude");
  writeFileSync(
    file,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "claude 7.7.7"; exit 0; fi\nexit 0\n',
  );
  chmodSync(file, 0o755);
  return dir;
}

async function bootHub(localHost: "on" | "off", workerCount: number): Promise<Hub> {
  const home = createTmpHome();
  seedState(home, {
    repos: [
      {
        name: REPO,
        path: `/tmp/fake/${REPO}`,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: `/tmp/fake/${REPO}` },
          { branch: "feat", path: `/tmp/fake/${REPO}-feat` },
        ],
      },
    ],
  });
  seedSettings(home, { tokenSecret: TOKEN });
  const server = await startServer({ tmpHome: home, env: { BAND_LOCAL_HOST: localHost } });
  const hub: Hub = { server, home, workers: [], workerIds: [], dirs: [] };
  hubs.push(hub);
  const claudeDir = stubClaudeDir();
  hub.dirs.push(claudeDir);
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
        {
          env: {
            ...process.env,
            HOME: dir,
            BAND_HOME: join(dir, ".band"),
            BAND_AGENT_BIN_DIRS: claudeDir,
            ANTHROPIC_API_KEY: "",
          },
          stdio: "ignore",
        },
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

test("the host picker offers Local next to a worker when local worktrees are on", async ({
  page,
}) => {
  const hub = await bootHub("on", 1);
  resetClientState(hub.home);
  const worktreePage = new WorktreePage(page, hub.server.url, TOKEN);
  await worktreePage.goto(`${REPO}-feat`);
  await worktreePage.waitForReady();
  await worktreePage.openNewWorktreeDialog(REPO);
  await expect
    .poll(() => worktreePage.newWorktreeHostOptionValues())
    .toEqual(["local", ...hub.workerIds]);
});

test("the host picker does not offer Local when local worktrees are off", async ({ page }) => {
  const hub = await bootHub("off", 2);
  resetClientState(hub.home);
  const worktreePage = new WorktreePage(page, hub.server.url, TOKEN);
  await worktreePage.goto(`${REPO}-feat`);
  await worktreePage.waitForReady();
  await worktreePage.openNewWorktreeDialog(REPO);
  await expect.poll(() => worktreePage.newWorktreeHostOptionValues()).toEqual(hub.workerIds);
});

test("Settings > Hosts leaves Local out and shows what each worker reports (S5)", async ({
  page,
}) => {
  const hub = await bootHub("off", 1);
  resetClientState(hub.home);
  const settings = new SettingsPage(page, hub.server.url, TOKEN);
  await settings.goto();
  await settings.openDialog("hosts");
  const [worker] = hub.workerIds;
  await settings.expectRowVisible(settings.hostRow(worker));
  await expect(settings.hostRow("local")).toHaveCount(0);
  // The agents are the ones the worker found and checked, not the configured list.
  await expect(settings.hostAgents(worker)).toContainText("claude-code 7.7.7");
  await expect(settings.hostRow(worker).getByTestId("settings__host-os")).toContainText(
    process.platform,
  );
  await expect(settings.hostRow(worker).getByTestId("settings__host-capabilities")).toContainText(
    "Git",
  );
});

test("the project page names the coordinator's host, not its id (S6)", async ({ page }) => {
  const hub = await bootHub("off", 1);
  resetClientState(hub.home);
  const [workerId] = hub.workerIds;
  await trpc(hub.server.url, "projects.create", {
    name: "named-host",
    repos: [{ repo: REPO }],
    coordinatorHostId: workerId,
  });
  const projects = new ProjectsPage(page, hub.server.url, TOKEN);
  await projects.gotoProject("named-host");
  const meta = await projects.coordinatorMeta();
  await expect(meta).toContainText("on Worker 1");
  await expect(meta).not.toContainText(workerId);
});
