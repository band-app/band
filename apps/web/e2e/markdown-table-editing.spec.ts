/**
 * Tables in the markdown preview are edited in place: cell text, rows,
 * columns and alignment change through the rendered grid, and saving writes
 * GFM table markdown that keeps the bytes of every cell the user did not
 * touch (padding, pipe style, alignment markers).
 *
 * Drives a real Band server against an on-disk worktree; each test edits its
 * own file and compares the saved bytes exactly.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { git } from "./helpers/git";
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

const TOKEN = "e2e-markdown-table-editing-token";
const PROJECT = "md-table-repo";
const BRANCH = "main";
const WORKSPACE = toWorkspaceId(PROJECT, BRANCH);

// Uneven padding and a centred column, so a re-serialiser would show up in
// the saved bytes.
const TABLE = ["| Name | Role |", "|------|:----:|", "| Ada   | **eng** |", "| Bob | pm |"];
const FILE = (table: string[]) => ["# Team", "", ...table, "", "After.", ""].join("\n");

const FILES = ["CELLS.md", "KEYS.md", "STRUCTURE.md"];

test.use({ viewport: { width: 1280, height: 900 } });

let server: ServerHandle;
let tmpHome: string;
let repo: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  repo = join(tmpHome, PROJECT);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", BRANCH]);
  for (const name of FILES) writeFileSync(join(repo, name), FILE(TABLE));
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

async function openTable(page: import("@playwright/test").Page, file: string) {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const viewer = new FileViewerPage(page);
  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();
  await workspacePage.openFileLeaf(file);
  await expect(viewer.previewHeading(1, "Team")).toBeVisible({ timeout: 20_000 });
  const table = viewer.previewTableEditor();
  await expect(table.cell(0, 0)).toHaveText("Name");
  return { viewer, table };
}

function readFile(name: string): string {
  return readFileSync(join(repo, name), "utf8");
}

test("editing cell text in place rewrites only those cells, and undo goes through the editor", async ({
  page,
}) => {
  const { viewer, table } = await openTable(page, "CELLS.md");

  // Cells render their inline markdown until they are edited.
  await expect(table.cell(1, 1).getByRole("strong")).toHaveText("eng");

  await table.replaceCell(1, 0, "Grace");
  // A pipe typed into a cell is escaped so it does not split the cell.
  await table.replaceCell(2, 1, "a|b");
  await expect(table.cell(1, 0)).toHaveText("Grace");

  // Undo and redo from inside the cell use the editor's history.
  await table.press("ControlOrMeta+z");
  await expect(table.cell(2, 1)).toHaveText("pm");
  await table.press("ControlOrMeta+Shift+z");
  await expect(table.cell(2, 1)).toHaveText("a\\|b");

  // The table stayed rendered the whole time; the source never showed.
  await expect(viewer.markdownPreview).not.toContainText("|------|");

  await viewer.saveWithShortcut();
  await expect
    .poll(() => readFile("CELLS.md"), { timeout: 10_000 })
    .toBe(FILE(["| Name | Role |", "|------|:----:|", "| Grace   | **eng** |", "| Bob | a\\|b |"]));
});

test("Tab and Enter move between cells and add rows at the end, Escape leaves the table", async ({
  page,
}) => {
  const { viewer, table } = await openTable(page, "KEYS.md");

  await table.clickCell(2, 1);
  // Tab on the last cell adds a row and moves to its first cell.
  await table.press("Tab");
  await expect(table.cell(3, 0)).toBeFocused();
  await table.type("Cy");
  await table.press("Tab");
  await expect(table.cell(3, 1)).toBeFocused();
  await table.type("qa");
  // Enter on the last row adds a row below, in the same column.
  await table.press("Enter");
  await expect(table.cell(4, 1)).toBeFocused();
  await table.type("ops");
  // Shift+Tab walks back; Shift+Enter moves up.
  await table.press("Shift+Tab");
  await expect(table.cell(4, 0)).toBeFocused();
  await table.press("Shift+Enter");
  await expect(table.cell(3, 0)).toBeFocused();
  await expect(table.cell(4, 1)).toHaveText("ops");

  // Escape puts the editor cursor on the next block, so typing there does
  // not turn into a table row.
  await table.press("Escape");
  await viewer.typeInPreview("Tail ");
  await expect(viewer.previewRenderedBlock("table")).toBeVisible();

  await viewer.saveWithShortcut();
  await expect
    .poll(() => readFile("KEYS.md"), { timeout: 10_000 })
    .toBe(["# Team", "", ...TABLE, "| Cy | qa |", "|  | ops |", "", "Tail After.", ""].join("\n"));
});

test("row and column menus insert, delete and align, and the cell menu shows the source", async ({
  page,
}) => {
  const { viewer, table } = await openTable(page, "STRUCTURE.md");

  await table.openColumnMenu(1);
  await table.chooseMenuItem("Insert column right");
  await expect(table.cell(0, 2)).toBeFocused();
  await table.type("Team");

  await table.openColumnMenu(2);
  await expect(table.menuItem("Align right")).toHaveAttribute("aria-checked", "false");
  await table.chooseMenuItem("Align right");
  await expect(table.cell(0, 2)).toHaveCSS("text-align", "right");

  await table.openRowMenu(1);
  await table.chooseMenuItem("Delete row");
  await expect(table.cell(1, 0)).toHaveText("Bob");

  await table.addRow();
  await expect(table.cell(2, 0)).toBeFocused();
  await table.type("Dee");

  await table.addColumn();
  await expect(table.cell(0, 3)).toBeFocused();
  await table.openColumnMenu(3);
  await table.chooseMenuItem("Delete column");
  await expect(table.cell(0, 3)).toHaveCount(0);
  await expect(table.cell(0, 2)).toHaveText("Team");

  // "Edit as markdown" swaps the grid for the table's source.
  await table.openCellMenu(1, 0);
  await table.chooseMenuItem("Edit as markdown");
  await expect(viewer.previewRenderedBlock("table")).toHaveCount(0);
  await expect(viewer.markdownPreview).toContainText("|------|:----:|---:|");

  await viewer.saveWithShortcut();
  await expect
    .poll(() => readFile("STRUCTURE.md"), { timeout: 10_000 })
    .toBe(
      FILE(["| Name | Role | Team |", "|------|:----:|---:|", "| Bob | pm |  |", "| Dee |  |  |"]),
    );
});
