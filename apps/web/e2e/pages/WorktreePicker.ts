/**
 * Component object for the WorktreePickerDialog
 * (`apps/web/src/dashboard/components/WorktreePickerDialog.tsx`) — the
 * command-palette-style "Switch Worktree" dialog reachable on desktop via
 * ⌘K (or by clicking the title-bar worktree name) and on mobile by tapping
 * the worktree header title.
 *
 * Locators key off `data-testid` hooks the component sets:
 *   - `worktree-picker`                       — the dialog content
 *   - `worktree-picker__item--<worktreeId>`  — a worktree row
 *   - `worktree-picker__pin--<worktreeId>`   — that row's pin/unpin button
 *
 * The pin button additionally carries a system-controlled aria-label that
 * flips between "Pin worktree" and "Unpin worktree" — the observable signal
 * the pin/select-separation regression test asserts on.
 *
 * This is a *component* object, not a route page object: the dialog has no URL
 * of its own (it's opened by a gesture on whatever page already rendered), so
 * it deliberately omits the `(page, baseUrl)` constructor + `goto()` that route
 * page objects (e.g. WorktreePage) carry. Component objects take only `page`
 * and expose interaction methods.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class WorktreePicker {
  readonly dialog: Locator;

  constructor(private readonly page: Page) {
    this.dialog = page.getByTestId("worktree-picker");
  }

  item(worktreeId: string): Locator {
    return this.page.getByTestId(`worktree-picker__item--${worktreeId}`);
  }

  pinButton(worktreeId: string): Locator {
    return this.page.getByTestId(`worktree-picker__pin--${worktreeId}`);
  }

  /** The house icon a row shows when its worktree is the repo's main
   *  checkout (default-branch worktree). Feature-branch rows show the branch
   *  glyph instead and have no such node. */
  homeIcon(worktreeId: string): Locator {
    return this.page.getByTestId(`worktree-picker__home-icon--${worktreeId}`);
  }

  /** The search input inside the picker. cmdk's `Command.Input` renders an
   *  `<input role="combobox" aria-autocomplete="list">`; scoping to the dialog
   *  keeps it from resolving any other combobox on the page. Used by the
   *  layout specs to measure where the input sits relative to the results
   *  list. */
  get input(): Locator {
    return this.dialog.getByRole("combobox");
  }

  /** The worktree rows. cmdk's `Command.Item` renders with role "option". */
  get options(): Locator {
    return this.dialog.getByRole("option");
  }

  /** Assert the number of worktree rows currently rendered. Wraps the
   *  `options` locator so test bodies assert row counts through the page
   *  object rather than consuming the raw locator. */
  async expectOptionCount(count: number): Promise<void> {
    await expect(this.options).toHaveCount(count);
  }

  /** The worktree ids of the rows in visual (top-to-bottom) order. Each row
   *  carries `data-testid="worktree-picker__item--<worktreeId>"`; cmdk keeps
   *  the rows in the order the component renders them (mount order, preserved
   *  when the search box is empty), so `evaluateAll` over the DOM reflects the
   *  switcher's sort. Used to assert the recency ordering. */
  async orderedWorktreeIds(): Promise<string[]> {
    return this.options.evaluateAll((els) =>
      els
        .map((el) => (el.getAttribute("data-testid") ?? "").replace("worktree-picker__item--", ""))
        // Drop any option that lacked the expected testid rather than letting a
        // silent "" leak into ordering assertions.
        .filter((id) => id.length > 0),
    );
  }

  async waitVisible(): Promise<void> {
    await test.step("Wait for the worktree picker to open", async () => {
      await this.dialog.waitFor({ state: "visible", timeout: 15_000 });
    });
  }

  /** Wait for the dialog's open/slide/zoom animations (and any descendant's)
   *  to finish. The zoom/slide animation runs on the dialog CONTENT element,
   *  so a child (input, row) must wait on the DIALOG's subtree — not its own —
   *  or it may be measured mid-zoom while the ancestor is still scaling.
   *
   *  NOTE: this intentionally differs from `WorktreePage.settledBoxOf`, which
   *  waits on the passed locator itself. Here the animation always lives on the
   *  ancestor dialog, so every measurement anchors on `this.dialog` regardless
   *  of which child is being measured. */
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

  /** Settled bounding box of the first (top) worktree row. */
  async firstOptionBox(): Promise<Box> {
    return this.settledBoxOf(this.options.first());
  }

  /** Settled bounding box of the last (bottom) worktree row. Used to prove
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

  /** Tap a row's pin/unpin button. This must NOT select the worktree —
   *  the dialog stays open and no navigation happens. */
  async togglePin(worktreeId: string): Promise<void> {
    await test.step(`Toggle pin for ${worktreeId}`, async () => {
      await this.pinButton(worktreeId).click();
    });
  }

  /** Select a worktree by clicking its row body (not the pin button). This
   *  navigates to the worktree and closes the dialog. */
  async select(worktreeId: string): Promise<void> {
    await test.step(`Select worktree ${worktreeId}`, async () => {
      // Click the row near its left edge (the label), away from the trailing
      // pin button on the right, so the click lands on the cmdk item body and
      // fires its onSelect.
      await this.item(worktreeId).click({ position: { x: 12, y: 12 } });
    });
  }

  /** Dismiss the dialog without selecting — Escape, the same affordance a
   *  user has to back out. */
  async dismiss(): Promise<void> {
    await test.step("Dismiss the worktree picker", async () => {
      await this.page.keyboard.press("Escape");
    });
  }
}
