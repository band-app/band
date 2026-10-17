/**
 * Page object for the Cronjobs dialog and its nested New Cronjob dialog.
 *
 * It has no route: it opens from the overflow menu in the repo-list bottom
 * action bar. `getByRole({ name })` covers the dialogs and
 * the menu item (system-controlled names); owned controls use `cronjobs__*`
 * test IDs set in `CronjobsPageContent.tsx`.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class CronjobsDialog {
  readonly dialog: Locator;
  readonly overflowTrigger: Locator;
  readonly cronjobsMenuItem: Locator;
  readonly newCronjobButton: Locator;
  readonly newCronjobDialog: Locator;
  readonly repoSelect: Locator;
  readonly worktreeSelect: Locator;
  readonly agentSelect: Locator;
  readonly nameInput: Locator;
  readonly promptInput: Locator;
  readonly cronInput: Locator;
  readonly sessionInput: Locator;
  readonly saveButton: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.dialog = page.getByRole("dialog", { name: "Cronjobs" });
    this.overflowTrigger = page.getByTestId("repo-list__overflow-trigger");
    this.cronjobsMenuItem = page.getByRole("menuitem", { name: "Cronjobs" });
    this.newCronjobButton = page.getByTestId("cronjobs__new-button");
    this.newCronjobDialog = page.getByRole("dialog", { name: "New Cronjob" });
    this.repoSelect = page.getByTestId("cronjobs__repo-select");
    this.worktreeSelect = page.getByTestId("cronjobs__worktree-select");
    this.agentSelect = page.getByTestId("cronjobs__agent-select");
    this.nameInput = page.getByTestId("cronjobs__name-input");
    this.promptInput = page.getByTestId("cronjobs__prompt-input");
    this.cronInput = page.getByTestId("cronjobs__cron-input");
    this.sessionInput = page.getByTestId("cronjobs__session-input");
    this.saveButton = page.getByTestId("cronjobs__save-button");
  }

  /** Navigate to the dashboard root with the test token. */
  async goto(): Promise<void> {
    await test.step("Open dashboard", async () => {
      await this.page.goto(`${this.baseUrl}/?token=${this.token}`);
      await this.page.waitForLoadState("networkidle");
    });
  }

  /** Open the overflow menu and click Cronjobs, re-clicking the trigger until
   *  the menu appears (a click before hydration is lost). */
  async open(): Promise<void> {
    await test.step("Open Cronjobs via the bottom action bar overflow", async () => {
      await expect(this.overflowTrigger).toBeVisible();
      await expect(async () => {
        await this.overflowTrigger.click();
        await expect(this.cronjobsMenuItem).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 15_000 });
      await this.cronjobsMenuItem.click();
      await expect(this.dialog).toBeVisible();
    });
  }

  /** Open the New Cronjob dialog and expand its repo picker. */
  async openRepoPicker(): Promise<void> {
    await test.step("Open the New Cronjob repo picker", async () => {
      await this.newCronjobButton.click();
      await expect(this.newCronjobDialog).toBeVisible();
      await this.repoSelect.click();
    });
  }

  /** A repo's avatar inside the open repo picker. */
  repoOption(repoName: string): Locator {
    return this.page.getByRole("option", { name: repoName });
  }

  repoAvatar(repoName: string): Locator {
    return this.repoOption(repoName).getByTestId(`cronjobs__repo-avatar--${repoName}`);
  }

  /** Open the New Cronjob dialog. */
  async openNewCronjob(): Promise<void> {
    await test.step("Open the New Cronjob dialog", async () => {
      await this.newCronjobButton.click();
      await expect(this.newCronjobDialog).toBeVisible();
    });
  }

  /** Fill the free-text fields of the New Cronjob dialog. */
  async fillBasics(fields: { name: string; prompt: string; cron: string }): Promise<void> {
    await this.nameInput.fill(fields.name);
    await this.promptInput.fill(fields.prompt);
    await this.cronInput.fill(fields.cron);
  }

  /** Pick a repo, then one of its worktrees by the option's visible name. */
  async pickWorktree(repoName: string, worktreeOption: string | RegExp): Promise<void> {
    await test.step(`Pick the ${repoName} worktree`, async () => {
      await this.repoSelect.click();
      await this.repoOption(repoName).click();
      await this.worktreeSelect.click();
      await this.page.getByRole("option", { name: worktreeOption }).click();
    });
  }

  /** The worktree picker's options, in the order shown. Leaves the picker open. */
  async worktreeOptions(): Promise<string[]> {
    await this.worktreeSelect.click();
    return (await this.page.getByRole("option").allTextContents()).map((t) => t.trim());
  }

  async pickAgent(label: string): Promise<void> {
    await this.agentSelect.click();
    await this.page.getByRole("option", { name: label }).click();
  }

  /** One job's card in the list. */
  job(name: string): Locator {
    return this.page.getByTestId(`cronjobs__job--${name}`);
  }
}
