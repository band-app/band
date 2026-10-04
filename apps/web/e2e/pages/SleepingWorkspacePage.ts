/**
 * Page object for the sleeping and waking badge on a workspace card (plan
 * step 3.5). The badge sits on the card of a workspace whose ephemeral worker
 * exited. Locators use the `workspace-card__lifecycle` test id set in
 * `WorkspaceCard.tsx`.
 */

import type { Locator, Page } from "@playwright/test";

export class SleepingWorkspacePage {
  constructor(private readonly page: Page) {}

  card(workspaceId: string): Locator {
    return this.page.getByTestId(`project-list__workspace-card--${workspaceId}`);
  }

  badge(workspaceId: string): Locator {
    return this.card(workspaceId).getByTestId("workspace-card__lifecycle");
  }
}
