/**
 * The file viewer's Preview button for HTML files. It opens the file in a
 * Band browser tab through the hub's signed `/api/worktree-preview` URL.
 *
 * The real hub boots on a tmp HOME with a real git worktree. The harness is
 * the web build in plain Chromium, so the page object stubs the Electron
 * bridge to make the shell show browser tabs (see `HtmlPreviewPage`). What
 * stays manual: the page rendering inside the Electron `<webview>`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { removeBrowserTabs } from "./helpers/browser-tabs";
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
import { HtmlPreviewPage } from "./pages/HtmlPreviewPage";
import { WorktreePage } from "./pages/WorktreePage";

test.use({ viewport: { width: 2400, height: 900 } });

const TOKEN = "e2e-html-preview-token";
const REPO_NAME = "html-preview-repo";
const BRANCH = "main";
const HTML_PATH = "site/index.html";
const TS_PATH = "site/app.ts";
const MD_PATH = "site/notes.md";
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const INDEX_HTML =
  '<!doctype html><link rel="stylesheet" href="style.css"><img src="img/logo.png"><p>first version</p>';

let server: ServerHandle;
let tmpHome: string;
let repoPath: string;
let worktreeId: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(join(repoPath, "site", "img"), { recursive: true });
  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, HTML_PATH), INDEX_HTML);
  writeFileSync(join(repoPath, "site", "style.css"), "p { color: rgb(1, 2, 3); }");
  writeFileSync(join(repoPath, "site", "img", "logo.png"), PNG_BYTES);
  writeFileSync(join(repoPath, TS_PATH), "export const a = 1;\n");
  writeFileSync(join(repoPath, MD_PATH), "# notes\n");
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

test.beforeEach(async () => {
  await resetClientState(tmpHome);
  await removeBrowserTabs(server.url, TOKEN, worktreeId);
  writeFileSync(join(repoPath, HTML_PATH), INDEX_HTML);
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

async function openFile(
  page: import("@playwright/test").Page,
  path: string,
): Promise<{ preview: HtmlPreviewPage; worktree: WorktreePage }> {
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const trees = new FileTreesPage(page, worktree);
  const preview = new HtmlPreviewPage(page, server.url, TOKEN);
  await preview.installDesktopBridgeStub();
  await worktree.goto(worktreeId);
  await worktree.waitForReady();
  await trees.openFilesTab("site");
  await trees.expandFileTreeFolder("site", path);
  await trees.openFile(path);
  return { preview, worktree };
}

test.describe("HTML Preview button", () => {
  test("opens a browser tab whose page has its stylesheet applied and its image loaded", async ({
    page,
  }) => {
    const { preview } = await openFile(page, HTML_PATH);

    await preview.clickPreview();
    const tabUrl = await preview.expectSingleTabUrl(worktreeId);
    await expect(preview.browserTabs).toHaveCount(1);

    const rendered = await preview.openInSecondPage(tabUrl, "html-preview");
    expect(rendered.color).toBe("rgb(1, 2, 3)");
    expect(rendered.imageWidth).toBeGreaterThan(0);
    expect(rendered.text).toBe("first version");
  });

  test("a second click focuses the same tab and loads the edited file", async ({ page }) => {
    const { preview } = await openFile(page, HTML_PATH);

    await preview.clickPreview();
    const firstUrl = await preview.expectSingleTabUrl(worktreeId);

    // The new browser tab took the group header; go back to the file's tab.
    await preview.focusFileTab(HTML_PATH);
    writeFileSync(join(repoPath, HTML_PATH), INDEX_HTML.replace("first version", "second version"));
    await preview.clickPreview();

    await preview.expectBrowserTabActive();
    await expect(preview.browserTabs).toHaveCount(1);
    await expect
      .poll(async () => {
        const url = await preview.expectSingleTabUrl(worktreeId);
        return url !== firstUrl;
      })
      .toBe(true);
    const secondUrl = await preview.expectSingleTabUrl(worktreeId);
    const rendered = await preview.openInSecondPage(secondUrl, "html-preview-edited");
    expect(rendered.text).toBe("second version");
  });

  test("a click after a reload still reuses the tab", async ({ page }) => {
    const { preview } = await openFile(page, HTML_PATH);

    await preview.clickPreview();
    await preview.expectSingleTabUrl(worktreeId);
    await preview.reload();
    await expect(preview.browserTabs).toHaveCount(1);
    await preview.focusFileTab(HTML_PATH);
    await preview.clickPreview();

    await preview.expectBrowserTabActive();
    await expect(preview.browserTabs).toHaveCount(1);
    await preview.expectSingleTabUrl(worktreeId);
  });

  test("a non-HTML file shows no HTML Preview button", async ({ page }) => {
    const { preview } = await openFile(page, TS_PATH);

    await expect(preview.previewButton).toHaveCount(0);
  });

  test("a Markdown file keeps its own toggle and no HTML Preview button", async ({ page }) => {
    const { preview } = await openFile(page, MD_PATH);
    const viewer = new FileViewerPage(page);

    await expect(preview.markdownPreviewToggle).toBeVisible();
    await expect(preview.previewButton).toHaveCount(0);
    await viewer.expectContent("notes");
  });
});
