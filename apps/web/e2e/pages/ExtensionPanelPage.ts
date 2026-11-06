/**
 * Page object for an extension's worktree panel (`ExtensionPanel`): the "+" menu entry, the tab,
 * the sandboxed frame and the fixture page inside it (frame counter, mode, call result, echoes),
 * and Band's own Take control button. The frame has an opaque origin, so everything inside it is
 * reached through `frameLocator`.
 */

import { expect, type FrameLocator, type Locator, type Page, test } from "@playwright/test";
import { ChatPanePage } from "./ChatPanePage";

export class ExtensionPanelPage {
  readonly chat: ChatPanePage;
  readonly newTabButton: Locator;
  readonly menuItem: Locator;
  readonly tab: Locator;
  readonly panel: Locator;
  readonly controlButton: Locator;
  readonly mode: Locator;

  constructor(
    private readonly page: Page,
    baseUrl: string,
    token: string,
    extensionId: string,
    panelId: string,
  ) {
    this.chat = new ChatPanePage(page, baseUrl, token);
    this.newTabButton = page.getByTestId("worktree-center__new-tab-button");
    this.menuItem = page.getByTestId(`worktree-center__new-tab--ext-${extensionId}-${panelId}`);
    this.tab = page.getByTestId(`center-plugin-tab--ext:${extensionId}-${panelId}`);
    this.panel = page.getByTestId("extension-panel");
    this.controlButton = page.getByTestId("extension-panel__control");
    this.mode = page.getByTestId("extension-panel__mode");
  }

  private get frame(): FrameLocator {
    return this.panel.frameLocator('[data-testid="extension-panel__frame"]');
  }

  get frames(): Locator {
    return this.frame.locator("#frames");
  }

  get pageMode(): Locator {
    return this.frame.locator("#mode");
  }

  get callResult(): Locator {
    return this.frame.locator("#call");
  }

  get echoes(): Locator {
    return this.frame.locator("#echoes li");
  }

  get sendButton(): Locator {
    return this.frame.getByRole("button", { name: "Send input" });
  }

  async open(worktreeId: string): Promise<void> {
    await test.step(`Open worktree ${worktreeId}`, async () => {
      await this.chat.goto(worktreeId);
      await this.chat.waitForReady();
    });
  }

  async openNewTabMenu(): Promise<void> {
    await test.step("Open the new-tab menu", async () => {
      await this.newTabButton.first().click();
      await expect(this.page.getByTestId("worktree-center__new-tab-menu")).toBeVisible();
    });
  }

  async openFromMenu(): Promise<void> {
    await test.step("Open the panel from the + menu", async () => {
      await this.openNewTabMenu();
      await this.menuItem.click();
      await expect(this.tab).toBeVisible();
      await expect(this.panel).toHaveAttribute("data-ready", "true");
    });
  }

  async takeControl(): Promise<void> {
    await test.step("Take control", async () => {
      await this.controlButton.click();
      await expect(this.panel).toHaveAttribute("data-control", "true");
    });
  }
}
