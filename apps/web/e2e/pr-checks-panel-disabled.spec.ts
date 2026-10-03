/**
 * A GitHub plugin listed in `plugins.disabled` contributes no Checks tab to
 * the right sidepanel. Real server with a github.com project; the fake `gh`
 * (`tests/fixtures/gh-stub.ts`) records that the server never ran it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
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
import { WorkspacePage } from "./pages/WorkspacePage";

test.use({ viewport: { width: 1920, height: 900 } });

const TOKEN = "e2e-pr-checks-disabled-token";
const PROJECT = "widgets";

let server: ServerHandle;
let stub: GhStub;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repo = join(tmpHome, PROJECT);
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
    projects: [
      {
        name: PROJECT,
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
  const workspace = new WorkspacePage(page, server.url, TOKEN);
  await workspace.gotoAndWaitForPlugins(toWorkspaceId(PROJECT, "main"));
  await workspace.waitForReady();
  await workspace.revealRightPanel();

  await expect(workspace.rightPanelTab("changes")).toBeVisible();
  await expect(workspace.rightPanelTab("github-pull-request")).toHaveCount(0);
  expect(stub.requests).toEqual([]);
});
