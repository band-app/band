/**
 * Page object for the sidebar's Repos panel (`ReposPanel.tsx`): the repos below the projects, in
 * a panel that collapses to its header and resizes from its top edge. Test bodies call only the
 * methods here.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class ReposPanelPage {
  readonly panel: Locator;
  readonly toggle: Locator;
  readonly list: Locator;
  private readonly resizeHandle: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.panel = page.getByTestId("repos-panel");
    this.toggle = page.getByTestId("repos-panel__toggle");
    this.list = page.getByTestId("repos-panel__list");
    this.resizeHandle = page.getByTestId("repos-panel__resize");
  }

  /** Loads the app at `/` and waits for the panel. */
  async goto(): Promise<void> {
    await test.step("Open the app at /", async () => {
      await this.page.goto(`${this.baseUrl}/?token=${this.token}`);
      await expect(this.toggle).toBeVisible();
    });
  }

  /** Reloads the page, keeping `localStorage` and the server's client state. */
  async reload(): Promise<void> {
    await test.step("Reload", async () => {
      await this.page.reload();
      await expect(this.toggle).toBeVisible();
    });
  }

  /** Clicks the header to collapse or expand the panel. */
  async toggleCollapsed(): Promise<void> {
    await this.toggle.click();
  }

  /** The number of repos the header shows. */
  count(): Locator {
    return this.panel.getByTestId("repos-panel__count");
  }

  /** The list's rendered height in pixels. */
  async listHeight(): Promise<number> {
    const box = await this.list.boundingBox();
    if (!box) throw new Error("The repos list is not rendered");
    return box.height;
  }

  /** Drags the panel's top edge by `dy` pixels (negative is up, which makes the panel taller). */
  async dragTopEdge(dy: number): Promise<void> {
    await test.step(`Drag the Repos panel's top edge by ${dy}px`, async () => {
      const box = await this.resizeHandle.boundingBox();
      if (!box) throw new Error("The resize handle is not rendered");
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await this.page.mouse.move(x, y);
      await this.page.mouse.down();
      await this.page.mouse.move(x, y + dy, { steps: 5 });
      await this.page.mouse.up();
    });
  }
}
