/**
 * Page object for the add-repo form (`AddRepoForm` in `ProjectAddRepoDialog.tsx`). The form is
 * the Add repo dialog of a project's Repos side tab, of the sidebar's Repos panel (a repo in no
 * project), and the repos step of New project (`where: "create-flow"`). Test bodies call only the
 * methods here.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class ProjectAddRepoPage {
  private readonly page: Page;
  private readonly dialog: Locator;
  private readonly form: Locator;

  constructor(page: Page, where: "dialog" | "create-flow" = "dialog") {
    this.page = page;
    this.dialog =
      where === "dialog"
        ? page.getByTestId("project-add-repo__dialog")
        : page.getByTestId("create-project__flow");
    this.form = this.dialog.getByTestId("project-add-repo__form");
  }

  /** Opens Add repo from the Repos side tab of the project view on screen. */
  async open(): Promise<void> {
    await test.step("Open Add repo", async () => {
      const tab = this.page.getByTestId("right-sidepanel__tab--project-repos");
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await this.page.getByTestId("projects__add-repo-open").click();
      await expect(this.form).toBeVisible();
    });
  }

  /** Opens Add repo from the sidebar's Repos panel, for a repo in no project. */
  async openFromReposPanel(): Promise<void> {
    await test.step("Open Add repo from the Repos panel", async () => {
      await this.page.getByTestId("repos-panel__add-repo").click();
      await expect(this.form).toBeVisible();
    });
  }

  noHostsNotice(): Locator {
    return this.form.getByTestId("project-add-repo__no-hosts");
  }

  openHostsButton(): Locator {
    return this.form.getByTestId("project-add-repo__open-hosts");
  }

  nativePicker(): Locator {
    return this.form.getByTestId("project-add-repo__pick-native");
  }

  async chooseWorker(hostId: string): Promise<void> {
    await test.step(`Choose worker ${hostId}`, async () => {
      await this.form.getByTestId("project-add-repo__host").selectOption(hostId);
    });
  }

  pickerEntry(name: string): Locator {
    return this.form.locator(`[data-testid="project-add-repo__picker-entry"][data-name="${name}"]`);
  }

  pickerPath(): Locator {
    return this.form.getByTestId("project-add-repo__picker-path");
  }

  crumbs(): Locator {
    return this.form.getByTestId("project-add-repo__crumb");
  }

  async filter(text: string): Promise<void> {
    await this.form.getByTestId("project-add-repo__filter").fill(text);
  }

  /** Opens a folder in the picker. */
  async openFolder(name: string): Promise<void> {
    await this.pickerEntry(name).click();
    await expect(this.pickerPath()).toContainText(name);
  }

  /** Picks the open folder, which shows its remote URL and branch before anything is added. */
  async useCurrentFolder(): Promise<void> {
    await this.form.getByTestId("project-add-repo__picker-select").click();
    await expect(this.form.getByTestId("project-add-repo__preview")).toBeVisible();
  }

  previewUrl(): Locator {
    return this.form.getByTestId("project-add-repo__preview-url");
  }

  previewBranch(): Locator {
    return this.form.getByTestId("project-add-repo__preview-branch");
  }

  previewLocalOnly(): Locator {
    return this.form.getByTestId("project-add-repo__preview-local-only");
  }

  /** Adds the previewed folder. */
  async confirm(): Promise<void> {
    await test.step("Add the previewed folder", async () => {
      await this.form.getByTestId("project-add-repo__confirm").click();
    });
  }

  rootConfirmation(): Locator {
    return this.form.getByTestId("project-add-repo__confirm-root");
  }

  /** Adds the previewed folder that lies outside the worker's roots, adding it as a root. */
  async confirmRoot(): Promise<void> {
    await this.form.getByTestId("project-add-repo__confirm-root-accept").click();
  }

  async chooseUrl(): Promise<void> {
    await this.form.getByTestId("project-add-repo__mode-url").click();
  }

  /** Switches to By URL with the button in the no-worker notice. */
  async chooseUrlFromNotice(): Promise<void> {
    await this.form.getByTestId("project-add-repo__no-hosts-url").click();
  }

  async fillUrl(remoteUrl: string): Promise<void> {
    await this.form.getByTestId("project-add-repo__url").fill(remoteUrl);
  }

  /** The default branch the hub read from the remote for the typed URL. */
  resolvedBranch(): Locator {
    return this.form.getByTestId("project-add-repo__url-resolved-branch");
  }

  /** Adds a repo by URL. With no branch, the hub uses the one it resolves from the remote. */
  async addByUrl(remoteUrl: string, defaultBranch?: string): Promise<void> {
    await test.step(`Add ${remoteUrl} by URL`, async () => {
      await this.fillUrl(remoteUrl);
      if (defaultBranch)
        await this.form.getByTestId("project-add-repo__branch").fill(defaultBranch);
      await this.form.getByTestId("project-add-repo__url-submit").click();
    });
  }

  error(): Locator {
    return this.form.getByTestId("project-add-repo__error");
  }

  /** The dialog itself, to assert that it closed after an add. */
  closed(): Locator {
    return this.dialog;
  }

  repo(name: string): Locator {
    return this.page.locator(`[data-testid="projects__repo"][data-repo="${name}"]`);
  }

  repoUrl(name: string): Locator {
    return this.repo(name).getByTestId("projects__repo-url");
  }

  repoBranch(name: string): Locator {
    return this.repo(name).getByTestId("projects__repo-branch");
  }
}
