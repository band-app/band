/**
 * End-to-end coverage for the Changes tab header and its branch picker:
 *
 *  - The header shows the worktree's current branch, and below it the diff
 *    target ("Uncommitted" until something is picked).
 *  - The picker searches branches on the server. With more branches than the
 *    picker lists, it shows the first page plus a "type to narrow" notice,
 *    and typing narrows the list to local AND remote-tracking matches.
 *  - Arrow keys + Enter pick a branch; the Changes tree then diffs against
 *    it, and the pick survives a reload (persisted per workspace).
 *  - The "Default branch" button resets the target to the project default.
 *  - Escape closes the picker without changing the target.
 *  - "Uncommitted" switches back from a branch target, and is only offered
 *    while the search box is empty.
 *
 * The repo is real git in a temp dir: 60 filler branches (more than the
 * picker's 50-branch page), plus remote-tracking refs written with
 * `git update-ref`, the same refs a `git fetch` leaves behind.
 */

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
import { ChangesPanelPage } from "./pages/ChangesPanelPage";

// Wide viewport so `useIsDesktop()` reports true and the right sidepanel
// renders beside the center dockview.
test.use({ viewport: { width: 1920, height: 900 } });

const TOKEN = "e2e-diff-target-picker-token";
const REPO_NAME = "picker-repo";
const DEFAULT_BRANCH = "main";
const HEAD_BRANCH = "work";
const FILLER_BRANCH_COUNT = 60;
const REMOTE_BRANCH = "origin/release-candidate";
// Committed on `work` only: in the tree when diffing against a branch, absent
// from the Uncommitted diff.
const COMMITTED_FILE = "committed.txt";
// Modified but not committed: in the tree for every target.
const EDITED_FILE = "file.txt";

let server: ServerHandle;
let tmpHome: string;
let workspaceId: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(repoPath, { recursive: true });

  git(repoPath, ["init", "-b", DEFAULT_BRANCH]);
  writeFileSync(join(repoPath, EDITED_FILE), "first line\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);
  for (let i = 0; i < FILLER_BRANCH_COUNT; i++) {
    git(repoPath, ["branch", `feature/filler-${String(i).padStart(2, "0")}`]);
  }
  git(repoPath, ["update-ref", "refs/remotes/origin/main", DEFAULT_BRANCH]);
  git(repoPath, ["update-ref", `refs/remotes/${REMOTE_BRANCH}`, DEFAULT_BRANCH]);
  git(repoPath, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

  git(repoPath, ["checkout", "-b", HEAD_BRANCH]);
  writeFileSync(join(repoPath, COMMITTED_FILE), "committed on work\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "work commit"]);
  writeFileSync(join(repoPath, EDITED_FILE), "first line\nsecond line\n");

  seedState(tmpHome, {
    projects: [
      {
        name: REPO_NAME,
        path: repoPath,
        defaultBranch: DEFAULT_BRANCH,
        worktrees: [{ branch: HEAD_BRANCH, path: repoPath }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
  workspaceId = toWorkspaceId(REPO_NAME, HEAD_BRANCH);
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("Header shows the current branch and the Uncommitted target", async ({ page }) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.goto(workspaceId);

  await expect(changes.headBranch).toHaveText(HEAD_BRANCH, { timeout: 15_000 });
  await expect.poll(() => changes.diffMode()).toBe("uncommitted");
  await expect(changes.changesTreeRow(EDITED_FILE)).toBeVisible();
  await expect(changes.changesTreeRow(COMMITTED_FILE)).toHaveCount(0);
});

test("Picker lists one page of branches and narrows to remote matches as you type", async ({
  page,
}) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.goto(workspaceId);
  await changes.openDiffTargetDropdown();

  // 60 filler + main + origin/main + the remote branch match, but only the
  // first 50 are listed, with the default branch and its remote copy first.
  await expect(changes.truncatedNotice).toBeVisible({ timeout: 15_000 });
  await expect(changes.branchOptions).toHaveCount(50);
  expect((await changes.visibleBranchOptions()).slice(0, 2)).toEqual([
    DEFAULT_BRANCH,
    "origin/main",
  ]);

  await changes.searchBranches("release-cand");
  await expect.poll(() => changes.visibleBranchOptions()).toEqual([REMOTE_BRANCH]);
  await expect(changes.truncatedNotice).toHaveCount(0);
  // The remote pointer `origin/HEAD` is never offered.
  await changes.searchBranches("HEAD");
  await expect(changes.noBranchesMatch).toBeVisible();
  await expect(changes.branchOptions).toHaveCount(0);
});

test("Keyboard picks a branch, the tree diffs against it, and the pick persists", async ({
  page,
}) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.goto(workspaceId);
  await changes.openDiffTargetDropdown();

  await changes.searchBranches("filler-0");
  await expect
    .poll(() => changes.visibleBranchOptions())
    .toEqual(Array.from({ length: 10 }, (_, i) => `feature/filler-0${i}`));
  await expect.poll(() => changes.highlightedOption()).toBe("feature/filler-00");
  await changes.pressInPicker("ArrowDown");
  await expect.poll(() => changes.highlightedOption()).toBe("feature/filler-01");
  await changes.pressInPicker("Enter");

  await expect(changes.diffTargetPicker).toHaveCount(0);
  await expect(changes.diffTargetTrigger).toContainText("feature/filler-01");
  await expect.poll(() => changes.diffMode()).toBe("branch");
  await expect.poll(() => changes.compareBranch()).toBe("feature/filler-01");
  // Diffing against a branch brings the work-only commit into the tree.
  await expect(changes.changesTreeRow(COMMITTED_FILE)).toBeVisible({ timeout: 15_000 });

  await changes.reload();
  await expect(changes.diffTargetTrigger).toContainText("feature/filler-01");
  await expect(changes.changesTreeRow(COMMITTED_FILE)).toBeVisible({ timeout: 15_000 });
});

test("Default branch button resets the target, and Escape closes without a change", async ({
  page,
}) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.goto(workspaceId);

  // Start from a non-default branch so the reset is observable.
  await changes.openDiffTargetDropdown();
  await changes.searchBranches("release-cand");
  await expect.poll(() => changes.visibleBranchOptions()).toEqual([REMOTE_BRANCH]);
  await expect.poll(() => changes.highlightedOption()).toBe(REMOTE_BRANCH);
  await changes.pressInPicker("Enter");
  await expect.poll(() => changes.compareBranch()).toBe(REMOTE_BRANCH);

  await changes.openDiffTargetDropdown();
  await changes.pickDefaultBranch();
  await expect(changes.diffTargetPicker).toHaveCount(0);
  await expect(changes.diffTargetTrigger).toContainText(DEFAULT_BRANCH);
  await expect.poll(() => changes.compareBranch()).toBe(DEFAULT_BRANCH);
  await expect.poll(() => changes.diffMode()).toBe("branch");

  await changes.openDiffTargetDropdown();
  await changes.searchBranches("filler-59");
  await expect.poll(() => changes.visibleBranchOptions()).toEqual(["feature/filler-59"]);
  await changes.pressInPicker("Escape");
  await expect(changes.diffTargetPicker).toHaveCount(0);
  await expect.poll(() => changes.compareBranch()).toBe(DEFAULT_BRANCH);
});

test("Uncommitted switches back from a branch target and hides while searching", async ({
  page,
}) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.goto(workspaceId);

  await changes.openDiffTargetDropdown();
  await changes.pickDefaultBranch();
  await expect(changes.changesTreeRow(COMMITTED_FILE)).toBeVisible({ timeout: 15_000 });

  await changes.openDiffTargetDropdown();
  await changes.searchBranches("filler-1");
  await expect(changes.branchOptions.first()).toBeVisible();
  await expect(changes.uncommittedOption).toHaveCount(0);
  await changes.searchBranches("");
  await expect(changes.uncommittedOption).toBeVisible();
  await changes.pickUncommitted();

  await expect.poll(() => changes.diffMode()).toBe("uncommitted");
  await expect(changes.changesTreeRow(EDITED_FILE)).toBeVisible();
  await expect(changes.changesTreeRow(COMMITTED_FILE)).toHaveCount(0);
});
