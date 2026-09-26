/**
 * The markdown preview is editable: typing markdown syntax into the rendered
 * preview formats it as you type, and saving writes the edit back as markdown
 * without reformatting the parts of the file the user did not touch.
 *
 * Drives a real Band server against an on-disk worktree. The fixture uses
 * markdown a re-serialiser would normalise (`*` bullets, `__bold__`, a hard
 * break made of trailing spaces, an unaligned table, frontmatter), and the
 * save assertion compares the file bytes on disk exactly.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { gitInHome as git } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { FileViewerPage } from "./pages/FileViewerPage";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-markdown-preview-editing-token";
const PROJECT = "md-editing-repo";
const BRANCH = "main";
const WORKSPACE = toWorkspaceId(PROJECT, BRANCH);

const ORIGINAL = [
  "---",
  "title: Notes",
  "owner: team",
  "---",
  "",
  "# Notes",
  "",
  "* star bullet one",
  "* star bullet two",
  "",
  "Some __underscore bold__ with a hard break  ",
  "on the next line.",
  "",
  "| a | b |",
  "|---|:-:|",
  "| 1   | 2 |",
  "",
  "- [ ] ship it",
  "",
].join("\n");

// A 1x1 PNG, so the image test can check the image actually loaded.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test.use({ viewport: { width: 1280, height: 900 } });

let server: ServerHandle;
let tmpHome: string;
let repo: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  repo = join(tmpHome, PROJECT);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", BRANCH]);
  writeFileSync(join(repo, "EDIT.md"), ORIGINAL);
  writeFileSync(
    join(repo, "FIND.md"),
    "# Find\n\nOne needle here.\n\n| col |\n| --- |\n| needle cell |\n\n",
  );
  mkdirSync(join(repo, "assets"));
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "assets", "logo.png"), PNG_1X1);
  writeFileSync(
    join(repo, "docs", "IMAGES.md"),
    "# Images\n\n![logo](../assets/logo.png)\n\n![escape](%2E%2E/%2E%2E/logo.png)\n",
  );
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

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("typing markdown in the preview formats it and saves it back without touching the rest", async ({
  page,
}) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const viewer = new FileViewerPage(page);
  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();
  await workspacePage.openFileLeaf("EDIT.md");

  // The existing content renders: heading, bullets, bold, and the table and
  // frontmatter as rendered blocks.
  await expect(viewer.previewHeading(1, "Notes")).toBeVisible({ timeout: 20_000 });
  await expect(viewer.previewFormatted("strong", "underscore bold")).toHaveText("underscore bold");
  await expect(viewer.previewFormatted("listitem", "star bullet two")).toBeVisible();
  await expect(viewer.previewTable).toBeVisible();
  await expect(viewer.previewRenderedBlock("frontmatter")).toContainText("owner");

  // Ticking a task rewrites just its `[ ]` marker.
  await viewer.toggleTask("ship it");
  await expect(viewer.taskCheckbox("ship it")).toBeChecked();

  await viewer.focusPreviewEnd();
  await viewer.typeInPreview(
    "\n## Added heading\n\nSome **bold** and `code` text\n\n- first item\nsecond item",
  );

  // Syntax turned into formatting as it was typed; the markers are hidden once
  // the cursor has moved on, so the elements hold just the text.
  await expect(viewer.previewHeading(2, "Added heading")).toBeVisible();
  await expect(viewer.previewFormatted("strong", "bold").last()).toHaveText("bold");
  await expect(viewer.previewFormatted("code", "code")).toHaveText("code");
  await expect(viewer.markdownPreview).not.toContainText("**bold**");
  await expect(viewer.markdownPreview).not.toContainText("`code`");
  // Enter after "- first item" continued the list.
  await expect(viewer.previewFormatted("listitem", "second item")).toBeVisible();

  await viewer.saveWithShortcut();

  const expected = `${ORIGINAL.replace("- [ ] ship it", "- [x] ship it")}\n## Added heading\n\nSome **bold** and \`code\` text\n\n- first item\n- second item`;
  await expect
    .poll(() => readFileSync(join(repo, "EDIT.md"), "utf8"), { timeout: 10_000 })
    .toBe(expected);
});

test("find in the preview counts and steps through matches, including text typed in it", async ({
  page,
}) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const viewer = new FileViewerPage(page);
  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();
  await workspacePage.openFileLeaf("FIND.md");
  await expect(viewer.previewHeading(1, "Find")).toBeVisible({ timeout: 20_000 });

  await viewer.focusPreviewEnd();
  await viewer.typeInPreview("A **needle** in bold");

  await workspacePage.pressFindShortcut();
  const find = viewer.findWidget;
  await expect(find.input).toBeFocused();

  await find.type("needle");
  await expect(find.count).toHaveText("1/3");

  // The table cell's match is counted while the table is rendered, and
  // stepping onto it swaps the table for its source so the match is visible.
  await expect(viewer.previewRenderedBlock("table")).toBeVisible();
  await find.press("Enter");
  await expect(find.count).toHaveText("2/3");
  await expect(viewer.previewRenderedBlock("table")).toHaveCount(0);
  await expect(viewer.markdownPreview).toContainText("| needle cell |");

  // Text typed while the find widget is open is found too.
  await viewer.focusPreviewEnd();
  await viewer.typeInPreview(" and another needle.");
  await find.press("Enter");
  await expect(find.count).toHaveText("3/4");
  await find.press("Enter");
  await expect(find.count).toHaveText("4/4");
  await find.press("Enter");
  await expect(find.count).toHaveText("1/4");
  await find.press("Shift+Enter");
  await expect(find.count).toHaveText("4/4");

  await find.type("not in this file");
  await find.expectNoResults();
});

test("relative images load from the workspace and cannot climb out of it", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const viewer = new FileViewerPage(page);
  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();
  await workspacePage.openFileLeaf("docs/IMAGES.md");
  await expect(viewer.previewHeading(1, "Images")).toBeVisible({ timeout: 20_000 });

  await expect(viewer.previewImage("logo")).toBeVisible();
  await expect.poll(() => viewer.previewImageNaturalWidth("logo")).toBe(1);
  // An encoded `..` that climbs above the workspace root is not turned into a URL.
  await expect(viewer.previewImage("escape")).toHaveCount(0);
});
