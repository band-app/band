// Frontend integration test for the Graph tab's interactive layer: the
// commit-details panel and a context-menu write action. Boots the real
// production server against a real on-disk git repo, drives a real Chromium
// through the shared dockview, and asserts on the real rendered DOM + the
// real git effect on disk.
//
// No tRPC mocking — the details panel renders against the real
// `workspace.getCommitDetails` procedure and "Create branch…" runs the real
// `workspace.createBranch` mutation against the workspace's worktree.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { git, gitEnv } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorkspacePage } from "./pages/WorkspacePage";

/** Read a git command's stdout (the shared `git` helper returns void). */
function gitOut(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8" }).trim();
}

const TOKEN = "e2e-commit-graph-actions-token";
const REPO_NAME = "graph-actions-repo";
const BRANCH = "main";

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;
let repoPath: string;
let workspaceId: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(repoPath, { recursive: true });

  // main: initial ─ second
  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, "README.md"), "# graph-actions-repo\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);

  writeFileSync(join(repoPath, "second.md"), "# second\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "second"]);

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

test.describe("Graph tab — interactive", () => {
  test("opens the commit-details panel with the changed-file list on click", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(workspaceId);
    await workspacePage.waitForReady();
    await workspacePage.openGraphTab();
    await expect(workspacePage.commitGraph).toBeVisible();

    // Selecting the `second` commit opens the details panel, which lists the
    // file that commit changed (second.md, read via getCommitDetails).
    await workspacePage.openCommitDetails("second");
    await expect(workspacePage.commitDetails).toBeVisible();
    // The changed-file list entry (exact match avoids the diff-header lines
    // that also contain "second.md").
    await expect(workspacePage.commitDetails.getByText("second.md", { exact: true })).toBeVisible();
  });

  test("creates a branch from a commit's context menu (real mutation)", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(workspaceId);
    await workspacePage.waitForReady();
    await workspacePage.openGraphTab();
    await expect(workspacePage.commitGraph).toBeVisible();
    await expect(workspacePage.commitRow("initial")).toBeVisible();

    // Right-click "initial" → Create branch… → name it → submit. The mutation
    // creates `topic` at that commit and checks it out; the graph refetches.
    await workspacePage.createBranchFromCommit("initial", "topic");

    // The new branch's ref badge now decorates the graph (HEAD -> topic).
    await expect(workspacePage.refBadge("topic")).toBeVisible();

    // …and it exists on disk as a real branch at the `initial` commit.
    // `main` still points at `second`, so `main~1` is the `initial` commit.
    const initialSha = gitOut(repoPath, ["rev-parse", "main~1"]);
    const topicSha = gitOut(repoPath, ["rev-parse", "topic"]);
    expect(topicSha).toBe(initialSha);
    expect(gitOut(repoPath, ["symbolic-ref", "--short", "HEAD"])).toBe("topic");
  });
});
