/**
 * Component object for the WorkspacePickerDialog
 * (`apps/web/src/dashboard/components/WorkspacePickerDialog.tsx`) — the
 * command-palette-style "Switch Workspace" dialog reachable on desktop via
 * ⌘K (or by clicking the title-bar workspace name) and on mobile by tapping
 * the workspace header title.
 *
 * Locators key off `data-testid` hooks the component sets:
 *   - `workspace-picker`                       — the dialog content
 *   - `workspace-picker__item--<workspaceId>`  — a workspace row
 *   - `workspace-picker__pin--<workspaceId>`   — that row's pin/unpin button
 *
 * The pin button additionally carries a system-controlled aria-label that
 * flips between "Pin workspace" and "Unpin workspace" — the observable signal
 * the pin/select-separation regression test asserts on.
 *
 * This is a *component* object, not a route page object: the dialog has no URL
 * of its own (it's opened by a gesture on whatever page already rendered), so
 * it deliberately omits the `(page, baseUrl)` constructor + `goto()` that route
 * page objects (e.g. WorkspacePage) carry. Component objects take only `page`
 * and expose interaction methods.
 */

import { type Locator, type Page, test } from "@playwright/test";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

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

  /** The search input inside the picker. cmdk's `Command.Input` renders an
   *  `<input role="combobox" aria-autocomplete="list">`; scoping to the dialog
   *  keeps it from resolving any other combobox on the page. Used by the
   *  layout specs to measure where the input sits relative to the results
   *  list. */
  get input(): Locator {
    return this.dialog.getByRole("combobox");
  }

  /** The workspace rows. cmdk's `Command.Item` renders with role "option". */
  get options(): Locator {
    return this.dialog.getByRole("option");
  }

  async waitVisible(): Promise<void> {
    await test.step("Wait for the workspace picker to open", async () => {
      await this.dialog.waitFor({ state: "visible", timeout: 15_000 });
    });
  }

  /** Wait for the dialog's open/slide/zoom animations (and any descendant's)
   *  to finish. The zoom/slide animation runs on the dialog CONTENT element,
   *  so a child (input, row) must wait on the DIALOG's subtree — not its own —
   *  or it may be measured mid-zoom while the ancestor is still scaling. */
  private async waitAnimationsSettled(): Promise<void> {
    await this.dialog.evaluate((el) =>
      Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))),
    );
  }

  /** Settled bounding box of `locator`, measured only after the dialog's
   *  animations have finished. Throws if the element isn't rendered so a
   *  caller never asserts against `null`. */
  private async settledBoxOf(locator: Locator): Promise<Box> {
    await this.waitAnimationsSettled();
    const box = await locator.boundingBox();
    if (!box) throw new Error("Locator has no bounding box (not visible)");
    return box;
  }

  /** Bounding box of the picker surface. Used to assert the mobile
   *  bottom-drawer geometry. Throws if the dialog isn't rendered. */
  async dialogBox(): Promise<Box> {
    return this.settledBoxOf(this.dialog);
  }

  /** Settled bounding box of the search input. */
  async inputBox(): Promise<Box> {
    return this.settledBoxOf(this.input);
  }

  /** Settled bounding box of the first (top) workspace row. */
  async firstOptionBox(): Promise<Box> {
    return this.settledBoxOf(this.options.first());
  }

  /** Settled bounding box of the last (bottom) workspace row. Used to prove
   *  the input sits below the ENTIRE list on mobile, not just the top row. */
  async lastOptionBox(): Promise<Box> {
    return this.settledBoxOf(this.options.last());
  }

  /** Type a filter query into the picker. cmdk filters the list client-side,
   *  so this changes the number of visible rows (and thus the card height). */
  async typeQuery(text: string): Promise<void> {
    await test.step(`Filter the picker by "${text}"`, async () => {
      await this.input.fill(text);
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
