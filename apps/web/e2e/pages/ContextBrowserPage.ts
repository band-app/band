/**
 * Page object for Settings > Context (the context browser, plan step 5.5). Opens through the
 * Settings dialog, then owns every locator of the browser itself. `data-testid`s are set in
 * `ContextSettings.tsx` and `ContextMarkdown.tsx`. Test bodies call only the methods here.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { SettingsPage } from "./SettingsPage";

export class ContextBrowserPage {
  private readonly settings: SettingsPage;
  readonly root: Locator;

  constructor(
    private readonly page: Page,
    baseUrl: string,
    token: string,
  ) {
    this.settings = new SettingsPage(page, baseUrl, token);
    this.root = page.getByTestId("context-browser");
  }

  async open(): Promise<void> {
    await this.settings.goto();
    await this.settings.openDialog("context");
    await expect(this.root).toBeVisible();
  }

  async selectContext(name: string): Promise<void> {
    await test.step(`Select the ${name} context`, async () => {
      await this.root
        .locator(`[data-testid="context-browser__context"][data-name="${name}"]`)
        .click();
      await expect(
        this.root.locator(`[data-testid="context-browser__context"][data-name="${name}"]`),
      ).toHaveAttribute("aria-selected", "true");
    });
  }

  treeFile(path: string): Locator {
    return this.root.locator(`[data-testid="context-browser__tree-file"][data-path="${path}"]`);
  }

  async openFile(path: string): Promise<void> {
    await test.step(`Open ${path}`, async () => {
      await this.treeFile(path).click();
      await expect(this.root.getByTestId("context-browser__file-path")).toHaveText(path);
    });
  }

  rendered(): Locator {
    return this.root.getByTestId("context-browser__rendered");
  }

  images(): Locator {
    return this.root.getByTestId("context-browser__image");
  }

  videos(): Locator {
    return this.root.getByTestId("context-browser__video");
  }

  async edit(content: string, message: string): Promise<void> {
    await test.step("Edit and save the file", async () => {
      await this.root.getByTestId("context-browser__mode-edit").click();
      await this.root.getByTestId("context-browser__editor").fill(content);
      await this.root.getByTestId("context-browser__message").fill(message);
      await this.root.getByTestId("context-browser__save").click();
      await expect(this.root.getByTestId("context-browser__editor")).toHaveCount(0);
    });
  }

  /** Types `content` in the editor and clicks Save without waiting for it to succeed. */
  async trySave(content: string, message: string): Promise<void> {
    await this.root.getByTestId("context-browser__mode-edit").click();
    await this.root.getByTestId("context-browser__editor").fill(content);
    await this.root.getByTestId("context-browser__message").fill(message);
    await this.root.getByTestId("context-browser__save").click();
  }

  filePath(): Locator {
    return this.root.getByTestId("context-browser__file-path");
  }

  async openHistory(): Promise<void> {
    await this.root.getByTestId("context-browser__mode-history").click();
    await expect(this.root.getByTestId("context-browser__history")).toBeVisible();
  }

  commits(): Locator {
    return this.root.getByTestId("context-browser__commit");
  }

  diff(): Locator {
    return this.root.getByTestId("context-browser__diff");
  }

  error(): Locator {
    return this.root.getByTestId("context-browser__error");
  }

  conflictBanner(): Locator {
    return this.root.getByTestId("context-browser__conflict-banner");
  }

  conflictCount(): Locator {
    return this.root.getByTestId("context-browser__conflict-count");
  }

  async keepConflictVersion(): Promise<void> {
    await this.root.getByTestId("context-browser__keep-conflict").click();
  }

  async keepOriginal(): Promise<void> {
    await this.root.getByTestId("context-browser__keep-original").click();
  }

  recentEntries(): Locator {
    return this.root.getByTestId("context-browser__recent-entry");
  }

  async linkRemote(url: string): Promise<void> {
    await this.root.getByTestId("context-browser__remote-input").fill(url);
    await this.root.getByTestId("context-browser__link").click();
  }

  remoteUrl(): Locator {
    return this.root.getByTestId("context-browser__remote-url");
  }
}
