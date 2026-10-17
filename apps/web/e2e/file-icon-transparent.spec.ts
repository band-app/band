/**
 * File icons whose SVG relies on the root `fill="none"` (README is one) must
 * render without a filled box behind the glyph. The real server boots against
 * a tmp `$HOME` with an on-disk git repo, and the spec reads the rendered
 * pixels of the Explorer row's icon.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { toWorktreeId } from "@/dashboard";

import { git } from "./helpers/git";
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
import { WorktreePage } from "./pages/WorktreePage";

test.use({ viewport: { width: 1600, height: 900 } });

const TOKEN = "e2e-file-icon-transparent-token";
const REPO_NAME = "file-icon-repo";
const BRANCH = "main";

let server: ServerHandle;
let tmpHome: string;
let worktreeId: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, "README.md"), "# readme\n");
  writeFileSync(join(repoPath, "index.ts"), "export {};\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);
  seedState(tmpHome, {
    repos: [
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
  worktreeId = toWorktreeId(REPO_NAME, BRANCH, "local");
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("README icon has no filled box behind the glyph", async ({ page }) => {
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const trees = new FileTreesPage(page, worktree);
  await worktree.goto(worktreeId);
  await worktree.waitForReady();
  await trees.openFilesTab("README.md");

  const { corner, background } = await trees.iconCornerAndRowBackground("README.md");
  // The corner is outside the blue circle, so it shows the row background.
  expect(corner).toEqual(background);

  // A icon with no root paint attributes still draws its glyph.
  await expect(trees.fileTreeRowIcon("index.ts")).toBeVisible();
});
