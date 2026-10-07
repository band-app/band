/**
 * Page object for the coordinator's code browser in the project detail (plan step T.1b). The
 * `data-testid`s are set in `ProjectCodeBrowser.tsx`. Test bodies call only the methods here.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class ProjectCodeBrowserPage {
  readonly root: Locator;

  constructor(page: Page) {
    this.root = page.getByTestId("code-browser");
  }

  repoTab(repo: string): Locator {
    return this.root.locator(`[data-testid="code-browser__repo"][data-repo="${repo}"]`);
  }

  repoTabs(): Locator {
    return this.root.getByTestId("code-browser__repo");
  }

  async chooseRepo(repo: string): Promise<void> {
    await this.repoTab(repo).click();
    await expect(this.repoTab(repo)).toHaveAttribute("data-active", "true");
  }

  async openCode(): Promise<void> {
    await this.root.getByTestId("code-browser__tab-code").click();
    await expect(this.root.getByTestId("code-browser__code")).toBeVisible();
  }

  async openChanges(): Promise<void> {
    await this.root.getByTestId("code-browser__tab-changes").click();
    await expect(this.root.getByTestId("code-browser__changes")).toBeVisible();
  }

  async openDir(path: string): Promise<void> {
    await this.root.locator(`[data-testid="code-browser__dir"][data-path="${path}"]`).click();
  }

  async openFile(path: string): Promise<void> {
    await test.step(`Open ${path}`, async () => {
      await this.root.locator(`[data-testid="code-browser__file"][data-path="${path}"]`).click();
      await expect(this.root.getByTestId("code-browser__viewer")).toHaveAttribute(
        "data-path",
        path,
      );
    });
  }

  viewer(): Locator {
    return this.root.getByTestId("code-browser__viewer");
  }

  file(path: string): Locator {
    return this.root.locator(`[data-testid="code-browser__file"][data-path="${path}"]`);
  }

  async search(query: string): Promise<void> {
    await this.root.getByTestId("code-browser__search").fill(query);
    await this.root.getByTestId("code-browser__search-submit").click();
  }

  results(): Locator {
    return this.root.getByTestId("code-browser__result");
  }

  changedFile(path: string): Locator {
    return this.root.locator(`[data-testid="code-browser__changed-file"][data-path="${path}"]`);
  }

  diff(): Locator {
    return this.root.getByTestId("code-browser__uncommitted").getByTestId("code-browser__diff");
  }

  branchLine(): Locator {
    return this.root.getByTestId("code-browser__branch");
  }

  async commit(message: string): Promise<void> {
    await test.step(`Commit "${message}"`, async () => {
      await this.root.getByTestId("code-browser__commit-message").fill(message);
      await this.root.getByTestId("code-browser__commit").click();
    });
  }

  unpushed(): Locator {
    return this.root.getByTestId("code-browser__unpushed-list-item");
  }

  push(): Locator {
    return this.root.getByTestId("code-browser__push");
  }

  pull(): Locator {
    return this.root.getByTestId("code-browser__pull");
  }

  diverged(): Locator {
    return this.root.getByTestId("code-browser__diverged");
  }
}
