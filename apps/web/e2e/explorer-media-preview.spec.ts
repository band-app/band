/**
 * End-to-end coverage for previewing media from the Explorer: an image and a
 * video open in a tab. The video is a real WebM served by the hub, which must
 * answer the browser's Range requests; the spec checks that it decodes, has
 * its size and duration, and plays. It runs once with a desktop viewport and
 * once with a phone-sized one, the layout the web app uses on mobile.
 */

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
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
import { FileViewerPage } from "./pages/FileViewerPage";
import { MobileLayoutPage } from "./pages/MobileLayoutPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-explorer-media-preview-token";
const REPO_NAME = "explorer-media-repo";
const BRANCH = "main";

// A 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let server: ServerHandle;
let tmpHome: string;
let worktreeId: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(join(repoPath, "media"), { recursive: true });
  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, "media", "pixel.png"), PNG);
  copyFileSync(
    join(import.meta.dirname, "fixtures", "clip.webm"),
    join(repoPath, "media", "clip.webm"),
  );
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

for (const [label, viewport] of [
  ["desktop", { width: 1600, height: 900 }],
  ["phone", { width: 800, height: 900 }],
] as const) {
  test.describe(label, () => {
    test.use({ viewport });

    async function openMedia(page: import("@playwright/test").Page, file: string) {
      const worktree = new WorktreePage(page, server.url, TOKEN);
      const trees = new FileTreesPage(page, worktree);
      await worktree.goto(worktreeId);
      if (label === "phone") {
        // Under 1024 px the worktree uses the mobile layout: the Explorer is a sheet.
        await worktree.waitForMobileReady();
        await new MobileLayoutPage(page, server.url, TOKEN).openSheet("explorer");
        await trees.openFileInMobileSheet("media", `media/${file}`);
      } else {
        await worktree.waitForReady();
        await trees.openFilesTab("media");
        await trees.expandFileTreeFolder("media", `media/${file}`);
        await trees.openFile(`media/${file}`);
      }
      return new FileViewerPage(page);
    }

    test("previews an image in a tab", async ({ page }) => {
      const viewer = await openMedia(page, "pixel.png");

      await expect(viewer.imageTab("pixel.png")).toBeVisible();
      await expect.poll(() => viewer.imageTabNaturalWidth("pixel.png")).toBe(1);
    });

    test("previews a video in a tab and plays it", async ({ page }) => {
      const viewer = await openMedia(page, "clip.webm");

      await expect(viewer.videoPlayer).toBeVisible();
      await expect.poll(async () => (await viewer.videoState()).width).toBe(64);
      expect((await viewer.videoState()).duration).toBeGreaterThan(0.5);

      await viewer.playVideo();
      await expect.poll(async () => (await viewer.videoState()).currentTime).toBeGreaterThan(0);
    });
  });
}
