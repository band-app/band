/**
 * Page object for quick commands: the tab bar's Quick commands menu, the Add/Edit dialog, a
 * terminal's right-click Quick Commands submenu and Settings > Quick commands.
 *
 * Locators use the `quick-commands__*`, `quick-command-dialog__*`, `settings-quick-commands__*` and
 * `selection-menu__quick-command*` test ids set in `QuickCommandsMenu.tsx`, `QuickCommandDialog.tsx`,
 * `QuickCommandsSettings.tsx` and `SelectionContextMenu.tsx`. Form fields use their accessible names.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { SettingsPage } from "./SettingsPage";

export class QuickCommandsPage {
  readonly settings: SettingsPage;
  readonly button: Locator;
  readonly menu: Locator;
  readonly menuItems: Locator;
  readonly dialog: Locator;
  readonly saveButton: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.settings = new SettingsPage(page, baseUrl, token);
    this.button = page.getByTestId("quick-commands__button").filter({ visible: true }).first();
    this.menu = page.getByTestId("quick-commands__menu");
    this.menuItems = this.menu.getByTestId("quick-commands__item");
    this.dialog = page.getByTestId("quick-command-dialog");
    this.saveButton = page.getByTestId("quick-command-dialog__save");
  }

  async goto(worktreeId: string): Promise<void> {
    await test.step(`Open worktree ${worktreeId}`, async () => {
      await this.page.goto(
        `${this.baseUrl}/worktree/${encodeURIComponent(worktreeId)}?token=${this.token}`,
      );
      await this.button.waitFor({ state: "visible", timeout: 20_000 });
    });
  }

  /** Right edge of the quick-commands button and of every other header button in its group header. */
  async headerButtonEdges(): Promise<{ quick: number; others: number[] }> {
    const toolbar = this.page
      .getByTestId("worktree-center__toolbar")
      .filter({ visible: true })
      .first();
    const edge = async (l: Locator) => {
      const box = await l.boundingBox();
      if (!box) throw new Error("button has no box");
      return box.x + box.width;
    };
    const quick = await edge(this.button);
    const buttons = await toolbar.getByRole("button").all();
    const others: number[] = [];
    for (const b of buttons) {
      if ((await b.getAttribute("data-testid")) === "quick-commands__button") continue;
      others.push(await edge(b));
    }
    return { quick, others };
  }

  /** Open the Edit dialog with the keyboard: focus the row, press ArrowRight. */
  async editWithKeyboard(label: string): Promise<void> {
    await test.step(`Open the Edit dialog for ${label} with ArrowRight`, async () => {
      await this.openMenu();
      await this.menuItem(label).focus();
      await this.page.keyboard.press("ArrowRight");
      await expect(this.dialog).toBeVisible();
    });
  }

  /** Left edge of the quick-commands button. */
  async buttonX(): Promise<number> {
    const box = await this.button.boundingBox();
    if (!box) throw new Error("button has no box");
    return box.x;
  }

  /** Open a new terminal tab from the "+" menu. */
  async openTerminalTab(): Promise<void> {
    await test.step("Open a terminal tab from +", async () => {
      await this.page
        .getByTestId("worktree-center__new-tab-button")
        .filter({ visible: true })
        .first()
        .click();
      await this.page.getByTestId("worktree-center__new-tab--term").click();
    });
  }

  async newTabButtonRightEdge(): Promise<number> {
    const box = await this.page
      .getByTestId("worktree-center__new-tab-button")
      .filter({ visible: true })
      .first()
      .boundingBox();
    if (!box) throw new Error("new-tab button has no box");
    return box.x + box.width;
  }

  async openMenu(): Promise<void> {
    await test.step("Open the Quick commands menu", async () => {
      await this.button.click();
      await expect(this.menu).toBeVisible();
    });
  }

  async closeMenu(): Promise<void> {
    await this.page.keyboard.press("Escape");
    await expect(this.menu).toBeHidden();
  }

  async screenshot(): Promise<Buffer> {
    return await this.page.screenshot();
  }

  menuItem(label: string): Locator {
    return this.menuItems.filter({ hasText: label });
  }

  async pick(label: string): Promise<void> {
    await test.step(`Run quick command ${label} from the menu`, async () => {
      await this.openMenu();
      await this.menuItem(label).click();
    });
  }

  async openAddDialogFromMenu(): Promise<void> {
    await test.step("Open the Add Quick Command dialog from the menu", async () => {
      await this.openMenu();
      await this.menu.getByTestId("quick-commands__add").click();
      await expect(this.dialog).toBeVisible();
    });
  }

  async editFromMenu(label: string): Promise<void> {
    await test.step(`Open the Edit dialog for ${label} from the menu`, async () => {
      await this.openMenu();
      await this.menuItem(label).getByTestId("quick-commands__edit").click();
      await expect(this.dialog).toBeVisible();
    });
  }

  actionToggle(name: "Terminal" | "Agent"): Locator {
    return this.dialog.getByRole("radio", { name });
  }

  async fillTerminalCommand(opts: {
    label: string;
    command: string;
    appendEnter: boolean;
  }): Promise<void> {
    await test.step(`Fill the dialog for ${opts.label}`, async () => {
      await this.dialog.getByTestId("quick-command-dialog__label").fill(opts.label);
      await this.dialog.getByTestId("quick-command-dialog__body").fill(opts.command);
      const enter = this.dialog.getByTestId("quick-command-dialog__append-enter");
      if ((await enter.getAttribute("aria-checked")) !== String(opts.appendEnter)) {
        await enter.click();
      }
    });
  }

  async fillAgentCommand(opts: { label: string; prompt: string; agent: string }): Promise<void> {
    await test.step(`Fill the dialog for agent command ${opts.label}`, async () => {
      await this.dialog.getByRole("radio", { name: "Agent" }).click();
      await this.dialog.getByTestId("quick-command-dialog__label").fill(opts.label);
      await this.dialog.getByTestId("quick-command-dialog__body").fill(opts.prompt);
      await this.dialog.getByTestId("quick-command-dialog__agent").click();
      await this.page.getByRole("option", { name: opts.agent }).click();
    });
  }

  advancedSummary(): Locator {
    return this.dialog.getByTestId("quick-command-dialog__advanced");
  }

  async save(withKeyboard = false): Promise<void> {
    await test.step("Save the quick command", async () => {
      if (withKeyboard) await this.page.keyboard.press("ControlOrMeta+Enter");
      else await this.saveButton.click();
      await expect(this.dialog).toBeHidden();
    });
  }

  /** Every terminal's visible screen text, joined. */
  async terminalScreens(): Promise<string> {
    return await this.page.evaluate(() => {
      type Term = {
        buffer: {
          active: {
            viewportY: number;
            getLine(y: number): { translateToString(trim: boolean): string } | undefined;
          };
        };
        rows: number;
      };
      const cache = (
        globalThis as unknown as {
          __bandTerminalCache__?: Map<string, { getTerminal(): unknown }>;
        }
      ).__bandTerminalCache__;
      const out: string[] = [];
      for (const entry of cache?.values() ?? []) {
        const term = entry.getTerminal() as Term | null;
        if (!term) continue;
        for (let y = 0; y < term.rows; y++) {
          out.push(
            term.buffer.active.getLine(term.buffer.active.viewportY + y)?.translateToString(true) ??
              "",
          );
        }
      }
      return out.join("\n");
    });
  }

  /** Right-clicks the visible terminal and opens its Quick Commands submenu. */
  async openTerminalSubmenu(): Promise<void> {
    await test.step("Open the terminal's Quick Commands submenu", async () => {
      await this.page
        .getByTestId("terminal-wrapper")
        .filter({ visible: true })
        .first()
        .click({ button: "right" });
      await this.page.getByTestId("selection-menu__quick-commands").hover();
      await expect(this.page.getByTestId("selection-menu__quick-commands-list")).toBeVisible();
    });
  }

  terminalSubmenuItem(label: string): Locator {
    return this.page.getByTestId("selection-menu__quick-command").filter({ hasText: label });
  }

  // ---- Settings > Quick commands ----

  async openSettings(): Promise<void> {
    await this.settings.goto();
    await this.settings.openDialog("quick-commands");
  }

  settingsRows(): Locator {
    return this.page.getByTestId("settings-quick-commands__row");
  }

  settingsRow(label: string): Locator {
    return this.settingsRows().filter({ hasText: label });
  }

  async searchSettings(query: string): Promise<void> {
    await this.page.getByTestId("settings-quick-commands__search").fill(query);
  }

  async editFromSettings(label: string, newLabel: string): Promise<void> {
    await this.settingsRow(label).getByTestId("settings-quick-commands__edit").click();
    await expect(this.dialog).toBeVisible();
    await this.dialog.getByTestId("quick-command-dialog__label").fill(newLabel);
    await this.save();
  }

  async deleteFromSettings(label: string): Promise<void> {
    await this.settingsRow(label).getByTestId("settings-quick-commands__delete").click();
    await this.page.getByTestId("quick-command-delete-dialog__confirm").click();
  }
}
