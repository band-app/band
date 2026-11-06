/**
 * Page object for the Resources dialog opened from the Resources icon in the repo-list bottom
 * action bar (no dedicated route; the page renders inside a Dialog managed by
 * `ToolbarOverflowProvider`).
 *
 * Locator priority: `getByTestId` for owned elements, using the BEM-style `resources__*` ids
 * that `ResourcesPage.tsx` sets, plus `repo-list__resources-button` for the sidebar icon and
 * `resources-dialog` for the dialog body.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export type ResourcesMetric = "memory" | "cpu" | "storage";

export class ResourcesPage {
  readonly dialog: Locator;
  readonly cards: Locator;
  readonly topConsumers: Locator;
  readonly topRows: Locator;
  readonly resourcesButton: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.dialog = page.getByTestId("resources-dialog");
    this.cards = page.getByTestId("resources__cards");
    this.topConsumers = page.getByTestId("resources__top-consumers");
    this.topRows = page.getByTestId("resources__top-row");
    this.resourcesButton = page.getByTestId("repo-list__resources-button");
  }

  /** Opens the dashboard and clicks the Resources icon, retrying because the tooltip trigger can swallow a click. */
  async open(): Promise<void> {
    await test.step("Open Resources via the bottom action bar", async () => {
      await this.page.goto(`${this.baseUrl}/?token=${this.token}`);
      await this.page.waitForLoadState("networkidle");
      await expect(this.resourcesButton).toBeVisible();
      await expect
        .poll(
          async () => {
            if (await this.dialog.isVisible().catch(() => false)) return true;
            await this.resourcesButton.click();
            return await this.dialog.isVisible().catch(() => false);
          },
          { timeout: 10_000 },
        )
        .toBe(true);
    });
  }

  async switchTo(metric: ResourcesMetric): Promise<void> {
    await test.step(`Switch to ${metric}`, async () => {
      await this.tab(metric).click();
      await expect(this.tab(metric)).toHaveAttribute("aria-selected", "true");
    });
  }

  tab(metric: ResourcesMetric): Locator {
    return this.page.getByTestId(`resources__tab-${metric}`);
  }

  card(machineId: string): Locator {
    return this.page.getByTestId(`resources__card-${machineId}`);
  }

  section(machineId: string): Locator {
    return this.page.getByTestId(`resources__machine-${machineId}`);
  }

  unavailable(machineId: string): Locator {
    return this.page.getByTestId(`resources__unavailable-${machineId}`);
  }

  /** Process rows of one machine, optionally of one component group (`terminals`, `agents`...). */
  processes(machineId: string, group?: string): Locator {
    const scope = group
      ? this.page.getByTestId(`resources__group-${machineId}-${group}`)
      : this.section(machineId);
    return scope.getByTestId("resources__process");
  }

  worktreeLinks(row: Locator): Locator {
    return row.getByTestId("resources__worktree-link");
  }

  chatLabel(row: Locator): Locator {
    return row.getByTestId("resources__chat");
  }

  /** Reads the number in the value cell of a row, as bytes or percent text. */
  value(row: Locator): Locator {
    return row.getByTestId("resources__value");
  }

  storage(machineId: string): Locator {
    return this.page.getByTestId(`resources__storage-${machineId}`);
  }

  freeDisk(machineId: string): Locator {
    return this.page.getByTestId(`resources__free-disk-${machineId}`);
  }

  repoRow(machineId: string, repo: string): Locator {
    return this.page.getByTestId(`resources__repo-${machineId}-${repo}`);
  }

  /** Opens a repo row to list its worktrees. */
  async expandRepo(machineId: string, repo: string): Promise<void> {
    await test.step(`Expand ${repo} on ${machineId}`, async () => {
      await this.repoRow(machineId, repo).getByTestId("resources__repo-toggle").click();
    });
  }

  worktreeSizes(machineId: string): Locator {
    return this.storage(machineId).getByTestId("resources__worktree-size");
  }

  /** True when the dialog's scroll area is wider than what it shows. */
  async scrollsSideways(): Promise<boolean> {
    return this.page
      .getByTestId("resources__page")
      .evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  }
}
