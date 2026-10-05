/**
 * Page object for the sleeping and waking badge on a worktree card (plan
 * step 3.5). The badge sits on the card of a worktree whose ephemeral worker
 * exited. Locators use the `worktree-card__lifecycle` test id set in
 * `WorktreeCard.tsx`.
 */

import type { Locator, Page } from "@playwright/test";

export class SleepingWorktreePage {
  constructor(private readonly page: Page) {}

  card(worktreeId: string): Locator {
    return this.page.getByTestId(`repo-list__worktree-card--${worktreeId}`);
  }

  badge(worktreeId: string): Locator {
    return this.card(worktreeId).getByTestId("worktree-card__lifecycle");
  }
}
