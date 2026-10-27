/**
 * End-to-end coverage for the Explorer's Download item (`FileBrowser`): a file
 * saves with its own name and exact bytes (text and a binary with NUL and high
 * bytes), and a folder row has no Download item. The real server streams the
 * file from `/api/worktree-file/<id>/<path>?download=1`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

const TOKEN = "e2e-explorer-download-token";
const REPO_NAME = "explorer-download-repo";
const BRANCH = "main";

const TEXT = "line one\nline two with ünïcode\n";
const BINARY = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80,
]);

let server: ServerHandle;
let tmpHome: string;
let worktreeId: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", BRANCH]);
  const files: Record<string, string | Buffer> = {
    "dl/notes.txt": TEXT,
    "dl/pixel.png": BINARY,
    "dl/sub/inner.txt": "inner\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repoPath, rel)), { recursive: true });
    writeFileSync(join(repoPath, rel), content);
  }
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

async function openExplorer(page: import("@playwright/test").Page) {
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const trees = new FileTreesPage(page, worktree);
  await worktree.goto(worktreeId);
  await worktree.waitForReady();
  await trees.openFilesTab("dl");
  await trees.expandFileTreeFolder("dl", "dl/notes.txt");
  return trees;
}

test("downloads a text file with its name and exact bytes", async ({ page }) => {
  const trees = await openExplorer(page);

  const saved = await trees.downloadFile("dl/notes.txt");

  expect(saved.name).toBe("notes.txt");
  expect(saved.bytes.equals(Buffer.from(TEXT, "utf8"))).toBe(true);
});

test("downloads a binary file with exact bytes", async ({ page }) => {
  const trees = await openExplorer(page);

  const saved = await trees.downloadFile("dl/pixel.png");

  expect(saved.name).toBe("pixel.png");
  expect(saved.bytes.equals(BINARY)).toBe(true);
});

test("a folder row has no Download item", async ({ page }) => {
  const trees = await openExplorer(page);

  await trees.openFileTreeMenu("dl/sub");

  await expect(trees.menuItem("new-file")).toBeVisible();
  await expect(trees.menuItem("download")).toHaveCount(0);
});
