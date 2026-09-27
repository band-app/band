/**
 * Tables in the markdown preview are edited in place: cell text, rows,
 * columns and alignment change through the rendered grid, and saving writes
 * GFM table markdown that keeps the bytes of every cell the user did not
 * touch (padding, pipe style, alignment markers). The YAML frontmatter is a
 * Key / Value grid edited the same way, and each grid's frame copies and
 * downloads its data.
 *
 * Drives a real Band server against an on-disk worktree; each test edits its
 * own file and compares the saved bytes exactly.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
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

const FILES = ["CELLS.md", "KEYS.md", "STRUCTURE.md", "EXPORT.md"];
// A trailing comment, double- and single-quoted values, and a list and a
// block scalar, which span lines and stay read-only.
const FRONTMATTER = [
  "---",
  "title: Notes # draft",
  'owner: "team a"',
  "summary: 'it''s'",
  "tags:",
  "  - one",
  "  - two",
  "notes: |",
  "  line one",
  "  line two",
  "---",
];
const FRONTMATTER_FILE = (fm: string[]) => [...fm, "", "# Team", ""].join("\n");

// No padding around the cells, so nothing separates cell text from its pipe.
const COMPACT = ["|Name|Role|", "|-|-|", "|Ada|eng|"];

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
  writeFileSync(join(repo, "COMPACT.md"), FILE(COMPACT));
  for (const name of ["FRONTMATTER.md", "METADATA.md"]) {
    writeFileSync(join(repo, name), FRONTMATTER_FILE(FRONTMATTER));
  }
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

/** Open a fixture file in the preview; every fixture has a "Team" heading. */
async function openFile(page: Page, file: string) {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const viewer = new FileViewerPage(page);
  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();
  await workspacePage.openFileLeaf(file);
  await expect(viewer.previewHeading(1, "Team")).toBeVisible({ timeout: 20_000 });
  return { viewer };
}

async function openTable(page: Page, file: string) {
  const { viewer } = await openFile(page, file);
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
  // One undo takes back one cell's typing, not the earlier cell's.
  await expect(table.cell(1, 0)).toHaveText("Grace");
  await table.press("ControlOrMeta+Shift+z");
  await expect(table.cell(2, 1)).toHaveText("a\\|b");

  // The table stayed rendered the whole time; the source never showed.
  await expect(viewer.markdownPreview).not.toContainText("|------|");

  await viewer.saveWithShortcut();
  await expect
    .poll(() => readFile("CELLS.md"), { timeout: 10_000 })
    .toBe(FILE(["| Name | Role |", "|------|:----:|", "| Grace   | **eng** |", "| Bob | a\\|b |"]));
});

test("a cell ending in a backslash does not escape the pipe that closes it", async ({ page }) => {
  const { viewer, table } = await openTable(page, "COMPACT.md");

  await table.replaceCell(1, 0, "C:\\");
  await expect(table.cell(1, 1)).toHaveText("eng");

  await viewer.saveWithShortcut();
  await expect
    .poll(() => readFile("COMPACT.md"), { timeout: 10_000 })
    .toBe(FILE(["|Name|Role|", "|-|-|", "|C:\\ |eng|"]));
});

test("keyboard moves between cells, adds rows at the end and leaves the table", async ({
  page,
}) => {
  const { viewer, table } = await openTable(page, "KEYS.md");

  await table.clickCell(2, 1);
  // Tab on the last cell adds a row and moves to its first cell.
  await table.press("Tab");
  await expect(table.cell(3, 0)).toBeFocused();
  await table.type("Cy");
  // ArrowRight at the end of a cell moves to the next one.
  await table.press("ArrowRight");
  await expect(table.cell(3, 1)).toBeFocused();
  await table.type("qa");
  // Enter on the last row adds a row below, in the same column.
  await table.press("Enter");
  await expect(table.cell(4, 1)).toBeFocused();
  await table.type("ops");
  // Shift+Tab walks back; Shift+Enter and ArrowUp move up.
  await table.press("Shift+Tab");
  await expect(table.cell(4, 0)).toBeFocused();
  await table.press("Shift+Enter");
  await expect(table.cell(3, 0)).toBeFocused();
  await table.press("ArrowUp");
  await expect(table.cell(2, 0)).toBeFocused();
  await table.press("ArrowDown");
  await table.press("ArrowDown");
  await expect(table.cell(4, 0)).toBeFocused();
  await expect(table.cell(4, 1)).toHaveText("ops");

  // ArrowDown on the last row leaves the table for the next block, so
  // typing there does not turn into a table row.
  await table.press("ArrowDown");
  await viewer.typeInPreview("Tail ");
  // ArrowUp in the header leaves it for the block above.
  await table.clickCell(0, 0);
  await table.press("ArrowUp");
  await viewer.typeInPreview("!");
  // Escape leaves for the block below.
  await table.clickCell(1, 0);
  await table.press("Escape");
  await viewer.typeInPreview("More ");
  await expect(viewer.previewRenderedBlock("table")).toBeVisible();

  await viewer.saveWithShortcut();
  await expect
    .poll(() => readFile("KEYS.md"), { timeout: 10_000 })
    .toBe(
      ["# Team!", "", ...TABLE, "| Cy | qa |", "|  | ops |", "", "More Tail After.", ""].join("\n"),
    );
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

  await table.openRowMenu(2);
  await table.chooseMenuItem("Insert row above");
  await expect(table.cell(2, 0)).toBeFocused();
  await table.type("Cat");
  await expect(table.cell(3, 0)).toHaveText("Dee");

  await table.openColumnMenu(0);
  await table.chooseMenuItem("Insert column left");
  await expect(table.cell(0, 0)).toBeFocused();
  await table.type("No");
  await expect(table.cell(0, 1)).toHaveText("Name");

  // "Edit as markdown" swaps the grid for the table's source.
  await table.openCellMenu(1, 1);
  await table.chooseMenuItem("Edit as markdown");
  await expect(viewer.previewRenderedBlock("table")).toHaveCount(0);
  await expect(viewer.markdownPreview).toContainText("|---|------|:----:|---:|");

  await viewer.saveWithShortcut();
  await expect
    .poll(() => readFile("STRUCTURE.md"), { timeout: 10_000 })
    .toBe(
      FILE([
        "| No | Name | Role | Team |",
        "|---|------|:----:|---:|",
        "|  | Bob | pm |  |",
        "|  | Cat |  |  |",
        "|  | Dee |  |  |",
      ]),
    );
});

test.describe("frame toolbar", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("the table frame copies the data as Markdown, CSV and TSV and downloads it", async ({
    page,
  }) => {
    const { viewer, table } = await openTable(page, "EXPORT.md");

    await table.copyAs("Markdown");
    await expect.poll(() => viewer.readClipboard()).toBe(TABLE.join("\n"));
    // CSV and TSV hold the cells' text, formatting markers stripped.
    await table.copyAs("CSV");
    await expect.poll(() => viewer.readClipboard()).toBe("Name,Role\nAda,eng\nBob,pm");
    await table.copyAs("TSV");
    await expect.poll(() => viewer.readClipboard()).toBe("Name\tRole\nAda\teng\nBob\tpm");

    const csv = await table.downloadAs("CSV");
    expect(csv.suggestedFilename()).toBe("table.csv");
    expect(readFileSync(await csv.path(), "utf8")).toBe("Name,Role\nAda,eng\nBob,pm");
    const md = await table.downloadAs("Markdown");
    expect(md.suggestedFilename()).toBe("table.md");
    expect(readFileSync(await md.path(), "utf8")).toBe(TABLE.join("\n"));

    // The toolbar never switched the table to its source.
    await expect(viewer.previewRenderedBlock("table")).toBeVisible();
    expect(readFile("EXPORT.md")).toBe(FILE(TABLE));
  });

  test("the frontmatter frame exports its keys and shown values", async ({ page }) => {
    const { viewer } = await openFile(page, "METADATA.md");
    const fm = viewer.previewFrontmatterEditor();
    await expect(fm.cell(1, 0)).toHaveText("title");
    const csv = [
      "Key,Value",
      "title,Notes",
      "owner,team a",
      "summary,it's",
      'tags,"one, two"',
      "notes,line one line two",
    ].join("\n");

    await fm.copyAs("Markdown");
    await expect
      .poll(() => viewer.readClipboard())
      .toBe(
        [
          "| Key | Value |",
          "| --- | --- |",
          "| title | Notes |",
          "| owner | team a |",
          "| summary | it's |",
          "| tags | one, two |",
          "| notes | line one line two |",
        ].join("\n"),
      );
    await fm.copyAs("CSV");
    await expect.poll(() => viewer.readClipboard()).toBe(csv);

    const download = await fm.downloadAs("CSV");
    expect(download.suggestedFilename()).toBe("frontmatter.csv");
    expect(readFileSync(await download.path(), "utf8")).toBe(csv);
    expect(readFile("METADATA.md")).toBe(FRONTMATTER_FILE(FRONTMATTER));
  });
});

test("frontmatter is a Key / Value grid edited in place, keeping quoting and comments", async ({
  page,
}) => {
  const { viewer } = await openFile(page, "FRONTMATTER.md");
  const fm = viewer.previewFrontmatterEditor();
  await expect(fm.cell(1, 0)).toHaveText("title");

  // The comment and the quotes are not part of the shown values.
  await expect(fm.cell(1, 1)).toHaveText("Notes");
  await expect(fm.cell(2, 1)).toHaveText("team a");
  await expect(fm.cell(3, 1)).toHaveText("it's");
  // Values that span lines show their content and are edited as markdown.
  await expect(fm.cell(4, 1)).toHaveText("one, two");
  await expect(fm.cell(4, 1)).not.toHaveRole("textbox");
  await expect(fm.cell(5, 1)).toHaveText("line one line two");
  await expect(fm.cell(5, 1)).not.toHaveRole("textbox");

  await fm.replaceCell(1, 1, "Plans");
  await fm.replaceCell(2, 1, "team b");
  await fm.replaceCell(2, 0, "team");
  await fm.replaceCell(3, 1, "it's done");
  // A key another property uses is marked and not written.
  await fm.replaceCell(3, 0, "title");
  await expect(fm.cell(3, 0)).toHaveAttribute("aria-invalid", "true");
  await fm.replaceCell(3, 0, "summary");
  await expect(fm.cell(3, 0)).not.toHaveAttribute("aria-invalid");

  // Tab skips the read-only value and, past the last cell, adds a property
  // with its placeholder key selected.
  await fm.clickCell(5, 0);
  await fm.press("Tab");
  await expect(fm.cell(6, 0)).toBeFocused();
  // A key the frontmatter cannot hold is marked and not written: the file
  // keeps the last valid key, here the placeholder.
  await fm.type("#draft");
  await expect(fm.cell(6, 0)).toHaveAttribute("aria-invalid", "true");
  await viewer.saveWithShortcut();
  await expect
    .poll(() => readFile("FRONTMATTER.md"), { timeout: 10_000 })
    .toBe(
      FRONTMATTER_FILE([
        "---",
        "title: Plans # draft",
        'team: "team b"',
        "summary: 'it''s done'",
        "tags:",
        "  - one",
        "  - two",
        "notes: |",
        "  line one",
        "  line two",
        "key:",
        "---",
      ]),
    );

  await fm.press("ControlOrMeta+a");
  await fm.type("status");
  await expect(fm.cell(6, 0)).not.toHaveAttribute("aria-invalid");
  await fm.press("Tab");
  await expect(fm.cell(6, 1)).toBeFocused();
  await fm.type("draft");

  // Deleting a property removes its continuation lines too.
  await fm.openRowMenu(4);
  await fm.chooseMenuItem("Delete property");
  await expect(fm.cell(4, 0)).toHaveText("notes");

  await viewer.saveWithShortcut();
  await expect
    .poll(() => readFile("FRONTMATTER.md"), { timeout: 10_000 })
    .toBe(
      FRONTMATTER_FILE([
        "---",
        "title: Plans # draft",
        'team: "team b"',
        "summary: 'it''s done'",
        "notes: |",
        "  line one",
        "  line two",
        "status: draft",
        "---",
      ]),
    );
});
