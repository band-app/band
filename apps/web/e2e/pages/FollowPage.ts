/**
 * Page object for follow-the-work: the "host is offline, continue elsewhere?" dialog, the
 * "Continued from" line in the worktree header and on the sidebar card, the Diverged badge on the
 * old copy, and the divergence panel. Locators use the test ids set in `ContinueOnHostDialog.tsx`,
 * `ContinuedFromLine.tsx`, `StartedFromBar.tsx`, `WorktreeCard.tsx` and `DivergencePanel.tsx`.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

export class FollowPage {
  constructor(private readonly page: Page) {}

  // ---- the offer ----------------------------------------------------------------

  get dialog(): Locator {
    return this.page.getByTestId("continue-dialog");
  }

  get question(): Locator {
    return this.dialog.getByTestId("continue-dialog__question");
  }

  get notes(): Locator {
    return this.dialog.getByTestId("continue-dialog__notes");
  }

  target(hostId: string): Locator {
    return this.dialog.locator(`[data-testid="continue-dialog__target"][data-host-id="${hostId}"]`);
  }

  async accept(): Promise<void> {
    await test.step("Continue on the offered host", async () => {
      await this.dialog.getByTestId("continue-dialog__confirm").click();
    });
  }

  async dismiss(): Promise<void> {
    await test.step("Close the offer", async () => {
      await this.dialog
        .getByTestId("continue-dialog__cancel")
        .or(this.dialog.getByTestId("continue-dialog__close"))
        .click();
    });
  }

  // ---- the record of the move -----------------------------------------------------

  get headerContinuedFrom(): Locator {
    return this.page.getByTestId("worktree-header__continued-from").filter({ visible: true });
  }

  card(worktreeId: string): Locator {
    return this.page.getByTestId(`repo-list__worktree-card--${worktreeId}`);
  }

  cardContinuedFrom(worktreeId: string): Locator {
    return this.card(worktreeId).getByTestId("worktree-card__continued-from");
  }

  divergedBadge(worktreeId: string): Locator {
    return this.card(worktreeId).getByTestId("worktree-card__diverged");
  }

  // ---- the old copy, once its host is back -------------------------------------------

  get panel(): Locator {
    return this.page.getByTestId("divergence-panel");
  }

  async openDivergence(worktreeId: string): Promise<void> {
    await test.step(`Open the changes on the old copy ${worktreeId}`, async () => {
      await this.divergedBadge(worktreeId).click();
      await expect(this.panel).toBeVisible();
    });
  }

  panelFile(path: string): Locator {
    return this.panel.locator(`[data-testid="divergence-panel__file"][data-path="${path}"]`);
  }

  get panelDiff(): Locator {
    return this.panel.getByTestId("divergence-panel__diff");
  }

  get panelNotice(): Locator {
    return this.panel.getByTestId("divergence-panel__notice");
  }

  async bringOver(): Promise<void> {
    await test.step("Bring the changes over to the new copy", async () => {
      await this.panel.getByTestId("divergence-panel__bring-over").click();
    });
  }

  // ---- Settings > Repos ----------------------------------------------------------------

  get targets(): Locator {
    return this.dialog.getByTestId("continue-dialog__target");
  }

  autoContinueSwitch(repo: string): Locator {
    return this.page
      .locator(`[data-testid="settings-repos__row"][data-repo="${repo}"]`)
      .getByTestId("settings-repos__auto-continue-switch");
  }
}
