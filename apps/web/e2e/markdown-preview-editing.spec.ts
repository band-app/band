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
].join("\n");

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
  writeFileSync(join(repo, "FIND.md"), "# Find\n\nOne needle here.\n");
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
  await expect(viewer.previewRenderedBlock("table").getByRole("table")).toBeVisible();
  await expect(viewer.previewRenderedBlock("frontmatter")).toContainText("owner");

  await viewer.focusPreviewEnd();
  await viewer.typeInPreview(
    "\n## Added heading\n\nSome **bold** and `code` text\n\n- first item\nsecond item",
  );

  // Syntax turned into formatting as it was typed; the markers are hidden once
  // the cursor has moved on, so the elements hold just the text.
  await expect(viewer.previewHeading(2, "Added heading")).toBeVisible();
  await expect(viewer.previewFormatted("strong", "bold").last()).toHaveText("bold");
  await expect(viewer.previewFormatted("code", "code")).toHaveText("code");
  // Enter after "- first item" continued the list.
  await expect(viewer.previewFormatted("listitem", "second item")).toBeVisible();

  await viewer.saveWithShortcut();

  const expected = `${ORIGINAL}\n## Added heading\n\nSome **bold** and \`code\` text\n\n- first item\n- second item`;
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
  await viewer.typeInPreview("A **needle** in bold and another needle.");

  await workspacePage.pressFindShortcut();
  const findInput = workspacePage.findInFileOrPreviewBar;
  await expect(findInput).toBeFocused();
  await expect(findInput).toHaveAttribute("placeholder", "Find in preview...");

  const counter = workspacePage.findMatchCount;
  await findInput.fill("needle");
  await expect(counter).toHaveText("1 of 3");
  await findInput.press("Enter");
  await expect(counter).toHaveText("2 of 3");
  await findInput.press("Enter");
  await expect(counter).toHaveText("3 of 3");
  await findInput.press("Shift+Enter");
  await expect(counter).toHaveText("2 of 3");

  await findInput.fill("not in this file");
  await expect(counter).toHaveText("No results");
});
