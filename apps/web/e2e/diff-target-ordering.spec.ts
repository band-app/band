/**
 * End-to-end coverage for the diff-target picker's default selection and
 * option ordering in the Changes tab of the right sidepanel (#643).
 *
 * Two behaviours are pinned here:
 *  1. A fresh workspace (no stored pick) compares against the project's
 *     default branch.
 *  2. The picker floats staging-style integration branches (develop,
 *     staging, …) to the top in priority order, then the project's default
 *     branch, then every other branch, most recent commit first. There is no
 *     "Uncommitted" entry: uncommitted work has its own Changes sections.
 *
 * The ranking itself runs on the server (`DiffService.listBranches`), since
 * the picker searches there instead of loading every branch. Search, the
 * default-branch button and keyboard picking are covered in
 * `diff-target-picker.spec.ts`.
 *
 * The branch list reaches the picker through the real git pipeline
 * (`workspace.listBranches` → `git for-each-ref` in an on-disk worktree)
 * exactly the way production does — no tRPC mocking, no `page.route`. All
 * locators and the dropdown-open dance live in `pages/ChangesPanelPage.ts`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { git, gitEnv } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { BRANCH_OPTION_TESTID, ChangesPanelPage } from "./pages/ChangesPanelPage";

// Wide viewport so `useIsDesktop()` reports true and the right sidepanel
// renders beside the center dockview — matching the other diff e2e specs.
test.use({ viewport: { width: 1920, height: 900 } });

const TOKEN = "e2e-diff-target-order-token";
const REPO_NAME = "target-order-repo";
const DEFAULT_BRANCH = "main";
// The worktree checks out `work` so the default branch (`main`) differs from
// HEAD — that's the case where `listBranches` keeps `main` in the list and
// pins it, letting the test exercise the default-branch pin alongside the
// staging pins.
const HEAD_BRANCH = "work";
const FILE_PATH = "file.txt";

let server: ServerHandle;
let tmpHome: string;
let workspaceId: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(repoPath, { recursive: true });

  // Real repo: commit on `main`, branch out the staging-style + feature
  // branches, then check out `work` and leave an uncommitted modification so
  // the Changes tab has content to render.
  git(repoPath, ["init", "-b", DEFAULT_BRANCH]);
  writeFileSync(join(repoPath, FILE_PATH), "first line\nsecond line\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);
  // Three staging-style branches, seeded so their priority order in
  // STAGING_BRANCH_PRIORITY (develop=0, stage=3, staging=4) is NON-adjacent
  // to the input creation order — this pins the priority-list traversal
  // (develop→stage→staging) rather than a two-entry endpoints check that a
  // buggy comparator could still satisfy. Two feature branches (`apple`,
  // `zebra`) fall to the remainder, where `zebra` gets the newer commit so
  // recency, not the alphabet, decides their order.
  git(repoPath, ["branch", "develop"]);
  git(repoPath, ["branch", "staging"]);
  git(repoPath, ["branch", "stage"]);
  git(repoPath, ["branch", "apple"]);
  git(repoPath, ["checkout", "-b", "zebra"]);
  writeFileSync(join(repoPath, "zebra.txt"), "zebra\n");
  git(repoPath, ["add", "."]);
  // A committer date past the other commits', which all land in the same
  // second, so `zebra` is unambiguously the most recent.
  execFileSync("git", ["commit", "-m", "zebra"], {
    cwd: repoPath,
    env: { ...gitEnv, GIT_COMMITTER_DATE: "2099-01-01T00:00:00Z" },
  });
  git(repoPath, ["checkout", DEFAULT_BRANCH]);
  git(repoPath, ["checkout", "-b", HEAD_BRANCH]);
  writeFileSync(join(repoPath, FILE_PATH), "first line\nsecond line\nthird line\n");

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

// UI state lives on the server now: start each test from none, like the
// fresh localStorage each test's browser context used to give it.
test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("Diff target defaults to the default branch on a fresh workspace", async ({ page }) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.goto(workspaceId);
  // The trigger shows the branch name (runtime data this spec seeded); no
  // pick is stored yet.
  await expect(changes.diffTargetTrigger).toContainText(DEFAULT_BRANCH, { timeout: 15_000 });
  await expect.poll(() => changes.compareBranch()).toBeNull();
});

test("Diff target dropdown pins staging branches, then default, then the most recent", async ({
  page,
}) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.goto(workspaceId);
  await expect(changes.diffTargetTrigger).toBeVisible({ timeout: 15_000 });

  // Open once; the list settles as `listBranches` resolves and the client
  // reorders, so poll the (re-rendering) open listbox rather than racing
  // the branch fetch. `main` is present because HEAD is `work`, so the
  // default branch isn't dropped as "comparing against yourself".
  await changes.openDiffTargetDropdown();
  await expect(changes.firstDiffTargetOption).toHaveAttribute("data-testid", BRANCH_OPTION_TESTID);
  await expect
    .poll(async () => (await changes.visibleDiffTargetOptions()).join(","), {
      timeout: 15_000,
    })
    .toBe(["develop", "stage", "staging", "main", "zebra", "apple"].join(","));
});
