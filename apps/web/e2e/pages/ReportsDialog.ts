/**
 * Page object for the Reports dialog (issue #425).
 *
 * Same shape as `ResourcesPage` — no dedicated route, the dialog is
 * opened from the Usage icon in the project-list bottom action bar.
 * Owns the locators for the stat cards, the recharts SVG container, and
 * the four breakdown tables.
 *
 * Locator priority:
 *
 *   - `getByTestId(...)` for owned card / chart / table / button
 *     elements. The BEM-style `reports__*` prefix matches the
 *     `data-testid` attributes set in `ReportsPageContent.tsx`; the
 *     `project-list__usage-button` testid rides on the Usage icon button.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class ReportsDialog {
  /** The Radix Dialog body wrapping the page. */
  readonly dialog: Locator;
  /** Root of the page content. Used as the "the page mounted" anchor —
   *  distinct from `dialog` because Radix wraps the content in extra
   *  portal divs. */
  readonly root: Locator;
  /** Stat cards. */
  readonly totalCost: Locator;
  readonly totalTokens: Locator;
  readonly totalSessions: Locator;
  readonly topModel: Locator;
  /** Recharts container (a wrapper div around the SVG). */
  readonly chart: Locator;
  /** Breakdown tables. */
  readonly byModel: Locator;
  readonly byProject: Locator;
  readonly byAgent: Locator;
  readonly byWorkspace: Locator;
  /** Period select. */
  readonly periodSelect: Locator;
  /** Usage icon button in the project-list bottom action bar. */
  readonly reportsButton: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.dialog = page.getByTestId("reports-dialog");
    this.root = page.getByTestId("reports__root");
    this.totalCost = page.getByTestId("reports__total-cost");
    this.totalTokens = page.getByTestId("reports__total-tokens");
    this.totalSessions = page.getByTestId("reports__total-sessions");
    this.topModel = page.getByTestId("reports__top-model");
    this.chart = page.getByTestId("reports__chart");
    this.byModel = page.getByTestId("reports__by-model");
    this.byProject = page.getByTestId("reports__by-project");
    this.byAgent = page.getByTestId("reports__by-agent");
    this.byWorkspace = page.getByTestId("reports__by-workspace");
    this.periodSelect = page.getByTestId("reports__period-select");
    this.reportsButton = page.getByTestId("project-list__usage-button");
  }

  /** Navigate to the dashboard, then click the Usage icon in the project-list
   *  bottom action bar. The button is wrapped in a Radix Tooltip trigger whose
   *  hover/pointer handling can swallow the first click during a fast run, so
   *  re-click until the dialog actually opens. */
  async open(): Promise<void> {
    await test.step("Open Reports via the bottom action bar", async () => {
      await this.page.goto(`${this.baseUrl}/?token=${this.token}`);
      await this.page.waitForLoadState("networkidle");
      await expect(this.reportsButton).toBeVisible();
      await expect
        .poll(
          async () => {
            if (await this.dialog.isVisible().catch(() => false)) return true;
            await this.reportsButton.click();
            return await this.dialog.isVisible().catch(() => false);
          },
          { timeout: 10_000 },
        )
        .toBe(true);
    });
  }

  async waitForReady(): Promise<void> {
    await expect(this.root).toBeVisible({ timeout: 15_000 });
    await expect(this.totalCost).toBeVisible({ timeout: 15_000 });
  }

  /**
   * Switch the Radix period <Select> to one of "Today" / "Last 7 days" /
   * etc. by clicking the trigger, then the named option. Keeps the raw
   * `getByRole("option", …)` lookup out of test bodies so they can
   * express the intent ("switch to Today") instead of how the Radix
   * popup is built.
   */
  async selectPeriod(label: string): Promise<void> {
    await this.periodSelect.click();
    await this.page.getByRole("option", { name: label }).click();
  }

  /**
   * Set the viewport to a narrow mobile width. Wraps Playwright's
   * `page.setViewportSize` so test bodies don't reach for the raw page
   * object — the size lives on the page object alongside the
   * `assertNoHorizontalOverflow` check that consumes it.
   */
  async setMobileViewport(): Promise<void> {
    await this.page.setViewportSize({ width: 375, height: 800 });
  }

  /**
   * Assert that nothing in the dialog (or the document) exceeds the
   * viewport width. Used to pin the mobile-overflow regression that
   * issue #425's tables originally introduced.
   *
   * Reads the viewport once via `page.viewportSize()` and the dialog's
   * bounding box once, then does a one-pixel-tolerance comparison
   * against both the dialog and `document.documentElement.scrollWidth`
   * so a sub-pixel rounding artefact doesn't flake the test.
   */
  async assertNoHorizontalOverflow(): Promise<void> {
    const viewport = this.page.viewportSize();
    if (!viewport) throw new Error("viewport size unset");

    const dialogBox = await this.dialog.boundingBox();
    if (!dialogBox) throw new Error("dialog has no bounding box");
    expect(dialogBox.width).toBeLessThanOrEqual(viewport.width + 1);

    const bodyOverflow = await this.page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(bodyOverflow).toBeLessThanOrEqual(1);
  }
}
