import { expect, type Locator, type Page, test } from "@playwright/test";

/** The menu a plain click on a URL in a terminal opens. */
export class TerminalLinkPopoverPage {
  readonly popover: Locator;
  readonly url: Locator;
  readonly copyButton: Locator;
  readonly openInBandBrowser: Locator;
  readonly openInSystemBrowser: Locator;

  constructor(private readonly page: Page) {
    this.popover = page.getByTestId("terminal-link-popover");
    this.url = page.getByTestId("terminal-link-popover__url");
    this.copyButton = page.getByTestId("terminal-link-popover__copy");
    this.openInBandBrowser = page.getByTestId("terminal-link-popover__open-band");
    this.openInSystemBrowser = page.getByTestId("terminal-link-popover__open-system");
  }

  async copy(): Promise<void> {
    await test.step("Copy the link", async () => {
      await this.copyButton.click();
    });
  }

  async openInSystem(): Promise<void> {
    await test.step("Open the link in the system browser", async () => {
      await this.openInSystemBrowser.click();
    });
  }

  async dismissWithEscape(): Promise<void> {
    await test.step("Press Escape", async () => {
      await this.page.keyboard.press("Escape");
      await expect(this.popover).toBeHidden();
    });
  }

  async readClipboard(): Promise<string> {
    return await this.page.evaluate(() => navigator.clipboard.readText());
  }
}
