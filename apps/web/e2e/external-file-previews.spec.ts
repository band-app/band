/**
 * An external tab (a file outside the worktree, on the worktree's worker) previews a PDF, an
 * image, a video and an HTML page the way a worktree file does. The bytes come through
 * `/api/external-file` as a Blob, the HTML through a signed folder grant in a sandboxed iframe.
 *
 * Boots the real server against a tmp home. The files sit in a temp folder outside the repo, so
 * they can only be reached by absolute path. No route is mocked.
 */

import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { FileViewerPage } from "./pages/FileViewerPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-external-file-previews-token";
const REPO = "external-previews-repo";
const BRANCH = "main";
const WORKTREE = toWorktreeId(REPO, BRANCH, "local");
const PDF = `%PDF-1.1
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
trailer<</Root 1 0 R>>
%%EOF
`;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome: string | undefined;
let outside!: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, REPO);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", BRANCH], tmpHome);
  writeFileSync(join(repoPath, "inside.ts"), "export const inside = 1;\n");
  git(repoPath, ["add", "."], tmpHome);
  git(repoPath, ["commit", "-m", "seed"], tmpHome);

  outside = realpathSync(mkdtempSync(join(tmpdir(), "band-external-previews-")));
  writeFileSync(join(outside, "doc.pdf"), PDF);
  writeFileSync(join(outside, "logo.png"), PNG);
  copyFileSync(join(import.meta.dirname, "fixtures", "clip.webm"), join(outside, "clip.webm"));
  writeFileSync(
    join(outside, "page.html"),
    '<!doctype html><link rel="stylesheet" href="style.css"><h1>Styled page</h1><img id="logo" alt="logo" src="logo.png">\n',
  );
  writeFileSync(join(outside, "style.css"), "h1 { color: rgb(255, 0, 0); }\n");

  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repoPath,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: repoPath }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => {
  if (tmpHome) resetClientState(tmpHome);
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
  if (outside) rmSync(outside, { recursive: true, force: true });
});

async function openExternal(
  page: import("@playwright/test").Page,
  path: string,
): Promise<{ worktreePage: WorktreePage; viewer: FileViewerPage }> {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();
  await worktreePage.dispatchOpenFileEvent({ filename: path, worktreeId: WORKTREE });
  await expect(worktreePage.fileTab(path)).toBeAttached({ timeout: 15_000 });
  return { worktreePage, viewer: new FileViewerPage(page) };
}

test.describe("external file previews", () => {
  test("S1: a PDF outside the worktree renders in the PDF viewer", async ({ page }) => {
    const { viewer } = await openExternal(page, join(outside, "doc.pdf"));

    await expect(viewer.pdfFrame).toBeVisible({ timeout: 15_000 });
    const src = await viewer.pdfFrame.getAttribute("src");
    expect(src).toMatch(/^blob:/);
    expect(await viewer.blobPrefix(src ?? "", 8)).toBe("%PDF-1.1");
  });

  test("S2: an image outside the worktree loads", async ({ page }) => {
    const { viewer } = await openExternal(page, join(outside, "logo.png"));

    await expect(viewer.imageTab("logo.png")).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => viewer.imageTabNaturalWidth("logo.png")).toBeGreaterThan(0);
  });

  test("S2: a video outside the worktree plays its metadata", async ({ page }) => {
    const { viewer } = await openExternal(page, join(outside, "clip.webm"));

    await expect(viewer.videoPlayer).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => viewer.videoReadyState()).toBeGreaterThanOrEqual(1);
  });

  test("S3: an HTML file outside the worktree previews with its stylesheet and image", async ({
    page,
  }) => {
    const { viewer } = await openExternal(page, join(outside, "page.html"));
    await viewer.showHtmlPreview();

    const heading = viewer.externalHtmlHeading("Styled page");
    await expect(heading).toBeVisible({ timeout: 15_000 });
    await expect(heading).toHaveCSS("color", "rgb(255, 0, 0)");
    await expect.poll(() => viewer.externalHtmlImageNaturalWidth("logo")).toBeGreaterThan(0);
  });
});
