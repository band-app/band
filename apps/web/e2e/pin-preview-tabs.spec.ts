/**
 * A preview tab (italic, reused by the next single-click) becomes a normal tab
 * when the user double-clicks its tab, double-clicks its row in the Explorer or
 * Changes tree, or edits it. Files opened any other way (Quick Open, a chat
 * file link) open pinned. A pinned tab is never replaced by a later single click.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { gitInHome as git } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { FileTreesPage } from "./pages/FileTreesPage";
import { FileViewerPage } from "./pages/FileViewerPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-pin-preview-tabs-token";
const REPO = "pin-preview-tabs-repo";
const BRANCH = "main";
const WORKTREE = toWorktreeId(REPO, BRANCH, "local");

const A = "src/aaa.ts";
const B = "src/bbb.ts";
const C = "src/ccc.ts";

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repo = join(tmpHome, REPO);
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, ["init", "-b", BRANCH]);
  for (const f of [A, B, C]) writeFileSync(join(repo, f), `export const x = "${f}";\n`);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  // Two uncommitted edits so the Changes tree lists A and B.
  writeFileSync(join(repo, A), `export const x = "${A} changed";\n`);
  writeFileSync(join(repo, B), `export const x = "${B} changed";\n`);
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repo,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: repo }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.beforeEach(() => {
  resetClientState(tmpHome);
});

async function openWorktree(page: import("@playwright/test").Page) {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const trees = new FileTreesPage(page, worktreePage);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();
  await trees.openFilesTab("src");
  await trees.expandFileTreeFolder("src", A);
  return { worktreePage, trees };
}

test("S1: double-clicking a preview tab pins it", async ({ page }) => {
  const { worktreePage, trees } = await openWorktree(page);
  await trees.clickFile(A);
  await worktreePage.expectFileTabPreview(A, true);

  await worktreePage.doubleClickFileTab(A);
  await worktreePage.expectFileTabPreview(A, false);

  await trees.clickFile(B);
  await expect(worktreePage.fileTab(A)).toBeAttached();
  await expect(worktreePage.fileTab(B)).toBeAttached();
  await worktreePage.expectFileTabPreview(B, true);
});

test("S2: double-clicking a file in the Explorer opens it pinned", async ({ page }) => {
  const { worktreePage, trees } = await openWorktree(page);
  await trees.doubleClickFile(A);
  await worktreePage.expectFileTabPreview(A, false);

  await trees.clickFile(B);
  await expect(worktreePage.fileTab(A)).toBeAttached();
  await worktreePage.expectFileTabPreview(B, true);
});

test("S3: double-clicking an open preview file pins the existing tab", async ({ page }) => {
  const { worktreePage, trees } = await openWorktree(page);
  await trees.clickFile(A);
  await worktreePage.expectFileTabPreview(A, true);

  await trees.doubleClickFile(A);
  await worktreePage.expectFileTabPreview(A, false);
  await expect(worktreePage.fileTab(A)).toHaveCount(1);
});

test("S4: editing a preview tab pins it", async ({ page }) => {
  const { worktreePage, trees } = await openWorktree(page);
  await trees.clickFile(A);
  await worktreePage.expectFileTabPreview(A, true);

  await new FileViewerPage(page).typeAtStart("// edited\n");
  await worktreePage.expectFileTabPreview(A, false);

  await trees.clickFile(B);
  await expect(worktreePage.fileTab(A)).toBeAttached();
});

test("S5: the same rules hold for diffs opened from the Changes tree", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const trees = new FileTreesPage(page, worktreePage);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();
  await trees.openChangesTab(A);

  await trees.clickChange(A);
  await worktreePage.expectDiffTabPreview(A, true);
  await worktreePage.doubleClickDiffTab(A);
  await worktreePage.expectDiffTabPreview(A, false);

  await trees.clickChange(B);
  await expect(worktreePage.diffTab(A)).toBeAttached();
  await worktreePage.expectDiffTabPreview(B, true);

  await trees.doubleClickChange(B);
  await worktreePage.expectDiffTabPreview(B, false);
});

test("S6: Quick Open and chat file links open pinned", async ({ page }) => {
  const { worktreePage, trees } = await openWorktree(page);
  await worktreePage.openFileViaQuickOpen(A);
  await worktreePage.expectFileTabPreview(A, false);

  await worktreePage.dispatchOpenFileEvent({ filename: "bbb.ts", worktreeId: WORKTREE });
  // The link opens Quick Open on the name; confirm the match.
  await expect.poll(() => worktreePage.selectedQuickOpenValue()).toBe(B);
  await worktreePage.pressQuickOpenKey("Enter");
  await expect(worktreePage.fileTab(B)).toBeAttached({ timeout: 15_000 });
  await worktreePage.expectFileTabPreview(B, false);

  await trees.clickFile(C);
  await expect(worktreePage.fileTab(A)).toBeAttached();
  await expect(worktreePage.fileTab(B)).toBeAttached();
  await worktreePage.expectFileTabPreview(C, true);
});

test("S7: a pinned tab stays pinned after a reload", async ({ page }) => {
  const { worktreePage, trees } = await openWorktree(page);
  await trees.doubleClickFile(A);
  await worktreePage.expectFileTabPreview(A, false);

  await worktreePage.reload();
  await worktreePage.waitForReady();
  await expect(worktreePage.fileTab(A)).toBeAttached();
  await worktreePage.expectFileTabPreview(A, false);
});
