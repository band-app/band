/**
 * A GitHub plugin listed in `plugins.disabled` contributes no Checks tab to
 * the right sidepanel. Real server with a github.com repo; the fake `gh`
 * (`tests/fixtures/gh-stub.ts`) records that the server never ran it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { type GhStub, ghStub } from "../../hub/tests/fixtures/gh-stub";
import { FAKE_REPO } from "../../hub/tests/fixtures/github-review-data";
import { git, gitCommit } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorktreePage } from "./pages/WorktreePage";

test.use({ viewport: { width: 1920, height: 900 } });

const TOKEN = "e2e-pr-checks-disabled-token";
const REPO = "widgets";

let server: ServerHandle;
let stub: GhStub;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repo = join(tmpHome, REPO);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  gitCommit(repo, "init");
  git(repo, [
    "remote",
    "add",
    "origin",
    `https://github.com/${FAKE_REPO.owner}/${FAKE_REPO.name}.git`,
  ]);
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repo,
        defaultBranch: "main",
        worktrees: [{ name: "main", branch: "main", path: repo }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN, plugins: { disabled: ["github"] } });
  stub = await ghStub.start();
  server = await startServer({ tmpHome, env: stub.env });
});

test.afterAll(async () => {
  await server?.close();
  await stub?.stop();
  cleanupTmpHome(tmpHome);
});

test("a disabled GitHub plugin adds no Checks tab and never runs gh", async ({ page }) => {
  const worktree = new WorktreePage(page, server.url, TOKEN);
  await worktree.gotoAndWaitForPlugins(toWorktreeId(REPO, "main"));
  await worktree.waitForReady();
  await worktree.revealRightPanel();

  await expect(worktree.rightPanelTab("changes")).toBeVisible();
  await expect(worktree.rightPanelTab("github-pull-request")).toHaveCount(0);
  // The local host probes `gh --version` once, at hub boot, to set its `gh` capability. That probe
  // belongs to the host, not the plugin, and can land after the stub starts recording. Any other
  // call is the plugin or a poller running gh.
  const pluginRequests = stub.requests.filter(
    (request) => !(request.args.length === 1 && request.args[0] === "--version"),
  );
  expect(pluginRequests).toEqual([]);
});
