/**
 * End-to-end coverage for the sections of the Changes tab, which follow
 * orca's source control panel: Conflicts, Changes (unstaged), Staged
 * Changes, Untracked Files and Committed on Branch.
 *
 *  - Each kind of change lands in its own section, in that order, with a
 *    file count and per-file line counts. Uncommitted work never shows up in
 *    "Committed on Branch".
 *  - Row and header actions stage, unstage and discard (with a confirmation).
 *  - A row opens that section's diff; "View all" opens every file of the
 *    section in one tab.
 *  - A collapsed section stays collapsed across a reload.
 *  - An unmerged file is listed under Conflicts and can be marked resolved.
 *
 * Every workspace is a real on-disk repo read and changed through the real
 * `workspace.getChanges` / `getFileDiff` / `stageFiles` / `unstageFiles` /
 * `discardChanges` procedures. No tRPC mocking, no `page.route`. Locators
 * live in `pages/ChangesPanelPage.ts`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { git, gitCommit } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChangesPanelPage } from "./pages/ChangesPanelPage";

// Wide viewport so `useIsDesktop()` reports true and the right sidepanel
// renders beside the center dockview.
test.use({ viewport: { width: 1920, height: 900 } });

const TOKEN = "e2e-changes-sections-token";

let server: ServerHandle;
let tmpHome: string;
const repos: Record<string, string> = {};
const workspaces: Record<string, string> = {};

/** A repo with `files` committed on `main`, then checked out on `branch`. */
function createRepo(name: string, files: Record<string, string>, branch = "work"): string {
  const path = join(tmpHome, name);
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-b", "main"]);
  for (const [file, content] of Object.entries(files)) writeFileSync(join(path, file), content);
  gitCommit(path, "initial");
  if (branch !== "main") git(path, ["checkout", "-b", branch]);
  repos[name] = path;
  workspaces[name] = toWorkspaceId(name, branch);
  return path;
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  // `view`: one of each — a commit on the branch, a staged new file, an
  // unstaged edit and an untracked file. Only read, never changed.
  const view = createRepo("view", { "keep.txt": "keep\n", "both.txt": "both\n" });
  writeFileSync(join(view, "committed.txt"), "one\ntwo\n");
  gitCommit(view, "add committed.txt");
  writeFileSync(join(view, "staged.txt"), "staged line\n");
  git(view, ["add", "staged.txt"]);
  writeFileSync(join(view, "keep.txt"), "keep\nunstaged line\n");
  // both.txt: a staged edit with an unstaged edit on top, so it is listed in
  // both Staged Changes and Changes.
  writeFileSync(join(view, "both.txt"), "both\nstaged edit\n");
  git(view, ["add", "both.txt"]);
  writeFileSync(join(view, "both.txt"), "both\nstaged edit\nunstaged edit\n");
  mkdirSync(join(view, "notes"));
  writeFileSync(join(view, "notes/todo.md"), "todo line\n");
  writeFileSync(join(view, "notes/later.md"), "later line\n");

  // `staging`: an edit and a new file, staged and unstaged by the test.
  const staging = createRepo("staging", { "a.txt": "a\n" });
  writeFileSync(join(staging, "a.txt"), "a\nedited\n");
  writeFileSync(join(staging, "new.txt"), "new\n");

  // `revert`: an edit reverted from its diff tab.
  const revert = createRepo("revert", { "r.txt": "r\n" });
  writeFileSync(join(revert, "r.txt"), "r\nreverted line\n");

  // `discard`: an edit and an untracked file the test throws away.
  const discard = createRepo("discard", { "b.txt": "b\n" });
  writeFileSync(join(discard, "b.txt"), "b\nthrow away\n");
  writeFileSync(join(discard, "junk.txt"), "junk\n");

  // `conflict`: a merge stopped on a conflict in c.txt.
  const conflict = createRepo("conflict", { "c.txt": "base\n" }, "main");
  git(conflict, ["checkout", "-b", "work"]);
  writeFileSync(join(conflict, "c.txt"), "work side\n");
  gitCommit(conflict, "work edit");
  git(conflict, ["checkout", "main"]);
  writeFileSync(join(conflict, "c.txt"), "main side\n");
  gitCommit(conflict, "main edit");
  git(conflict, ["checkout", "work"]);
  expect(() => git(conflict, ["merge", "main"])).toThrow();
  workspaces.conflict = toWorkspaceId("conflict", "work");

  seedState(tmpHome, {
    projects: Object.entries(repos).map(([name, path]) => ({
      name,
      path,
      defaultBranch: "main",
      worktrees: [{ branch: "work", path }],
    })),
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

// UI state lives on the server now: start each test from none, like the
// fresh localStorage each test's browser context used to give it.
test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("Each kind of change gets its own section, and uncommitted work stays out of Committed on Branch", async ({
  page,
}) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.goto(workspaces.view);

  await expect(changes.sectionRow("branch", "committed.txt")).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => changes.visibleSections())
    .toEqual(["unstaged", "staged", "untracked", "branch"]);

  await expect(changes.sectionCount("unstaged")).toHaveText("2");
  await expect(changes.sectionRow("unstaged", "keep.txt")).toBeVisible();
  await expect(changes.rowAdditions("unstaged", "keep.txt")).toHaveText("+1");

  await expect(changes.sectionCount("staged")).toHaveText("2");
  await expect(changes.sectionRow("staged", "staged.txt")).toBeVisible();

  // Untracked files show as a tree: the folder row carries its file count.
  await expect(changes.sectionCount("untracked")).toHaveText("2");
  await expect(changes.sectionRow("untracked", "notes")).toBeVisible();
  await expect(changes.sectionRow("untracked", "notes/todo.md")).toBeVisible();

  await expect(changes.sectionCount("branch")).toHaveText("1");
  await expect(changes.rowAdditions("branch", "committed.txt")).toHaveText("+2");
  for (const uncommitted of ["keep.txt", "both.txt", "staged.txt", "notes/todo.md"]) {
    await expect(changes.sectionRow("branch", uncommitted)).toHaveCount(0);
  }
});

test("A row opens that section's diff, and View all stacks the section's files in one tab", async ({
  page,
}) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.goto(workspaces.view);

  await changes.openSectionFile("unstaged", "keep.txt");
  await expect(changes.diffLine("unstaged line")).toBeVisible({ timeout: 15_000 });

  await changes.openSectionFile("branch", "committed.txt");
  await expect(changes.diffLine("two")).toBeVisible({ timeout: 15_000 });

  await changes.viewAll("untracked");
  await expect(changes.sectionDiffsLine("untracked", "notes/later.md", "later line")).toBeVisible({
    timeout: 15_000,
  });
  await expect(changes.sectionDiffsLine("untracked", "notes/todo.md", "todo line")).toBeVisible({
    timeout: 15_000,
  });
});

test("A file in Staged Changes and Changes shows each section's diff in one tab", async ({
  page,
}) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.goto(workspaces.view);

  await changes.openSectionFile("staged", "both.txt");
  await expect(changes.diffLine("staged edit")).toBeVisible({ timeout: 15_000 });
  await expect(changes.diffLine("unstaged edit")).toHaveCount(0);

  await changes.openSectionFile("unstaged", "both.txt");
  await expect(changes.diffLine("unstaged edit")).toBeVisible({ timeout: 15_000 });
  await expect(changes.diffTab("both.txt")).toHaveCount(1);
});

test("Reverting an unstaged diff from its tab restores the file", async ({ page }) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.goto(workspaces.revert);

  await changes.openSectionFile("unstaged", "r.txt");
  await expect(changes.diffLine("reverted line")).toBeVisible({ timeout: 15_000 });
  await changes.revertVisibleDiff();

  await expect(changes.section("unstaged")).toHaveCount(0, { timeout: 15_000 });
  expect(readFileSync(join(repos.revert, "r.txt"), "utf-8")).toBe("r\n");
});

test("Stage and unstage move files between Changes, Staged Changes and Untracked Files", async ({
  page,
}) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.goto(workspaces.staging);
  await expect(changes.sectionRow("unstaged", "a.txt")).toBeVisible({ timeout: 15_000 });

  await changes.runRowAction("unstaged", "a.txt", "stage");
  await expect(changes.sectionRow("staged", "a.txt")).toBeVisible({ timeout: 15_000 });
  await expect(changes.section("unstaged")).toHaveCount(0);

  await changes.runSectionAction("untracked", "stage");
  await expect(changes.sectionRow("staged", "new.txt")).toBeVisible({ timeout: 15_000 });
  await expect(changes.sectionCount("staged")).toHaveText("2");
  await expect(changes.section("untracked")).toHaveCount(0);

  await changes.runSectionAction("staged", "unstage");
  await expect(changes.sectionRow("unstaged", "a.txt")).toBeVisible({ timeout: 15_000 });
  await expect(changes.sectionRow("untracked", "new.txt")).toBeVisible();
  await expect(changes.section("staged")).toHaveCount(0);
});

test("Discard restores an edit and Delete all removes untracked files, each after confirming", async ({
  page,
}) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.goto(workspaces.discard);
  await expect(changes.sectionRow("unstaged", "b.txt")).toBeVisible({ timeout: 15_000 });

  await changes.runRowAction("unstaged", "b.txt", "discard");
  await expect(changes.discardDialog).toBeVisible();
  await changes.confirmDiscard();
  await expect(changes.section("unstaged")).toHaveCount(0, { timeout: 15_000 });
  expect(readFileSync(join(repos.discard, "b.txt"), "utf-8")).toBe("b\n");

  await changes.runSectionAction("untracked", "discard");
  await changes.confirmDiscard();
  await expect(changes.section("untracked")).toHaveCount(0, { timeout: 15_000 });
  expect(existsSync(join(repos.discard, "junk.txt"))).toBe(false);
});

test("A collapsed section stays collapsed across a reload", async ({ page }) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.goto(workspaces.view);
  await expect(changes.sectionRow("branch", "committed.txt")).toBeVisible({ timeout: 15_000 });

  await changes.toggleSection("branch");
  await expect(changes.sectionToggle("branch")).toHaveAttribute("aria-expanded", "false");
  await expect(changes.sectionRow("branch", "committed.txt")).toHaveCount(0);

  await changes.reload();
  await expect(changes.sectionCount("branch")).toHaveText("1", { timeout: 15_000 });
  await expect(changes.sectionToggle("branch")).toHaveAttribute("aria-expanded", "false");
  await expect(changes.sectionRow("branch", "committed.txt")).toHaveCount(0);

  await changes.toggleSection("branch");
  await expect(changes.sectionRow("branch", "committed.txt")).toBeVisible();
});

test("An unmerged file is listed under Conflicts until it is marked resolved", async ({ page }) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.goto(workspaces.conflict);

  await expect(changes.conflictBadge("c.txt")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => changes.visibleSections().then((s) => s[0])).toBe("conflicts");
  await expect(changes.section("unstaged")).toHaveCount(0);

  writeFileSync(join(repos.conflict, "c.txt"), "resolved\n");
  await changes.runSectionAction("conflicts", "stage");
  await expect(changes.sectionRow("staged", "c.txt")).toBeVisible({ timeout: 15_000 });
  await expect(changes.section("conflicts")).toHaveCount(0);
});
