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
import { toWorkspaceId } from "@/dashboard";
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
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-markdown-preview-width-token";
const PROJECT = "md-width-repo";
const BRANCH = "main";
const WORKSPACE = toWorkspaceId(PROJECT, BRANCH);
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

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repo = join(tmpHome, PROJECT);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", BRANCH]);
  writeFileSync(join(repo, FILE), LONG_DOC);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
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
}) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const viewer = new FileViewerPage(page);
  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();
  await workspacePage.openFileLeaf(FILE);
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
  // The column spans the pane, less the 32px side padding on each side.
  await expect
    .poll(async () => (await viewer.previewWidths()).column)
    .toBeGreaterThan(narrow.pane - 70);
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
    .poll(() => workspacePage.readServerClientState(null, WIDTH_KEY, "desktop"))
    .toBe("full");
  // Per device type: the phone keeps its own (default) width.
  expect(await workspacePage.readServerClientState(null, WIDTH_KEY, "mobile")).toBeNull();

  await workspacePage.reload();
  await workspacePage.waitForReady();
  await expect(viewer.previewHeading(1, "Long document")).toBeVisible({ timeout: 20_000 });
  await expect(viewer.previewWidthToggle).toHaveAttribute("aria-pressed", "true");
  const afterReload = await viewer.previewWidths();
  expect(afterReload.column).toBeGreaterThan(afterReload.pane - 70);

  server = await server.restart();
  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();
  await expect(viewer.previewHeading(1, "Long document")).toBeVisible({ timeout: 20_000 });
  await expect(viewer.previewWidthToggle).toHaveAttribute("aria-pressed", "true");
  const afterRestart = await viewer.previewWidths();
  expect(afterRestart.column).toBeGreaterThan(afterRestart.pane - 70);

  // And back to narrow.
  await viewer.togglePreviewWidth();
  await expect(viewer.previewWidthToggle).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await viewer.previewWidths()).column).toBe(NARROW_PX);
  await expect
    .poll(() => workspacePage.readServerClientState(null, WIDTH_KEY, "desktop"))
    .toBe("narrow");
});

test("a phone shows the preview full width, without the toggle", async ({ browser }) => {
  const context = await browser.newContext(PHONE);
  try {
    const page = await context.newPage();
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const viewer = new FileViewerPage(page);
    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForMobileReady();
    await workspacePage.openFileLeaf(FILE);
    await expect(viewer.previewHeading(1, "Long document")).toBeVisible({ timeout: 20_000 });
    const widths = await viewer.previewWidths();
    expect(widths.column).toBeGreaterThan(widths.pane - 70);
    await expect(viewer.previewWidthToggle).toHaveCount(0);
  } finally {
    await context.close();
  }
});
