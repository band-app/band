/**
 * A click on text in the markdown preview puts the cursor on the clicked line,
 * also below rendered blocks (frontmatter, tables, mermaid). CodeMirror maps a
 * click to a line from its height map, which ignores CSS margins, so a margin
 * on a block widget shifts every click below it.
 *
 * Each test clicks the middle of a line, types a marker, saves, and reads the
 * file from disk to see which line the marker landed in.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
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

const TOKEN = "e2e-markdown-click-position-token";
const REPO = "md-click-repo";
const BRANCH = "main";
const WORKTREE = toWorktreeId(REPO, BRANCH, "local");
const MARKER = "@@";

const TABLE = ["| a | b |", "|---|---|", "| 1 | 2 |"];

const SHORT = [
  "---",
  "title: Notes",
  "owner: team",
  "---",
  "",
  "# Intro",
  "",
  ...TABLE,
  "",
  "```mermaid",
  "graph TD",
  "  A-->B",
  "```",
  "",
  "## How flows ship today",
  "",
  "- first list item here",
  "- second list item here",
  "",
  "A closing paragraph below the blocks.",
  "",
].join("\n");

const LONG = [
  "# Long",
  "",
  ...Array.from({ length: 8 }, (_, i) => [
    `## Section ${i}`,
    "",
    ...TABLE,
    "",
    `Filler paragraph ${i}.`,
    "",
  ]).flat(),
  "## Last heading here",
  "",
].join("\n");

test.use({ viewport: { width: 1280, height: 900 } });

let server: ServerHandle;
let tmpHome: string;
let repo: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  repo = join(tmpHome, REPO);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", BRANCH]);
  writeFileSync(join(repo, "SHORT.md"), SHORT);
  writeFileSync(join(repo, "LONG.md"), LONG);
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

/** The lines of `file` after typing the marker where the click landed. */
async function clickAndType(page: Page, file: string, lineText: string): Promise<string[]> {
  // Each test saves into the file, so start from the original.
  writeFileSync(join(repo, file), file === "LONG.md" ? LONG : SHORT);
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const viewer = new FileViewerPage(page);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();
  await worktreePage.openFileLeaf(file);
  await expect(viewer.previewHeading(1, file === "LONG.md" ? "Long" : "Intro")).toBeVisible({
    timeout: 20_000,
  });
  await viewer.waitForMermaidDrawn();
  await viewer.clickPreviewLine(lineText);
  await viewer.typeInPreview(MARKER);
  await viewer.saveWithShortcut();
  await expect
    .poll(() => readFileSync(join(repo, file), "utf8").includes(MARKER), { timeout: 10_000 })
    .toBe(true);
  return readFileSync(join(repo, file), "utf8").split("\n");
}

function expectMarkerOn(lines: string[], text: string): void {
  const marked = lines.filter((l) => l.includes(MARKER));
  expect(marked).toHaveLength(1);
  expect(marked[0]).toContain(text);
}

test("a click on a heading below frontmatter, a table and a diagram lands on that heading", async ({
  page,
}) => {
  const lines = await clickAndType(page, "SHORT.md", "How flows ship today");
  expectMarkerOn(lines, "How flows ship today");
});

test("a click on a list item below the blocks lands on it", async ({ page }) => {
  const lines = await clickAndType(page, "SHORT.md", "second list item here");
  expectMarkerOn(lines, "second list item here");
});

test("a click on a paragraph below the blocks lands on it", async ({ page }) => {
  const lines = await clickAndType(page, "SHORT.md", "A closing paragraph");
  expectMarkerOn(lines, "A closing paragraph");
});

test("a click on the last heading of a long file with many tables lands on it", async ({
  page,
}) => {
  const lines = await clickAndType(page, "LONG.md", "Last heading here");
  expectMarkerOn(lines, "Last heading here");
});
