/**
 * Component page object for the floating selection tooltip that
 * `selectionToChatExtension` renders inside CodeMirror editors (the diff view
 * and the file viewer). The tooltip exposes three actions — "Add to Chat",
 * "Add to Terminal", and "Copy reference" — each tagged with a BEM
 * `data-testid` set in `apps/web/src/dashboard/lib/selection-to-chat.ts`.
 *
 * This is a SECONDARY page object: it owns no route and constructs no URL, so
 * it intentionally does not follow the `(page, baseUrl, …)` + `goto()`
 * convention. Selecting text (which surfaces the tooltip) lives on
 * `ChangesPanelPage.selectDiffLine` since that's where the CodeMirror knowledge
 * lives; this object only drives the tooltip buttons.
 *
 * The buttons are CodeMirror tooltip DOM (plain DOM built by the extension, not
 * React), and their click handler runs on `mousedown` + `preventDefault` so a
 * real click doesn't blur the editor or collapse the selection before the
 * handler reads it. The handler also tears the tooltip down synchronously on
 * `mousedown`, which would detach the element mid-click — so we dispatch
 * `mousedown` directly rather than using `.click()` (which would also fire a
 * `mouseup` on the now-removed node).
 */

import { type Locator, type Page, test } from "@playwright/test";

export class SelectionTooltipPage {
  readonly addToChat: Locator;
  readonly addToTerminal: Locator;
  readonly copyReference: Locator;

  constructor(page: Page) {
    this.addToChat = page.getByTestId("selection-tooltip__add-to-chat");
    this.addToTerminal = page.getByTestId("selection-tooltip__add-to-terminal");
    this.copyReference = page.getByTestId("selection-tooltip__copy-reference");
  }

  /** Wait for the tooltip to surface after a selection. The extension shows it
   *  on a 500 ms debounce, so the default Playwright visibility timeout (which
   *  auto-retries) covers it. */
  async waitVisible(): Promise<void> {
    await this.addToChat.waitFor({ state: "visible", timeout: 10_000 });
  }

  private async fire(button: Locator, label: string): Promise<void> {
    await test.step(`Activate selection tooltip "${label}"`, async () => {
      await button.waitFor({ state: "visible", timeout: 10_000 });
      // mousedown is the handler's trigger; dispatching it directly avoids the
      // mouseup-on-detached-node race (the handler hides the tooltip on
      // mousedown).
      await button.dispatchEvent("mousedown");
    });
  }

  async clickAddToChat(): Promise<void> {
    await this.fire(this.addToChat, "Add to Chat");
  }

  async clickAddToTerminal(): Promise<void> {
    await this.fire(this.addToTerminal, "Add to Terminal");
  }

  async clickCopyReference(): Promise<void> {
    await this.fire(this.copyReference, "Copy reference");
  }
}
