/**
 * Page object for the checkpoint surfaces: the "Checkpoints on the hub" switch in Settings >
 * Repos, the offline icon and superseded badge on a worktree card, its "Open on another host…"
 * menu item, the offline notice, and the read-only Explorer and Changes of the newest checkpoint. Locators use the test ids set in
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

  /** The icon an offline worktree's card shows in place of text. */
  offlineIcon(worktreeId: string): Locator {
    return this.card(worktreeId).getByTestId("worktree-card__offline");
  }

  /** The tooltip with the host's last seen time and the checkpoint age. */
  get offlineDetails(): Locator {
    return this.page.getByTestId("worktree-card__offline-details");
  }

  async showOfflineDetails(worktreeId: string): Promise<void> {
    await this.offlineIcon(worktreeId).hover();
  }

  supersededBadge(worktreeId: string): Locator {
    return this.card(worktreeId).getByTestId("worktree-card__superseded");
  }

  /** The "Open on another host…" item of a card's context menu. */
  moveItem(): Locator {
    return this.page.getByTestId("worktree-card__move");
  }

  async openCardMenu(worktreeId: string): Promise<void> {
    await test.step(`Open the context menu of ${worktreeId}`, async () => {
      await this.card(worktreeId).click({ button: "right" });
    });
  }

  /** The reason a disabled "Open on another host…" item gives. */
  moveReason(): Locator {
    return this.page.getByTestId("worktree-card__move-reason");
  }

  async closeCardMenu(): Promise<void> {
    await this.page.keyboard.press("Escape");
    await expect(this.moveItem()).toHaveCount(0);
  }

  // ---- the notice above an offline worktree ----------------------------------------

  get notice(): Locator {
    return this.page.getByTestId("offline-notice");
  }

  get noticeHost(): Locator {
    return this.notice.getByTestId("offline-notice__host");
  }

  get noticeBlocked(): Locator {
    return this.notice.getByTestId("offline-notice__blocked");
  }

  /** The right panel of an offline worktree, before the checkpoint is chosen. */
  get sidepanelPlaceholder(): Locator {
    return this.page.getByTestId("offline-sidepanel");
  }

  /** The time left before the old host's lease ends and the button turns on. */
  get leaseCountdown(): Locator {
    return this.notice.getByTestId("offline-notice__countdown");
  }

  get openElsewhereButton(): Locator {
    return this.notice.getByTestId("offline-notice__open-elsewhere");
  }

  async viewCheckpoint(): Promise<void> {
    await test.step("Open the read-only checkpoint view", async () => {
      await this.notice.getByTestId("offline-notice__view-checkpoint").click();
    });
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
