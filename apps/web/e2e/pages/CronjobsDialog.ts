/**
 * Page object for the Cronjobs dialog and its nested New Cronjob dialog.
 *
 * Like `TasksDialog`, it has no route: it opens from the overflow menu in the
 * project-list bottom action bar. `getByRole({ name })` covers the dialogs and
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
  readonly projectSelect: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.dialog = page.getByRole("dialog", { name: "Cronjobs" });
    this.overflowTrigger = page.getByTestId("project-list__overflow-trigger");
    this.cronjobsMenuItem = page.getByRole("menuitem", { name: "Cronjobs" });
    this.newCronjobButton = page.getByTestId("cronjobs__new-button");
    this.newCronjobDialog = page.getByRole("dialog", { name: "New Cronjob" });
    this.projectSelect = page.getByTestId("cronjobs__project-select");
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

  /** Open the New Cronjob dialog and expand its project picker. */
  async openProjectPicker(): Promise<void> {
    await test.step("Open the New Cronjob project picker", async () => {
      await this.newCronjobButton.click();
      await expect(this.newCronjobDialog).toBeVisible();
      await this.projectSelect.click();
    });
  }

  /** A project's avatar inside the open project picker. */
  projectOption(projectName: string): Locator {
    return this.page.getByRole("option", { name: projectName });
  }

  projectAvatar(projectName: string): Locator {
    return this.projectOption(projectName).getByTestId(`cronjobs__project-avatar--${projectName}`);
  }
}
