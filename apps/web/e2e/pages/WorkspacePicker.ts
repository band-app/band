/**
 * Component object for the WorkspacePickerDialog
 * (`apps/web/src/dashboard/components/WorkspacePickerDialog.tsx`) — the
 * command-palette-style "Switch Workspace" dialog reachable on desktop via
 * Ctrl+R and on mobile by tapping the workspace header title.
 *
 * Locators key off `data-testid` hooks the component sets:
 *   - `workspace-picker`                       — the dialog content
 *   - `workspace-picker__item--<workspaceId>`  — a workspace row
 *   - `workspace-picker__pin--<workspaceId>`   — that row's pin/unpin button
 *
 * The pin button additionally carries a system-controlled aria-label that
 * flips between "Pin workspace" and "Unpin workspace" — the observable signal
 * the pin/select-separation regression test asserts on.
 */

import { type Locator, type Page, test } from "@playwright/test";

export class WorkspacePicker {
  readonly dialog: Locator;

  constructor(private readonly page: Page) {
    this.dialog = page.getByTestId("workspace-picker");
  }

  item(workspaceId: string): Locator {
    return this.page.getByTestId(`workspace-picker__item--${workspaceId}`);
  }

  pinButton(workspaceId: string): Locator {
    return this.page.getByTestId(`workspace-picker__pin--${workspaceId}`);
  }

  async waitVisible(): Promise<void> {
    await test.step("Wait for the workspace picker to open", async () => {
      await this.dialog.waitFor({ state: "visible", timeout: 15_000 });
    });
  }

  /** Tap a row's pin/unpin button. This must NOT select the workspace —
   *  the dialog stays open and no navigation happens. */
  async togglePin(workspaceId: string): Promise<void> {
    await test.step(`Toggle pin for ${workspaceId}`, async () => {
      await this.pinButton(workspaceId).click();
    });
  }

  /** Select a workspace by clicking its row body (not the pin button). This
   *  navigates to the workspace and closes the dialog. */
  async select(workspaceId: string): Promise<void> {
    await test.step(`Select workspace ${workspaceId}`, async () => {
      // Click the row near its left edge (the label), away from the trailing
      // pin button on the right, so the click lands on the cmdk item body and
      // fires its onSelect.
      await this.item(workspaceId).click({ position: { x: 12, y: 12 } });
    });
  }

  /** Dismiss the dialog without selecting — Escape, the same affordance a
   *  user has to back out. */
  async dismiss(): Promise<void> {
    await test.step("Dismiss the workspace picker", async () => {
      await this.page.keyboard.press("Escape");
    });
  }
}
