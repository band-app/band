/**
 * Settings > Repos: the "Checkpoints on the hub" switch. A repo available on every host follows the
 * default (on) and a repo limited to chosen workers follows the other default (off). Flipping the
 * switch stores a choice the hub reports back, and the note stops calling it a default.
 *
 * Real production hub with a temp BAND_HOME. The repos are seeded rows; no worker is needed.
 */

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
import { trpcMutate, trpcQuery } from "./helpers/trpc";
import { CheckpointsPage } from "./pages/CheckpointsPage";
import { SettingsPage } from "./pages/SettingsPage";

const TOKEN = "e2e-repo-checkpoints-token";

let server: ServerHandle;
let tmpHome: string;

interface RepoRow {
  name: string;
  checkpointsEnabled: boolean;
  checkpointsSetting: boolean | null;
}
const repoRow = async (name: string) =>
  (await trpcQuery<{ repos: RepoRow[] }>(server.url, TOKEN, "repos.list")).repos.find(
    (r) => r.name === name,
  );

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  seedState(tmpHome, {
    repos: [
      { name: "everywhere", path: "/nonexistent/everywhere", defaultBranch: "main", worktrees: [] },
      { name: "limited", path: "/nonexistent/limited", defaultBranch: "main", worktrees: [] },
    ],
  });
  server = await startServer({ tmpHome });
  // The hub needs a host to limit a repo to; the hub's own host is always there.
  await trpcMutate(server.url, TOKEN, "repos.update", {
    name: "limited",
    allowedHostIds: ["local"],
  });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("the switch follows the default and a choice sticks (S5)", async ({ page }) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  const checkpoints = new CheckpointsPage(page);
  await settings.goto();
  await settings.openRepoSettings("everywhere");

  // Available everywhere: on by default.
  await expect(checkpoints.checkpointsSwitch("everywhere")).toBeChecked();
  await expect(checkpoints.checkpointsNote("everywhere")).toHaveAttribute(
    "data-default",
    "all-workers",
  );

  // Limited to chosen workers: off by default.
  await settings.backToRepos();
  await settings.openRepo("limited");
  await expect(checkpoints.checkpointsSwitch("limited")).not.toBeChecked();
  await expect(checkpoints.checkpointsNote("limited")).toHaveAttribute("data-default", "limited");

  await checkpoints.toggleCheckpoints("limited");
  await expect(checkpoints.checkpointsSwitch("limited")).toBeChecked();
  await expect.poll(async () => (await repoRow("limited"))?.checkpointsSetting).toBe(true);
  await expect(checkpoints.checkpointsNote("limited")).toHaveAttribute("data-default", "stored");

  await settings.backToRepos();
  await settings.openRepo("everywhere");
  await checkpoints.toggleCheckpoints("everywhere");
  await expect(checkpoints.checkpointsSwitch("everywhere")).not.toBeChecked();
  await expect.poll(async () => (await repoRow("everywhere"))?.checkpointsEnabled).toBe(false);

  // Both choices show after a reload.
  await settings.goto();
  await settings.openRepoSettings("limited");
  await expect(checkpoints.checkpointsSwitch("limited")).toBeChecked();
  await settings.backToRepos();
  await settings.openRepo("everywhere");
  await expect(checkpoints.checkpointsSwitch("everywhere")).not.toBeChecked();
});
