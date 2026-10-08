/**
 * Page object for the Add repo dialog inside a project (`ProjectAddRepoDialog.tsx`), opened from
 * the project detail of the Projects dialog. Test bodies call only the methods here.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class ProjectAddRepoPage {
  private readonly detail: Locator;
  private readonly dialog: Locator;
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
    this.detail = page.getByTestId("projects__detail");
    this.dialog = page.getByTestId("project-add-repo__dialog");
  }

  async open(): Promise<void> {
    await test.step("Open Add repo", async () => {
      await this.detail.getByTestId("projects__add-repo-open").click();
      await expect(this.dialog).toBeVisible();
    });
  }

  /** Loads the app on `baseUrl` with the token and opens the dialog from the Repos list. */
  async gotoAndOpenFromRepoList(baseUrl: string, token: string): Promise<void> {
    await this.page.goto(`${baseUrl}/?token=${token}`);
    await this.openFromRepoList();
  }

  /** Opens the dialog from the Repos list in the sidebar. */
  async openFromRepoList(): Promise<void> {
    await test.step("Open Add repo from the Repos list", async () => {
      await this.page
        .getByTestId("repo-list__add-repo")
        .or(this.page.getByTestId("repo-list__add-repo-empty"))
        .first()
        .click();
      await expect(this.dialog).toBeVisible();
    });
  }

  noHostsNotice(): Locator {
    return this.dialog.getByTestId("project-add-repo__no-hosts");
  }

  nativePicker(): Locator {
    return this.dialog.getByTestId("project-add-repo__pick-native");
  }

  async chooseWorker(hostId: string): Promise<void> {
    await test.step(`Choose worker ${hostId}`, async () => {
      await this.dialog.getByTestId("project-add-repo__host").selectOption(hostId);
    });
  }

  pickerEntry(name: string): Locator {
    return this.dialog.locator(
      `[data-testid="project-add-repo__picker-entry"][data-name="${name}"]`,
    );
  }

  pickerPath(): Locator {
    return this.dialog.getByTestId("project-add-repo__picker-path");
  }

  /** Opens a folder in the picker. */
  async openFolder(name: string): Promise<void> {
    await this.pickerEntry(name).click();
    await expect(this.pickerPath()).toContainText(name);
  }

  async useCurrentFolder(): Promise<void> {
    await this.dialog.getByTestId("project-add-repo__picker-select").click();
  }

  rootConfirmation(): Locator {
    return this.dialog.getByTestId("project-add-repo__confirm-root");
  }

  async confirmRoot(): Promise<void> {
    await this.dialog.getByTestId("project-add-repo__confirm-root-accept").click();
  }

  async chooseUrl(): Promise<void> {
    await this.dialog.getByTestId("project-add-repo__mode-url").click();
  }

  /** Switches to By URL with the button in the no-worker notice. */
  async chooseUrlFromNotice(): Promise<void> {
    await this.dialog.getByTestId("project-add-repo__no-hosts-url").click();
  }

  async addByUrl(remoteUrl: string, defaultBranch: string): Promise<void> {
    await test.step(`Add ${remoteUrl} by URL`, async () => {
      await this.dialog.getByTestId("project-add-repo__url").fill(remoteUrl);
      await this.dialog.getByTestId("project-add-repo__branch").fill(defaultBranch);
      await this.dialog.getByTestId("project-add-repo__url-submit").click();
    });
  }

  error(): Locator {
    return this.dialog.getByTestId("project-add-repo__error");
  }

  closed(): Locator {
    return this.dialog;
  }

  repo(name: string): Locator {
    return this.detail.locator(`[data-testid="projects__repo"][data-repo="${name}"]`);
  }

  repoUrl(name: string): Locator {
    return this.repo(name).getByTestId("projects__repo-url");
  }
}
