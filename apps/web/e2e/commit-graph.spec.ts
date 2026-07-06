// Frontend integration test for the Graph tab/panel. Boots the real
// production server against a real on-disk git repo with commits across
// two branches, drives a real Chromium through the shared dockview, and
// asserts the commit-graph SVG + seeded commit subjects render in the DOM.
//
// No tRPC mocking — the Graph panel renders against the real
// `workspace.getCommitGraph` procedure reading real `git log` output.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { git } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-commit-graph-token";
const REPO_NAME = "graph-repo";
const BRANCH = "main";

// Wide viewport so useIsDesktop() reports true and the shared dockview
// (which owns the outer Graph tab) renders instead of the mobile layout.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;
let workspaceId: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(repoPath, { recursive: true });

  // main: initial ─ second
  // feature:       └─ feature-work
  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, "README.md"), "# graph-repo\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);

  git(repoPath, ["checkout", "-b", "feature"]);
  writeFileSync(join(repoPath, "feature.md"), "# feature\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "feature-work"]);

  git(repoPath, ["checkout", BRANCH]);
  writeFileSync(join(repoPath, "second.md"), "# second\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "second"]);

  // Stash an untracked change. `git stash -u` writes three bookkeeping
  // commits (the stash tip, its index snapshot, and a *parentless* untracked
  // root) — the untracked root is what used to render as a floating,
  // disconnected node once the stash tip is hidden.
  writeFileSync(join(repoPath, "scratch.md"), "wip\n");
  git(repoPath, ["stash", "push", "-u", "-m", "explore empty message"]);

  seedState(tmpHome, {
    projects: [
      {
        name: REPO_NAME,
        path: repoPath,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: repoPath }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
  workspaceId = toWorkspaceId(REPO_NAME, BRANCH);
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Graph tab", () => {
  test("renders the commit graph with every branch's commits", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(workspaceId);
    await workspacePage.waitForReady();

    await workspacePage.openGraphTab();

    // The commit-graph SVG renders (positive anchor before any assertions
    // about specific rows).
    await expect(workspacePage.commitGraph).toBeVisible();

    // Every branch's commit is listed — `getCommitGraph` runs `git log
    // --all`, so both the main tip and the side-branch commit show up.
    await expect(workspacePage.commitRow("initial")).toBeVisible();
    await expect(workspacePage.commitRow("second")).toBeVisible();
    await expect(workspacePage.commitRow("feature-work")).toBeVisible();
  });

  test("hides git stash bookkeeping commits by default", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(workspaceId);
    await workspacePage.waitForReady();

    await workspacePage.openGraphTab();

    // Positive anchor: the real history renders.
    await expect(workspacePage.commitGraph).toBeVisible();
    await expect(workspacePage.commitRow("second")).toBeVisible();

    // With "Hide stash" on (the default), none of the three stash
    // bookkeeping commits — including the parentless untracked root that
    // used to float disconnected — appear in the graph.
    await expect(workspacePage.stashBookkeepingRows()).toHaveCount(0);
  });

  test("shows the stash tip as one node but never its index/untracked internals", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(workspaceId);
    await workspacePage.waitForReady();

    await workspacePage.openGraphTab();
    await expect(workspacePage.commitGraph).toBeVisible();

    // Turn "Hide stash" off — the stash tip now renders as a single node
    // (positive anchor that toggling worked and the stash is shown).
    await workspacePage.toggleHideStash();
    await expect(workspacePage.stashTipRow("explore empty message")).toBeVisible();

    // …but its index/untracked snapshot commits are still never surfaced as
    // their own nodes (they'd draw extra dangling lanes — Fork/GitKraken hide
    // them too).
    await expect(workspacePage.stashInternalRows()).toHaveCount(0);
  });
});
