/**
 * Page object for the checkpoint surfaces: the "Checkpoints on the hub" switch in Settings >
 * Repos, the offline badge and superseded badge on a worktree card, the offline banner, and the
 * read-only Explorer and Changes of the newest checkpoint. Locators use the test ids set in
 * `ReposSettings.tsx`, `WorktreeCard.tsx` and `OfflineCheckpoint.tsx`.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class CheckpointsPage {
  constructor(private readonly page: Page) {}

  // ---- Settings > Repos -----------------------------------------------------

  repoRow(repo: string): Locator {
    return this.page.locator(`[data-testid="settings-repos__row"][data-repo="${repo}"]`);
  }

  checkpointsSwitch(repo: string): Locator {
    return this.repoRow(repo).getByTestId("settings-repos__checkpoints-switch");
  }

  checkpointsNote(repo: string): Locator {
    return this.repoRow(repo).getByTestId("settings-repos__checkpoints-note");
  }

  async toggleCheckpoints(repo: string): Promise<void> {
    await test.step(`Toggle checkpoints for ${repo}`, async () => {
      await this.checkpointsSwitch(repo).click();
    });
  }

  // ---- worktree card and banner -----------------------------------------------

  card(worktreeId: string): Locator {
    return this.page.getByTestId(`repo-list__worktree-card--${worktreeId}`);
  }

  offlineBadge(worktreeId: string): Locator {
    return this.card(worktreeId).getByTestId("worktree-card__offline");
  }

  supersededBadge(worktreeId: string): Locator {
    return this.card(worktreeId).getByTestId("worktree-card__superseded");
  }

  get banner(): Locator {
    return this.page.getByTestId("offline-checkpoint");
  }

  // ---- read-only panel ----------------------------------------------------------

  get panel(): Locator {
    return this.page.getByTestId("checkpoint-panel");
  }

  async openChanges(): Promise<void> {
    await this.panel.getByTestId("checkpoint-panel__tab--changes").click();
  }

  async openExplorer(): Promise<void> {
    await this.panel.getByTestId("checkpoint-panel__tab--explorer").click();
  }

  change(path: string): Locator {
    return this.panel.locator(`[data-testid="checkpoint-panel__change"][data-path="${path}"]`);
  }

  file(path: string): Locator {
    return this.panel.locator(`[data-testid="checkpoint-panel__file"][data-path="${path}"]`);
  }

  get diff(): Locator {
    return this.panel.getByTestId("checkpoint-panel__diff");
  }

  get content(): Locator {
    return this.panel.getByTestId("checkpoint-panel__content");
  }

  async expectChangeDiff(path: string, text: string): Promise<void> {
    await this.change(path).click();
    await expect(this.diff).toContainText(text);
  }

  async expectFileContent(path: string, text: string): Promise<void> {
    await this.file(path).click();
    await expect(this.content).toContainText(text);
  }
}
