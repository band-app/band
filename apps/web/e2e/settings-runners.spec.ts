/**
 * Settings › Runners: the configured runner hooks, and the log of a request a
 * runner took (plan step 3.4). The runner is a fake hook that fails, so the run
 * ends quickly with a log to read. Real hub, temp BAND_HOME, no worker.
 * `apps/hub/tests/runners.test.ts` covers the real `local` and `ssh` hooks.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
import { trpcMutate } from "./helpers/trpc";
import { SettingsPage } from "./pages/SettingsPage";

test.use({ viewport: { width: 1280, height: 800 } });

const TOKEN = "e2e-runners-token";
const PROJECT = "runner-project";

let server: ServerHandle;
let tmpHome: string;
let destroyMarker: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const hook = join(tmpHome, "failing-spawn.sh");
  writeFileSync(
    hook,
    '#!/bin/sh\necho "no capacity in the moon pool"\necho "token $BAND_BOOTSTRAP_TOKEN"\nexit 2\n',
  );
  chmodSync(hook, 0o755);
  // A runner whose machine never connects: spawn prints a handle and exits, destroy leaves a note.
  const ghostSpawn = join(tmpHome, "ghost-spawn.sh");
  writeFileSync(ghostSpawn, '#!/bin/sh\necho "BAND_MACHINE_HANDLE=ghost-$BAND_WORKER_ID"\n');
  chmodSync(ghostSpawn, 0o755);
  destroyMarker = join(tmpHome, "ghost-destroyed.log");
  const ghostDestroy = join(tmpHome, "ghost-destroy.sh");
  writeFileSync(ghostDestroy, `#!/bin/sh\necho "$BAND_MACHINE_HANDLE" >> "${destroyMarker}"\n`);
  chmodSync(ghostDestroy, 0o755);
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    runners: [
      {
        id: "moon-runner",
        kind: "hook",
        spawn: hook,
        labels: { zone: "moon" },
        isolation: "process",
        maxConcurrent: 2,
        timeoutSec: 10,
        env: {},
      },
      {
        id: "ghost-runner",
        kind: "hook",
        spawn: ghostSpawn,
        destroy: ghostDestroy,
        labels: { zone: "ghost" },
        isolation: "process",
        maxConcurrent: 1,
        timeoutSec: 600,
        env: {},
      },
    ],
  });
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: `/tmp/fake/${PROJECT}`,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: `/tmp/fake/${PROJECT}` }],
      },
    ],
  });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("lists the runner and shows the log of a run that failed", async ({ page }) => {
  await trpcMutate(server.url, TOKEN, "workspaces.create", {
    project: PROJECT,
    branch: "needs-moon",
    placement: { labels: { zone: "moon" } },
  });

  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("runners");

  const runner = settingsPage.runnerRow("moon-runner");
  await settingsPage.expectRowVisible(runner);
  await expect(runner).toContainText("zone=moon");
  await expect(settingsPage.runnerRunning(runner)).toHaveAttribute("data-max", "2");

  const run = settingsPage.runnerRun(`${PROJECT}-needs-moon`);
  await expect(run).toHaveAttribute("data-status", "failed", { timeout: 30_000 });
  await settingsPage.toggleRunnerLog(`${PROJECT}-needs-moon`);
  const log = settingsPage.runnerLog(`${PROJECT}-needs-moon`);
  await expect(log).toContainText("no capacity in the moon pool");
  // The bootstrap token the hook echoed is not shown.
  await expect(log).toContainText("token [redacted]");
  await expect(log).not.toContainText("bwb_");
});

test("lists a machine the runner started, and an admin destroys it", async ({ page }) => {
  await trpcMutate(server.url, TOKEN, "workspaces.create", {
    project: PROJECT,
    branch: "needs-ghost",
    placement: { labels: { zone: "ghost" } },
  });

  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("runners");

  const machine = settingsPage.runnerMachines("ghost-runner");
  await expect(machine).toHaveCount(1, { timeout: 30_000 });
  await expect(machine).toHaveAttribute("data-state", "spawning");
  await expect(settingsPage.machineAge(machine)).toBeVisible();
  // The list refetches every 5 s, and the handle is recorded a moment after the row first shows.
  await expect(machine).toContainText("ghost-h-", { timeout: 15_000 });

  await settingsPage.destroyMachine(machine);
  await expect(machine).toHaveAttribute("data-state", "destroyed", { timeout: 15_000 });
  await expect(settingsPage.machineNote(machine)).toHaveText("destroyed by an admin");
  expect(existsSync(destroyMarker)).toBe(true);
  expect(readFileSync(destroyMarker, "utf8")).toMatch(/^ghost-h-[0-9a-f]{12}$/m);
  // A destroyed machine has nothing left to destroy.
  await expect(settingsPage.machineDestroyButton(machine)).toHaveCount(0);
});
