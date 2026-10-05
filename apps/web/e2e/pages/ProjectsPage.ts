/**
 * Page object for the Projects dialog (plan step 6.1), opened from the Projects button in the
 * sidebar's bottom action bar. `data-testid`s are set in `ProjectsDialog.tsx` and
 * `DashboardShell.tsx`. Test bodies call only the methods here.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { ContextBrowserPage } from "./ContextBrowserPage";

export interface NewProject {
  name: string;
  description?: string;
  repos: Array<{ repo: string; role?: string }>;
}

export class ProjectsPage {
  private readonly dialog: Locator;
  private readonly detail: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.dialog = page.getByTestId("projects");
    this.detail = page.getByTestId("projects__detail");
  }

  emptyState(): Locator {
    return this.dialog.getByTestId("projects__empty");
  }

  async goto(): Promise<void> {
    await this.page.goto(`${this.baseUrl}/?token=${this.token}`);
    await expect(this.page.getByTestId("repo-list__projects-button")).toBeVisible();
  }

  async open(): Promise<void> {
    await test.step("Open the Projects dialog", async () => {
      await this.page.getByTestId("repo-list__projects-button").click();
      await expect(this.dialog).toBeVisible();
    });
  }

  item(name: string): Locator {
    return this.dialog.locator(`[data-testid="projects__item"][data-project="${name}"]`);
  }

  async create(project: NewProject): Promise<void> {
    await test.step(`Create project ${project.name}`, async () => {
      await this.dialog.getByTestId("projects__new").click();
      const form = this.page.getByTestId("projects__create");
      await form.getByTestId("projects__name").fill(project.name);
      if (project.description) {
        await form.getByTestId("projects__description").fill(project.description);
      }
      for (const { repo, role } of project.repos) {
        await form.locator(`[data-testid="projects__repo-option"][data-repo="${repo}"]`).check();
        if (role) {
          await form.locator(`[data-testid="projects__repo-role"][data-repo="${repo}"]`).fill(role);
        }
      }
      await form.getByTestId("projects__create-submit").click();
      await expect(this.detail).toBeVisible();
    });
  }

  async back(): Promise<void> {
    await this.detail.getByTestId("projects__back").click();
    await expect(this.dialog.getByTestId("projects__list")).toBeVisible();
  }

  async openProject(name: string): Promise<void> {
    await this.item(name).click();
    await expect(this.detail).toHaveAttribute("data-project", name);
  }

  repo(name: string): Locator {
    return this.detail.locator(`[data-testid="projects__repo"][data-repo="${name}"]`);
  }

  repos(): Locator {
    return this.detail.getByTestId("projects__repo");
  }

  async removeRepo(name: string): Promise<void> {
    await this.detail.locator(`[data-testid="projects__repo-remove"][data-repo="${name}"]`).click();
  }

  worktreeGroup(repo: string): Locator {
    return this.detail.locator(`[data-testid="projects__worktree-group"][data-repo="${repo}"]`);
  }

  error(): Locator {
    return this.detail.getByTestId("projects__error");
  }

  modelSelect(): Locator {
    return this.detail.getByTestId("projects__model-select");
  }

  async chooseModel(model: string): Promise<void> {
    await this.modelSelect().selectOption(model);
  }

  async openContext(): Promise<ContextBrowserPage> {
    await this.detail.getByTestId("projects__context-link").click();
    const browser = new ContextBrowserPage(this.page, this.baseUrl, this.token);
    await expect(browser.root).toBeVisible();
    return browser;
  }
}
