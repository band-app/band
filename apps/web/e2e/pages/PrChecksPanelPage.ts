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
 *   - the failing banner `pr-checks__failing-banner` with `pr-checks__fix` and `pr-checks__rerun-failed`;
 *   - the summary `pr-checks__summary-<passing|failing|pending>`;
 *   - one `pr-checks__check` row per check (`data-check-state`), with
 *     `pr-checks__check-name`, `-state`, `-link`, `-toggle`, `-rerun` (with `-rerun-error`) and `-details`
 *     (with `pr-checks__check-duration`);
 *   - the overflow menu `pr-checks__menu` (`pr-checks__menu-open`, `-copy`);
 *   - instead of the panel, `pr-checks__error` (with `-retry`) when `gh`
 *     fails and `pr-checks__unavailable` when no plugin serves the repo.
 *
 * Sections: reviewers and comments have a header `pr-<id>__header`
 * (`aria-expanded`) with `pr-<id>__summary`; checks uses its `pr-checks__summary` row. Reviewers: `pr-reviewers__reviewer`
 * (`data-reviewer-state`, `pr-reviewers__state`). Comments: `pr-comments__item`,
 * `pr-comments__thread` (`pr-comments__thread-location`, `-label`, `-toggle`,
 * `-messages`), `pr-comments__body` and `pr-comments__link`.
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
  readonly mergeConfirm: Locator;
  readonly mergeCancelButton: Locator;
  readonly failingBanner: Locator;
  readonly failingCount: Locator;
  readonly fixButton: Locator;
  /** The "Open" link in the banner once the fix agent has started. */
  readonly openAgentLink: Locator;
  readonly summaryPassing: Locator;
  readonly summaryFailing: Locator;
  readonly summaryPending: Locator;
  /** Every check row, in the order the panel lists them. */
  readonly checks: Locator;
  /** The name cell of every check row, in list order. */
  readonly checkNames: Locator;

  readonly reviewers: Locator;
  readonly reviewersSummary: Locator;
  readonly commentsSummary: Locator;
  readonly commentItems: Locator;
  readonly threads: Locator;

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
    this.mergeConfirm = page.getByTestId("pr-checks__merge-confirm");
    this.mergeCancelButton = page.getByTestId("pr-checks__merge-cancel");
    this.mergeConfirmButton = page.getByTestId("pr-checks__merge-confirm-button");
    this.failingBanner = page.getByTestId("pr-checks__failing-banner");
    this.failingCount = page.getByTestId("pr-checks__failing-count");
    this.fixButton = page.getByTestId("pr-checks__fix");
    this.openAgentLink = page.getByTestId("pr-checks__open-agent");
    this.summaryPassing = page.getByTestId("pr-checks__summary-passing");
    this.summaryFailing = page.getByTestId("pr-checks__summary-failing");
    this.summaryPending = page.getByTestId("pr-checks__summary-pending");
    this.checks = page.getByTestId("pr-checks__check");
    this.checkNames = page.getByTestId("pr-checks__check-name");
    this.reviewers = page.getByTestId("pr-reviewers__reviewer");
    this.reviewersSummary = page.getByTestId("pr-reviewers__summary");
    this.commentsSummary = page.getByTestId("pr-comments__summary");
    this.commentItems = page.getByTestId("pr-comments__item");
    this.threads = page.getByTestId("pr-comments__thread");
  }

  /** The header button of a section: `reviewers`, `checks` (the summary row) or `comments`. */
  sectionHeader(id: "reviewers" | "checks" | "comments"): Locator {
    return id === "checks" ? this.summary : this.page.getByTestId(`pr-${id}__header`);
  }

  async toggleSection(id: "reviewers" | "checks" | "comments"): Promise<void> {
    await test.step(`Toggle the ${id} section`, async () => {
      await this.sectionHeader(id).click();
    });
  }

  reviewer(login: string): Locator {
    return this.reviewers.filter({ hasText: login });
  }

  reviewerState(login: string): Locator {
    return this.reviewer(login).getByTestId("pr-reviewers__state");
  }

  reviewerRequired(login: string): Locator {
    return this.reviewer(login).getByTestId("pr-reviewers__required");
  }

  reviewerAvatarImage(login: string): Locator {
    return this.reviewer(login).getByTestId("pr-avatar__image");
  }

  reviewerAvatarFallback(login: string): Locator {
    return this.reviewer(login).getByTestId("pr-avatar__fallback");
  }

  commentAvatarImage(index: number): Locator {
    return this.commentItems.nth(index).getByTestId("pr-avatar__image");
  }

  commentAvatarFallback(index: number): Locator {
    return this.commentItems.nth(index).getByTestId("pr-avatar__fallback");
  }

  /** Script elements inside comment bodies; untrusted HTML must never produce one. */
  commentBodyScripts(): Locator {
    return this.page.getByTestId("pr-comments__body").locator("script");
  }

  /** The GitHub links inside the thread on `location`. */
  threadLinks(location: string): Locator {
    return this.thread(location).getByTestId("pr-comments__link");
  }

  /** The "Resolved" or "Outdated" label of the thread on `location`. */
  threadLabel(location: string): Locator {
    return this.thread(location).getByTestId("pr-comments__thread-label");
  }

  /** The messages of the thread on `location`, hidden while it is collapsed. */
  threadMessages(location: string): Locator {
    return this.thread(location).getByTestId("pr-comments__thread-messages");
  }

  /** The inline thread on `location` (`path:line`). */
  thread(location: string): Locator {
    return this.threads.filter({
      has: this.page.getByTestId("pr-comments__thread-location").getByText(location, {
        exact: true,
      }),
    });
  }

  async openThreadLocation(location: string): Promise<void> {
    await test.step(`Open ${location} from its thread`, async () => {
      await this.thread(location).getByTestId("pr-comments__thread-location").click();
    });
  }

  async toggleThread(location: string): Promise<void> {
    await test.step(`Toggle the thread on ${location}`, async () => {
      await this.thread(location).getByTestId("pr-comments__thread-toggle").click();
    });
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

  /** The Re-run button on the check called `name`. */
  rerunButton(name: string): Locator {
    return this.check(name).getByTestId("pr-checks__check-rerun");
  }

  /** The message shown under a check whose re-run was refused. */
  rerunError(name: string): Locator {
    return this.check(name).getByTestId("pr-checks__check-rerun-error");
  }

  async rerunCheck(name: string): Promise<void> {
    await test.step(`Re-run the ${name} check`, async () => {
      await this.rerunButton(name).click();
    });
  }

  async rerunFailed(): Promise<void> {
    await test.step("Re-run every failed job", async () => {
      await this.page.getByTestId("pr-checks__rerun-failed").click();
    });
  }

  async startFix(): Promise<void> {
    await test.step("Start an AI fix pass for the failing checks", async () => {
      await this.fixButton.click();
    });
  }

  async openFixAgent(): Promise<void> {
    await test.step("Open the fix agent's tab from the banner", async () => {
      await this.openAgentLink.click();
    });
  }

  /** Pick a merge method from the menu and stop at the confirm box. */
  async openMergeConfirm(method: MergeMethod): Promise<void> {
    await test.step(`Open the merge confirm (${method})`, async () => {
      await this.mergeMenu.click();
      await this.page.getByTestId(`pr-checks__merge-method--${method}`).click();
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
