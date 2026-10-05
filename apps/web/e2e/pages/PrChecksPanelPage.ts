/**
 * Page object for the GitHub plugin's Checks tab in the right sidepanel
 * (`plugins/github/src/client/PullRequestPanel.tsx`, contributed through the
 * `worktree.sideTabs` slot). Its tab is `right-sidepanel__tab--github-pull-request`
 * and its body `pr-checks`:
 *
 *   - the header: `pr-checks__number`, `pr-checks__state`, `pr-checks__title`,
 *     `pr-checks__refresh`, and for a branch without a pull request
 *     `pr-checks__branch` / `pr-checks__no-review`;
 *   - the merge control: `pr-checks__merge` (with `data-merge-state`),
 *     `pr-checks__merge-menu`, `pr-checks__merge-method--<method>`,
 *     `pr-checks__merge-confirm-button`;
 *   - the failing banner `pr-checks__failing-banner` with `pr-checks__fix`;
 *   - the summary `pr-checks__summary-<passing|failing|pending>`;
 *   - one `pr-checks__check` row per check (`data-check-state`), with
 *     `pr-checks__check-name`, `-state`, `-link`, `-toggle` and `-details`
 *     (with `pr-checks__check-duration`);
 *   - the overflow menu `pr-checks__menu` (`pr-checks__menu-open`, `-copy`);
 *   - instead of the panel, `pr-checks__error` (with `-retry`) when `gh`
 *     fails and `pr-checks__unavailable` when no plugin serves the repo.
 *
 * Revealing the sidepanel and selecting its tab is delegated to
 * `WorktreePage`.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { WorktreePage } from "./WorktreePage";

export type MergeMethod = "merge" | "squash" | "rebase";

export class PrChecksPanelPage {
  /** The tab's body, present in every state. */
  readonly body: Locator;
  readonly loading: Locator;
  /** The loaded panel (PR or branch view). */
  readonly root: Locator;
  readonly error: Locator;
  readonly errorRetry: Locator;
  readonly unavailable: Locator;
  readonly updated: Locator;
  readonly refreshButton: Locator;
  readonly menuButton: Locator;
  readonly menuOpenItem: Locator;
  readonly menuCopyItem: Locator;
  readonly mergeError: Locator;
  readonly summary: Locator;
  readonly list: Locator;
  readonly number: Locator;
  readonly state: Locator;
  readonly title: Locator;
  readonly branch: Locator;
  readonly noReview: Locator;
  readonly mergeButton: Locator;
  readonly mergeMenu: Locator;
  readonly mergeConfirmButton: Locator;
  readonly failingBanner: Locator;
  readonly failingCount: Locator;
  readonly fixButton: Locator;
  readonly summaryPassing: Locator;
  readonly summaryFailing: Locator;
  readonly summaryPending: Locator;
  /** Every check row, in the order the panel lists them. */
  readonly checks: Locator;
  /** The name cell of every check row, in list order. */
  readonly checkNames: Locator;

  private readonly worktree: WorktreePage;

  constructor(
    private readonly page: Page,
    baseUrl: string,
    token: string,
  ) {
    this.worktree = new WorktreePage(page, baseUrl, token);
    this.body = page.getByTestId("right-sidepanel__plugin--github-pull-request");
    this.loading = page.getByTestId("pr-checks__loading");
    this.root = page.getByTestId("pr-checks");
    this.error = page.getByTestId("pr-checks__error");
    this.errorRetry = page.getByTestId("pr-checks__error-retry");
    this.unavailable = page.getByTestId("pr-checks__unavailable");
    this.updated = page.getByTestId("pr-checks__updated");
    this.refreshButton = page.getByTestId("pr-checks__refresh");
    this.menuButton = page.getByTestId("pr-checks__menu");
    this.menuOpenItem = page.getByTestId("pr-checks__menu-open");
    this.menuCopyItem = page.getByTestId("pr-checks__menu-copy");
    this.mergeError = page.getByTestId("pr-checks__merge-error");
    this.summary = page.getByTestId("pr-checks__summary");
    this.list = page.getByTestId("pr-checks__list");
    this.number = page.getByTestId("pr-checks__number");
    this.state = page.getByTestId("pr-checks__state");
    this.title = page.getByTestId("pr-checks__title");
    this.branch = page.getByTestId("pr-checks__branch");
    this.noReview = page.getByTestId("pr-checks__no-review");
    this.mergeButton = page.getByTestId("pr-checks__merge");
    this.mergeMenu = page.getByTestId("pr-checks__merge-menu");
    this.mergeConfirmButton = page.getByTestId("pr-checks__merge-confirm-button");
    this.failingBanner = page.getByTestId("pr-checks__failing-banner");
    this.failingCount = page.getByTestId("pr-checks__failing-count");
    this.fixButton = page.getByTestId("pr-checks__fix");
    this.summaryPassing = page.getByTestId("pr-checks__summary-passing");
    this.summaryFailing = page.getByTestId("pr-checks__summary-failing");
    this.summaryPending = page.getByTestId("pr-checks__summary-pending");
    this.checks = page.getByTestId("pr-checks__check");
    this.checkNames = page.getByTestId("pr-checks__check-name");
  }

  /** Open the worktree and its Checks tab, and wait until the lookup settles. */
  async goto(worktreeId: string): Promise<void> {
    await this.worktree.goto(worktreeId);
    await this.worktree.waitForReady();
    await this.worktree.revealRightPanel();
    await this.worktree.selectRightPanelTab("github-pull-request");
    await expect(this.body).toBeVisible();
    await expect(this.loading).toHaveCount(0, { timeout: 15_000 });
  }

  async refresh(): Promise<void> {
    await test.step("Refresh the Checks tab", async () => {
      await this.refreshButton.click();
    });
  }

  async toggleSummary(): Promise<void> {
    await test.step("Toggle the checks summary", async () => {
      await this.summary.click();
    });
  }

  async openMenu(): Promise<void> {
    await test.step("Open the pull request's overflow menu", async () => {
      await this.menuButton.click();
    });
  }

  /** The row of the check called `name` (a name the test seeded). */
  check(name: string): Locator {
    return this.checks.filter({
      has: this.page.getByTestId("pr-checks__check-name").getByText(name, { exact: true }),
    });
  }

  checkLink(name: string): Locator {
    return this.check(name).getByTestId("pr-checks__check-link");
  }

  checkDetails(name: string): Locator {
    return this.check(name).getByTestId("pr-checks__check-details");
  }

  /** The Duration line of an expanded check. */
  checkDuration(name: string): Locator {
    return this.check(name).getByTestId("pr-checks__check-duration");
  }

  /**
   * Pin the page's `Date.now()` to `time` (Playwright's clock). Timers keep
   * running, so the panel's one-second tick re-renders against it. Call
   * before `goto` for the first render to use it.
   */
  async setTime(time: string): Promise<void> {
    await test.step(`Set the page clock to ${time}`, async () => {
      await this.page.clock.setFixedTime(time);
    });
  }

  async expandCheck(name: string): Promise<void> {
    await test.step(`Expand the ${name} check`, async () => {
      await this.check(name).getByTestId("pr-checks__check-toggle").click();
      await expect(this.checkDetails(name)).toBeVisible();
    });
  }

  async startFix(): Promise<void> {
    await test.step("Start an AI fix pass for the failing checks", async () => {
      await this.fixButton.click();
    });
  }

  /** Pick a merge method from the merge button's menu and confirm it. */
  async merge(method: MergeMethod): Promise<void> {
    await test.step(`Merge the pull request (${method})`, async () => {
      await this.mergeMenu.click();
      await this.page.getByTestId(`pr-checks__merge-method--${method}`).click();
      await this.mergeConfirmButton.click();
    });
  }
}
