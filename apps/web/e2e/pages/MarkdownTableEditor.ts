/**
 * Component object for the editable grids the markdown preview renders in
 * place of a GFM table or the YAML frontmatter (`markdown-table-widget.ts`).
 * Scoped to one rendered block inside a `FileViewerPage`'s preview. The
 * frontmatter grid calls its rows properties, so its row grips and "+" bar
 * are named "Property 1 options" and "Add property".
 *
 * Cells carry `data-testid="markdown-table__cell--r<row>-c<col>"`, where row 0
 * is the header and rows 1.. are body rows. The grips, "+" bars and menu items
 * are located by the ARIA names the widget sets in code.
 */

import { type Download, type Locator, type Page, test } from "@playwright/test";

export class MarkdownTableEditor {
  readonly addRowButton: Locator;
  readonly addColumnButton: Locator;
  /** The open row / column / cell menu. The widget mounts it on the editor
   *  root, outside the table block, so it is looked up on the preview. */
  readonly menu: Locator;

  constructor(
    private readonly page: Page,
    readonly root: Locator,
    preview: Locator,
    private readonly noun: "Row" | "Property" = "Row",
  ) {
    this.addRowButton = root.getByRole("button", { name: `Add ${noun.toLowerCase()}` });
    this.addColumnButton = root.getByRole("button", { name: "Add column" });
    this.menu = preview.getByTestId("markdown-table__menu");
  }

  /** A cell: row 0 is the header row, 1.. the body rows. */
  cell(row: number, col: number): Locator {
    return this.root.getByTestId(`markdown-table__cell--r${row}-c${col}`);
  }

  /** A menu item in the open menu, by its label. */
  menuItem(name: string): Locator {
    return this.menu.getByRole(/^Align/.test(name) ? "menuitemradio" : "menuitem", {
      name,
      exact: true,
    });
  }

  /** Click into a cell, replace its text with `text`, and stay in the cell. */
  async replaceCell(row: number, col: number, text: string): Promise<void> {
    await test.step(`Replace table cell r${row} c${col} with ${JSON.stringify(text)}`, async () => {
      await this.cell(row, col).click();
      await this.page.keyboard.press("ControlOrMeta+a");
      if (text) await this.page.keyboard.type(text);
      else await this.page.keyboard.press("Backspace");
    });
  }

  /** Click into a cell, putting the caret where the click landed. */
  async clickCell(row: number, col: number): Promise<void> {
    await test.step(`Click table cell r${row} c${col}`, async () => {
      await this.cell(row, col).click();
    });
  }

  /** Type into the focused cell. */
  async type(text: string): Promise<void> {
    await test.step(`Type ${JSON.stringify(text)} into the table`, async () => {
      await this.page.keyboard.type(text);
    });
  }

  /** Press a key (or chord) while a cell has focus. */
  async press(key: string): Promise<void> {
    await test.step(`Press ${key} in the table`, async () => {
      await this.page.keyboard.press(key);
    });
  }

  /** A column's grip button (revealed on hover), which opens its menu. */
  columnGrip(col: number): Locator {
    return this.root.getByRole("button", { name: `Column ${col + 1} options` });
  }

  /** The frame's Copy button, which opens the Copy menu. */
  get copyButton(): Locator {
    return this.root.getByRole("button", { name: "Copy table" });
  }

  /** Open the frame's Copy menu without choosing a format. */
  async openCopyMenu(): Promise<void> {
    await test.step("Open the table's Copy menu", async () => {
      await this.copyButton.click();
    });
  }

  /** Hover a column's header and open its grip menu. */
  async openColumnMenu(col: number): Promise<void> {
    await test.step(`Open the menu of column ${col + 1}`, async () => {
      await this.cell(0, col).hover();
      await this.columnGrip(col).click();
    });
  }

  /** Hover a body row and open its grip menu. */
  async openRowMenu(row: number): Promise<void> {
    await test.step(`Open the menu of row ${row}`, async () => {
      await this.cell(row, 0).hover();
      await this.root.getByRole("button", { name: `${this.noun} ${row} options` }).click();
    });
  }

  /** Right-click a cell to open the combined row / column menu. */
  async openCellMenu(row: number, col: number): Promise<void> {
    await test.step(`Right-click table cell r${row} c${col}`, async () => {
      await this.cell(row, col).click({ button: "right" });
    });
  }

  async chooseMenuItem(name: string): Promise<void> {
    await test.step(`Choose "${name}" in the table menu`, async () => {
      await this.menuItem(name).click();
    });
  }

  /** Copy the grid's data from the frame's Copy menu. */
  async copyAs(format: "Markdown" | "CSV" | "TSV"): Promise<void> {
    await test.step(`Copy the table as ${format}`, async () => {
      await this.copyButton.click();
      await this.menuItem(`Copy as ${format}`).click();
    });
  }

  /** Download the grid's data from the frame's Download menu. */
  async downloadAs(format: "CSV" | "Markdown"): Promise<Download> {
    return await test.step(`Download the table as ${format}`, async () => {
      await this.root.getByRole("button", { name: "Download table" }).click();
      const download = this.page.waitForEvent("download");
      await this.menuItem(`Download as ${format}`).click();
      return await download;
    });
  }

  async addRow(): Promise<void> {
    await test.step(`Add a ${this.noun.toLowerCase()} with the bottom + bar`, async () => {
      await this.root.hover();
      await this.addRowButton.click();
    });
  }

  async addColumn(): Promise<void> {
    await test.step("Add a column with the right + bar", async () => {
      await this.root.hover();
      await this.addColumnButton.click();
    });
  }
}
