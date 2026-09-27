/**
 * Component object for the editable table the markdown preview renders in
 * place of a GFM table (`markdown-table-widget.ts`). Scoped to one rendered
 * table block inside a `FileViewerPage`'s preview.
 *
 * Cells carry `data-testid="markdown-table__cell--r<row>-c<col>"`, where row 0
 * is the header and rows 1.. are body rows. The grips, "+" bars and menu items
 * are located by the ARIA names the widget sets in code.
 */

import { type Locator, type Page, test } from "@playwright/test";

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
  ) {
    this.addRowButton = root.getByRole("button", { name: "Add row" });
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

  /** Hover a column's header and open its grip menu. */
  async openColumnMenu(col: number): Promise<void> {
    await test.step(`Open the menu of column ${col + 1}`, async () => {
      await this.cell(0, col).hover();
      await this.root.getByRole("button", { name: `Column ${col + 1} options` }).click();
    });
  }

  /** Hover a body row and open its grip menu. */
  async openRowMenu(row: number): Promise<void> {
    await test.step(`Open the menu of row ${row}`, async () => {
      await this.cell(row, 0).hover();
      await this.root.getByRole("button", { name: `Row ${row} options` }).click();
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

  async addRow(): Promise<void> {
    await test.step("Add a row with the bottom + bar", async () => {
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
