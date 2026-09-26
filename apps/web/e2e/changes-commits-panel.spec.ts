/**
 * End-to-end coverage for the Commits section of the Changes tab: the
 * workspace's HEAD history with its graph, ref pills, expandable commits
 * whose files open a per-commit diff, paging, and reloading when HEAD moves.
 *
 * Both workspaces are real on-disk repos read through the real
 * `workspace.getCommitHistory` / `getCommitDetails` / `getCommitFileDiff`
 * procedures. No tRPC mocking, no `page.route`. Locators live in
 * `pages/ChangesPanelPage.ts`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { git, gitCommit } from "./helpers/git";
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

const TOKEN = "e2e-commits-panel-token";
const GRAPH_REPO = "graph-repo";
const LONG_REPO = "long-repo";
const BRANCH = "main";
// One more than the panel's page size, so the history has a second page.
const LONG_HISTORY = 51;
// The `edit` commit changes line 2; line 10 is outside git's default three
// lines of context, so it shows only in a full-context diff.
const NOTES = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);

let server: ServerHandle;
let tmpHome: string;
let graphRepo: string;
let graphWorkspace: string;
let longWorkspace: string;
const sha: Record<string, string> = {};

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  // main:    initial ─ edit ─────────── merge
  //                 └─ feature-work ──┘
  // side:           └─ side-work        (never merged)
  //
  // `edit` carries three refs (branch `release`, remote `origin/main`,
  // tag `v1.0`) so its row overflows into "+1".
  graphRepo = join(tmpHome, GRAPH_REPO);
  mkdirSync(graphRepo, { recursive: true });
  git(graphRepo, ["init", "-b", BRANCH]);
  writeFileSync(join(graphRepo, "notes.txt"), `${NOTES.join("\n")}\n`);
  sha.initial = gitCommit(graphRepo, "initial");
  git(graphRepo, ["tag", "v0.1"]);

  git(graphRepo, ["checkout", "-b", "feature"]);
  writeFileSync(join(graphRepo, "feature.txt"), "feature line\n");
  sha.feature = gitCommit(graphRepo, "feature-work");

  git(graphRepo, ["checkout", "-b", "side", sha.initial]);
  writeFileSync(join(graphRepo, "side.txt"), "side line\n");
  sha.side = gitCommit(graphRepo, "side-work");

  git(graphRepo, ["checkout", BRANCH]);
  const edited = NOTES.map((line, i) => (i === 1 ? "line 2 changed in edit" : line));
  writeFileSync(join(graphRepo, "notes.txt"), `${edited.join("\n")}\n`);
  sha.edit = gitCommit(graphRepo, "edit");
  git(graphRepo, ["branch", "release"]);
  git(graphRepo, ["tag", "v1.0"]);
  git(graphRepo, ["update-ref", "refs/remotes/origin/main", sha.edit]);

  git(graphRepo, ["merge", "--no-ff", "--no-commit", "feature"]);
  sha.merge = gitCommit(graphRepo, "merge feature");

  const longRepo = join(tmpHome, LONG_REPO);
  mkdirSync(longRepo, { recursive: true });
  git(longRepo, ["init", "-b", BRANCH]);
  for (let i = 1; i <= LONG_HISTORY; i++) {
    const commitSha = gitCommit(longRepo, `commit ${i}`);
    if (i === 1) sha.longOldest = commitSha;
  }

  seedState(tmpHome, {
    projects: [
      {
        name: GRAPH_REPO,
        path: graphRepo,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: graphRepo }],
      },
      {
        name: LONG_REPO,
        path: longRepo,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: longRepo }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
  graphWorkspace = toWorkspaceId(GRAPH_REPO, BRANCH);
  longWorkspace = toWorkspaceId(LONG_REPO, BRANCH);
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Changes tab Commits panel", () => {
  test("shows HEAD's history with HEAD marked and ref pills", async ({ page }) => {
    const changes = new ChangesPanelPage(page, server.url, TOKEN);
    await changes.goto(graphWorkspace);

    await expect(changes.commitRow(sha.merge)).toBeVisible({ timeout: 15_000 });
    await expect(changes.commitRow(sha.merge)).toHaveAttribute("data-head", "true");
    await expect(changes.commitRow(sha.feature)).toBeVisible();
    await expect(changes.commitRow(sha.initial)).toBeVisible();
    // Positive anchor above; the unmerged branch's commit is not HEAD history.
    await expect(changes.commitRow(sha.side)).toHaveCount(0);
    await expect(changes.commitsCount).toHaveText("4");

    await expect(changes.commitRef(sha.merge, BRANCH)).toHaveAttribute("data-ref-kind", "head");
    await expect(changes.commitRef(sha.feature, "feature")).toHaveAttribute(
      "data-ref-kind",
      "branch",
    );
    await expect(changes.commitRef(sha.initial, "v0.1")).toHaveAttribute("data-ref-kind", "tag");
    // `edit` has three refs: two pills fit, the third folds into "+1".
    await expect(changes.commitRef(sha.edit, "release")).toBeVisible();
    await expect(changes.commitRef(sha.edit, "origin/main")).toBeVisible();
    await expect(changes.commitMoreRefs(sha.edit)).toHaveText("+1");
  });

  test("expanding a commit lists its files, and a file opens its diff for that commit", async ({
    page,
  }) => {
    const changes = new ChangesPanelPage(page, server.url, TOKEN);
    await changes.goto(graphWorkspace);

    await changes.expandCommit(sha.edit);
    await expect(changes.commitFile(sha.edit, "notes.txt")).toBeVisible();

    await changes.openCommitFile(sha.edit, "notes.txt");
    await expect(changes.diffTab("notes.txt")).toHaveAttribute("data-commit", sha.edit);
    // The worktree has no uncommitted changes, so a working-tree diff would be
    // empty: the added line is the commit's own change, in full context.
    await expect(changes.diffLine("line 2 changed in edit")).toBeVisible({ timeout: 15_000 });
    await expect(changes.diffLine("line 10")).toBeVisible();

    // The commit diff tab is restored on reload, then closes like any tab.
    await changes.reload();
    await expect(changes.diffTab("notes.txt")).toHaveAttribute("data-commit", sha.edit);
    await expect(changes.diffLine("line 2 changed in edit")).toBeVisible({ timeout: 15_000 });
    await changes.closeDiffTab("notes.txt");
    await expect(changes.diffTab("notes.txt")).toHaveCount(0);
  });

  test("the collapsed state survives a reload", async ({ page }) => {
    const changes = new ChangesPanelPage(page, server.url, TOKEN);
    await changes.goto(graphWorkspace);
    await expect(changes.commitRow(sha.merge)).toBeVisible({ timeout: 15_000 });

    await changes.toggleCommits();
    await expect(changes.commitsToggle).toHaveAttribute("aria-expanded", "false");
    await expect(changes.commitsList).toHaveCount(0);

    await changes.reload();
    await expect(changes.commitsToggle).toHaveAttribute("aria-expanded", "false");
    await expect(changes.commitsList).toHaveCount(0);

    await changes.toggleCommits();
    await expect(changes.commitRow(sha.merge)).toBeVisible({ timeout: 15_000 });
  });

  test("scrolling to the end loads the next page, also after re-expanding", async ({ page }) => {
    const changes = new ChangesPanelPage(page, server.url, TOKEN);
    await changes.goto(longWorkspace);

    await expect(changes.commitsCount).toHaveText("50+", { timeout: 15_000 });
    await expect(changes.commitRow(sha.longOldest)).toHaveCount(0);

    // Collapsing and expanding remounts the list; infinite scroll must still work.
    await changes.toggleCommits();
    await expect(changes.commitsList).toHaveCount(0);
    await changes.toggleCommits();
    await expect(changes.commitsCount).toHaveText("50+");

    await changes.scrollCommitsToEnd();
    await expect(changes.commitRow(sha.longOldest)).toBeVisible({ timeout: 15_000 });
    await expect(changes.commitsCount).toHaveText(String(LONG_HISTORY));
  });

  test("a new commit appears without a manual refresh", async ({ page }) => {
    const changes = new ChangesPanelPage(page, server.url, TOKEN);
    await changes.goto(graphWorkspace);
    await expect(changes.commitRow(sha.merge)).toHaveAttribute("data-head", "true", {
      timeout: 15_000,
    });

    writeFileSync(join(graphRepo, "later.txt"), "later\n");
    const later = gitCommit(graphRepo, "later");
    try {
      // The panel polls a HEAD/refs signature every 5 s and reloads on change.
      await expect(changes.commitRow(later)).toHaveAttribute("data-head", "true", {
        timeout: 15_000,
      });
      await expect(changes.commitRef(later, BRANCH)).toBeVisible();
      await expect(changes.commitRow(sha.merge)).not.toHaveAttribute("data-head", "true");
    } finally {
      // Put `main` back so the other tests see the seeded history in any order.
      git(graphRepo, ["reset", "--hard", sha.merge]);
    }
  });
});
