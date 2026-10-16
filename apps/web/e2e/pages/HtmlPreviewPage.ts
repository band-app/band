/**
 * Page object for the file viewer's HTML Preview button, which opens a file
 * in a Band browser tab.
 *
 * Browser tabs and the button itself render only in the desktop shell
 * (`window.__BAND_DESKTOP__`), and the e2e harness runs the web build in
 * plain Chromium. `installDesktopBridgeStub` adds a no-op bridge before the
 * app loads so the shell reports itself as desktop; Electron is the external
 * boundary being faked, and the hub, its routes and the DOM stay real. The
 * `<webview>` has no engine behind it, so the tab's URL is read from the
 * hub's saved tab record and `openInSecondPage` loads that URL in a real
 * Chromium page to check what the tab would show.
 *
 * Secondary page object: it owns no routes of the app under test.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { listBrowserTabs } from "../helpers/browser-tabs";

export class HtmlPreviewPage {
  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  /** Make the shell report itself as the desktop app. Call before `goto`. */
  async installDesktopBridgeStub(): Promise<void> {
    await this.page.addInitScript(() => {
      (window as unknown as { __BAND_DESKTOP__: unknown }).__BAND_DESKTOP__ = {
        version: 1,
        invoke: async () => ({}),
        on: () => () => {},
      };
    });
  }

  get previewButton(): Locator {
    return this.page.getByTestId("center-file-leaf__html-preview");
  }

  /** The Markdown source/preview toggle in the file leaf header. */
  get markdownPreviewToggle(): Locator {
    return this.page.getByTestId("center-file-leaf__view--preview");
  }

  /** The center tab strip's browser tabs. */
  get browserTabs(): Locator {
    return this.page.getByTestId(/^center-browser-tab--/);
  }

  /** The layout wrapper of the first browser tab; it has `layout-tab[data-selected="true"]` while that tab is shown. */
  private get browserTabContainer(): Locator {
    return this.page
      .locator('[data-testid="layout-tab"]:has([data-testid^="center-browser-tab--"])')
      .first();
  }

  async clickPreview(): Promise<void> {
    await test.step("Click Preview", async () => {
      await this.previewButton.click();
    });
  }

  async focusFileTab(path: string): Promise<void> {
    await this.page.getByTestId(`center-file-tab--${path}`).click();
  }

  async expectBrowserTabActive(): Promise<void> {
    await expect(this.browserTabContainer).toHaveAttribute("data-selected", "true");
  }

  async reload(): Promise<void> {
    await this.page.reload();
  }

  /** Wait until the worktree has exactly one saved browser tab and return its URL. */
  async expectSingleTabUrl(worktreeId: string): Promise<string> {
    let urls: string[] = [];
    await expect
      .poll(async () => {
        urls = (await listBrowserTabs(this.baseUrl, this.token, worktreeId)).map(
          (b) => b.url ?? "",
        );
        return urls.length;
      })
      .toBe(1);
    return urls[0];
  }

  /**
   * Load the tab's URL in a real Chromium page and report what rendered: the
   * computed colour of the first paragraph, the natural width of the first
   * image and the paragraph text. Takes a screenshot into the test report.
   */
  async openInSecondPage(
    tabUrl: string,
    screenshotName: string,
  ): Promise<{ color: string; imageWidth: number; text: string }> {
    const second = await this.page.context().newPage();
    try {
      await second.goto(new URL(tabUrl, this.baseUrl).toString());
      await second.waitForFunction(() => {
        const img = document.querySelector("img");
        return img?.complete === true;
      });
      const result = await second.evaluate(() => {
        const p = document.querySelector("p");
        const img = document.querySelector("img");
        return {
          color: p ? getComputedStyle(p).color : "",
          imageWidth: img?.naturalWidth ?? 0,
          text: p?.textContent ?? "",
        };
      });
      await test.info().attach(screenshotName, {
        body: await second.screenshot(),
        contentType: "image/png",
      });
      return result;
    } finally {
      await second.close();
    }
  }
}
