/**
 * The markdown preview lays its text out in a centered column (narrow) or
 * across the whole pane (full width). The choice is one global preference,
 * kept on the Band server per device type (`band:markdown-preview-width`),
 * so it survives a reload and a server restart, and toggling it reconfigures
 * the open editor instead of recreating it: unsaved edits and the scroll
 * position stay.
 *
 * Drives a real Band server against an on-disk worktree.
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
import { FileViewerPage } from "./pages/FileViewerPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-markdown-preview-width-token";
const REPO = "md-width-repo";
const BRANCH = "main";
const WORKTREE = toWorktreeId(REPO, BRANCH, "local");
const FILE = "LONG.md";
const WIDTH_KEY = "band:markdown-preview-width";
/** 61.25rem, the narrow column cap in `markdownPreviewWidthTheme`. */
const NARROW_PX = 980;
const TARGET_HEADING = "Section 30";
const EDIT = "Unsaved edit marker";

const PARAGRAPH = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(12).trim();
const LONG_DOC = [
  "# Long document",
  "",
  "First paragraph.",
  "",
  ...Array.from({ length: 60 }, (_, i) => [`## Section ${i + 1}`, "", PARAGRAPH, ""]).flat(),
].join("\n");

const DESKTOP = { viewport: { width: 1600, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

test.use(DESKTOP);

/** Full width: the column (border-box, so padding included) fills the pane,
 *  short of at most a scrollbar, and keeps its 32px side padding. */
async function expectFullWidth(viewer: FileViewerPage): Promise<void> {
  await expect
    .poll(async () => {
      const { pane, column } = await viewer.previewWidths();
      return pane - column;
    })
    .toBeLessThan(20);
  expect((await viewer.previewWidths()).sidePadding).toBe("32px 32px");
}

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repo = join(tmpHome, REPO);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", BRANCH]);
  writeFileSync(join(repo, FILE), LONG_DOC);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
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

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("full width sticks across a reload and a restart, and toggling keeps edits and scroll", async ({
  page,
  browser,
}) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const viewer = new FileViewerPage(page);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();
  await worktreePage.openFileLeaf(FILE);
  await expect(viewer.previewHeading(1, "Long document")).toBeVisible({ timeout: 20_000 });

  // Narrow by default: a centered column wider than the old 48rem (768px)
  // cap, and narrower than the pane.
  await expect(viewer.previewWidthToggle).toHaveAttribute("aria-pressed", "false");
  const narrow = await viewer.previewWidths();
  expect(narrow.column).toBe(NARROW_PX);
  expect(narrow.pane).toBeGreaterThan(NARROW_PX + 100);

  // An unsaved edit, then scroll deep into the document.
  await viewer.scrollPreviewToTop();
  await viewer.typeInPreview(`${EDIT}\n\n`);
  await viewer.scrollPreviewToHeading(TARGET_HEADING);

  await viewer.togglePreviewWidth();
  await expect(viewer.previewWidthToggle).toHaveAttribute("aria-pressed", "true");
  await expectFullWidth(viewer);
  // The lines rewrapped, and the heading the user was reading is still at
  // the top of the view: the editor kept its place instead of restarting.
  expect(await viewer.previewScrollTop()).toBeGreaterThan(0);
  await expect
    .poll(async () => Math.abs(await viewer.previewHeadingOffset(TARGET_HEADING)))
    .toBeLessThan(5);
  // The unsaved edit is still in the buffer.
  await viewer.scrollPreviewToTop();
  await expect(viewer.markdownPreview).toContainText(EDIT);

  await expect
    .poll(() => worktreePage.readServerClientState(null, WIDTH_KEY, "desktop"))
    .toBe("full");
  // Per device type: the phone keeps its own (default) width.
  expect(await worktreePage.readServerClientState(null, WIDTH_KEY, "mobile")).toBeNull();

  await worktreePage.reload();
  await worktreePage.waitForReady();
  await expect(viewer.previewHeading(1, "Long document")).toBeVisible({ timeout: 20_000 });
  await expect(viewer.previewWidthToggle).toHaveAttribute("aria-pressed", "true");
  await expectFullWidth(viewer);

  // After a restart, a browser with empty localStorage gets the choice from
  // the server alone (this page's localStorage would otherwise re-upload it).
  server = await server.restart();
  const context = await browser.newContext(DESKTOP);
  try {
    const freshPage = await context.newPage();
    const fresh = new WorktreePage(freshPage, server.url, TOKEN);
    const freshViewer = new FileViewerPage(freshPage);
    await fresh.goto(WORKTREE);
    await fresh.waitForReady();
    await fresh.openFileLeaf(FILE);
    await expect(freshViewer.previewHeading(1, "Long document")).toBeVisible({ timeout: 20_000 });
    await expect(freshViewer.previewWidthToggle).toHaveAttribute("aria-pressed", "true");
    await expectFullWidth(freshViewer);

    // And back to narrow.
    await freshViewer.togglePreviewWidth();
    await expect(freshViewer.previewWidthToggle).toHaveAttribute("aria-pressed", "false");
    await expect.poll(async () => (await freshViewer.previewWidths()).column).toBe(NARROW_PX);
    await expect.poll(() => fresh.readServerClientState(null, WIDTH_KEY, "desktop")).toBe("narrow");
  } finally {
    await context.close();
  }
});

test("a phone shows the preview without the width toggle", async ({ browser }) => {
  const context = await browser.newContext(PHONE);
  try {
    const page = await context.newPage();
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const viewer = new FileViewerPage(page);
    await worktreePage.goto(WORKTREE);
    await worktreePage.waitForMobileReady();
    await worktreePage.openFileLeaf(FILE);
    await expect(viewer.previewHeading(1, "Long document")).toBeVisible({ timeout: 20_000 });
    await expect(viewer.previewWidthToggle).toHaveCount(0);
  } finally {
    await context.close();
  }
});
