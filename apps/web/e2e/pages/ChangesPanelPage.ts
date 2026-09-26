/**
 * Page object for the Changes UI of the unified workspace layout (#643):
 *
 *   - The Changes tab of the right sidepanel (`RightSidepanel.tsx`), which
 *     holds the diff-target picker (`right-sidepanel__diff-target-select`)
 *     and the changed-file tree (`changes-tree__row--<path>` rows).
 *   - The per-file `diff` leaf a changed-file click opens in the center
 *     dockview (`center-diff-leaf__visible-*`), with its unified / split
 *     toggle (`center-diff-leaf__view--unified|split`).
 *
 * This replaces the page object for the retired monolithic `DiffView`, which
 * stacked every changed file in one lazily-mounted scroller. Nothing renders
 * that component any more, so its `diff-view__*` testids are gone from the
 * page.
 *
 * Revealing the sidepanel and selecting its tab is delegated to
 * `WorkspacePage` rather than re-deriving those testids here.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { FindWidget } from "./FindWidget";
import { WorkspacePage } from "./WorkspacePage";

export type DiffViewMode = "unified" | "split";

/** Testid of the "Uncommitted" entry in the diff-target dropdown. Exposed so
 *  specs assert its position by id rather than by the localisable label. */
export const UNCOMMITTED_OPTION_TESTID = "right-sidepanel__diff-target-option-uncommitted";

export class ChangesPanelPage {
  /** The diff-target `<Select>` trigger in the Changes tab. Its rendered text
   *  is the selected target (e.g. "Uncommitted" or a branch name). */
  readonly diffTargetTrigger: Locator;
  /** First option in the open diff-target dropdown. */
  readonly firstDiffTargetOption: Locator;
  /** The body of the visible `diff` leaf. Scopes the CodeMirror locators below
   *  so they can't pick up an editor from some other leaf. */
  readonly diffLeaf: Locator;
  /** Every `.cm-scroller` inside the visible diff leaf. Unified mode renders
   *  one; split mode (MergeView) renders two, one per side.
   *
   *  FRAGILITY: `.cm-scroller` is a class owned by CodeMirror, which exposes
   *  no testid hook on its own DOM. Centralised here so a CodeMirror upgrade
   *  that renames it flows through one file. */
  readonly cmScrollers: Locator;
  /** The diff leaf's vertical scroller, which holds the editor(s). */
  readonly diffScroller: Locator;
  /** The overview ruler down the diff scroller's right edge. */
  readonly overviewRuler: Locator;

  private readonly workspace: WorkspacePage;
  /** Workspace opened via `goto`, remembered so `diffMode()` can build the
   *  per-workspace `band:diff-mode:<id>` localStorage key. */
  private currentWorkspaceId: string | null = null;

  constructor(
    private readonly page: Page,
    baseUrl: string,
    token: string,
  ) {
    this.workspace = new WorkspacePage(page, baseUrl, token);
    this.diffTargetTrigger = page.getByTestId("right-sidepanel__diff-target-select");
    this.firstDiffTargetOption = page.getByRole("option").first();
    this.diffLeaf = page.getByTestId("center-diff-leaf__visible-true");
    this.cmScrollers = this.diffLeaf.locator(".cm-scroller");
    this.diffScroller = this.diffLeaf.getByTestId("center-diff-leaf__scroller");
    this.overviewRuler = this.diffLeaf.getByTestId("diff-overview-ruler");
  }

  /** Navigate to the workspace, reveal the right sidepanel, and select its
   *  Changes tab. The sidepanel defaults to Explorer, and only the active
   *  tab's body is mounted, so the picker and tree exist only after this. */
  async goto(workspaceId: string): Promise<void> {
    this.currentWorkspaceId = workspaceId;
    await this.workspace.goto(workspaceId);
    await this.workspace.waitForReady();
    await this.workspace.revealRightPanel();
    await this.workspace.selectRightPanelTab("changes");
    await expect(this.workspace.changesSection).toBeVisible({ timeout: 15_000 });
  }

  /** The floating find widget of the visible diff leaf. */
  get diffFindWidget(): FindWidget {
    return new FindWidget(this.diffLeaf);
  }

  // ---- Commits panel (bottom of the Changes tab) ----

  /** The Commits section below the changed-file tree. */
  get commitsPanel(): Locator {
    return this.page.getByTestId("commits-panel");
  }

  /** The Commits header button that collapses / expands the section. */
  get commitsToggle(): Locator {
    return this.page.getByTestId("commits-panel__toggle");
  }

  /** The loaded-commit count in the Commits header (`50+` when more exist). */
  get commitsCount(): Locator {
    return this.page.getByTestId("commits-panel__count");
  }

  /** The scrollable commit list; absent while the section is collapsed. */
  get commitsList(): Locator {
    return this.page.getByTestId("commits-panel__list");
  }

  /** A commit row, keyed by full SHA. */
  commitRow(sha: string): Locator {
    return this.page.getByTestId(`commits-panel__row--${sha}`);
  }

  /** A ref pill (branch / remote / tag name) inside a commit row. */
  commitRef(sha: string, name: string): Locator {
    return this.commitRow(sha).getByTestId(`commits-panel__ref--${name}`);
  }

  /** The "+N" marker for refs that did not fit in a commit row. */
  commitMoreRefs(sha: string): Locator {
    return this.commitRow(sha).getByTestId("commits-panel__more-refs");
  }

  /** A changed file listed under an expanded commit. */
  commitFile(sha: string, path: string): Locator {
    return this.page
      .getByTestId(`commits-panel__files--${sha}`)
      .getByTestId(`commits-panel__file--${path}`);
  }

  /** The dockview tab of a file's diff. A commit's diff tab carries the
   *  commit SHA in `data-commit`; a working-tree diff tab has none. */
  diffTab(path: string): Locator {
    return this.workspace.diffTab(path);
  }

  /** Close the diff tab for `path` with its close button. */
  async closeDiffTab(path: string): Promise<void> {
    await test.step(`Close the diff tab for ${path}`, async () => {
      await this.diffTab(path).getByRole("button", { name: "Close diff" }).click();
    });
  }

  /** Expand a commit row to list its changed files. */
  async expandCommit(sha: string): Promise<void> {
    await test.step(`Expand commit ${sha.slice(0, 7)}`, async () => {
      await this.commitRow(sha).click();
      await expect(this.commitRow(sha)).toHaveAttribute("aria-expanded", "true");
    });
  }

  /** Open `path`'s diff for commit `sha` from the expanded commit. */
  async openCommitFile(sha: string, path: string): Promise<void> {
    await test.step(`Open ${path} at ${sha.slice(0, 7)}`, async () => {
      await this.commitFile(sha, path).click();
      await expect(this.diffLeaf).toBeVisible({ timeout: 15_000 });
    });
  }

  async toggleCommits(): Promise<void> {
    await test.step("Toggle the Commits section", async () => {
      await this.commitsToggle.click();
    });
  }

  /** Scroll the commit list to its end, which loads the next page. */
  async scrollCommitsToEnd(): Promise<void> {
    await test.step("Scroll the commit list to the end", async () => {
      await this.commitsList.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
    });
  }

  /** Reload the page and reopen the Changes tab. */
  async reload(): Promise<void> {
    await test.step("Reload the workspace", async () => {
      await this.page.reload();
      await this.workspace.waitForReady();
      await this.workspace.revealRightPanel();
      await this.workspace.selectRightPanelTab("changes");
      await expect(this.workspace.changesSection).toBeVisible({ timeout: 15_000 });
    });
  }

  /** A changed-file row in the Changes tree, keyed by workspace-relative path. */
  changesTreeRow(path: string): Locator {
    return this.page.getByTestId(`changes-tree__row--${path}`);
  }

  /** Open `path`'s per-file diff leaf from the Changes tree and put it in
   *  `viewMode`. Clicks the view toggle for both modes rather than relying on
   *  the stored default, so the mode under test is set explicitly. Waits for
   *  CodeMirror to mount the expected number of scrollers (1 unified, 2 split)
   *  so callers can measure immediately. */
  async openDiff(path: string, viewMode: DiffViewMode): Promise<void> {
    await test.step(`Open ${viewMode} diff for ${path}`, async () => {
      await this.changesTreeRow(path).click();
      await expect(this.diffLeaf).toBeVisible({ timeout: 15_000 });
      await this.page.getByTestId(`center-diff-leaf__view--${viewMode}`).click();
      await expect(this.cmScrollers).toHaveCount(viewMode === "split" ? 2 : 1, {
        timeout: 15_000,
      });
    });
  }

  /** The selected diff mode as a stable enum (`"uncommitted"` | `"branch"`),
   *  read from the per-workspace `band:diff-mode:<id>` localStorage key that
   *  `useDiffTarget` mirrors the mode into. Reading persisted client state
   *  keeps this black-box and avoids the localisable trigger label. Falls back
   *  to `"uncommitted"` when the key is absent, which is the app's own default
   *  for a fresh workspace where nothing has been written yet. */
  async diffMode(): Promise<string> {
    if (!this.currentWorkspaceId) {
      throw new Error("diffMode() called before goto()");
    }
    return await this.page.evaluate((workspaceId) => {
      const v = localStorage.getItem(`band:diff-mode:${workspaceId}`);
      return v === "uncommitted" || v === "branch" ? v : "uncommitted";
    }, this.currentWorkspaceId);
  }

  /** Open the diff-target dropdown. Radix renders the listbox into a portal
   *  and re-renders it as the branch list arrives, so callers open ONCE here
   *  and then poll `visibleDiffTargetOptions()`. Re-clicking the trigger in a
   *  poll loop would toggle it shut. */
  async openDiffTargetDropdown(): Promise<void> {
    await test.step("Open diff-target dropdown", async () => {
      await this.diffTargetTrigger.click();
      await expect(this.firstDiffTargetOption).toBeVisible({ timeout: 10_000 });
    });
  }

  /** Every option label in the open diff-target dropdown, in DOM order. Each
   *  `<SelectItem>` has `role="option"`; the `<SelectSeparator>` is
   *  `role="separator"` and is excluded. Doesn't click, so it's safe inside
   *  `expect.poll` while the branch list settles. */
  async visibleDiffTargetOptions(): Promise<string[]> {
    return (await this.page.getByRole("option").allTextContents()).map((t) => t.trim());
  }

  /** Write `target` to the Nth diff scroller's `scrollLeft` and read back what
   *  the browser committed. A scroller that can't scroll horizontally clamps
   *  the write to 0, so a non-zero read is the direct behavioural check. */
  async roundTripScrollLeftAt(index: number, target: number): Promise<number> {
    return await this.cmScrollers.nth(index).evaluate((el, value) => {
      el.scrollLeft = value;
      return el.scrollLeft;
    }, target);
  }

  /** Metrics for every diff scroller in the visible leaf, in one round trip.
   *  `scrollHeight` is included so specs can assert it matches
   *  `clientHeight`, the natural-height guard from PR #501. */
  async allScrollerMetrics(): Promise<
    Array<{
      scrollWidth: number;
      clientWidth: number;
      clientHeight: number;
      scrollHeight: number;
      computedOverflowX: string;
    }>
  > {
    return await this.cmScrollers.evaluateAll((els) =>
      els.map((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        computedOverflowX: window.getComputedStyle(el).overflowX,
      })),
    );
  }

  /** The overview-ruler markers of one change kind, top to bottom. */
  rulerMarkers(kind: "added" | "removed" | "modified"): Locator {
    return this.overviewRuler.getByTestId(`diff-overview-ruler__marker--${kind}`);
  }

  /** Vertical center of every marker of `kind`, in px from the top of the
   *  ruler, so specs can compare where changes sit in the file. */
  async rulerMarkerCenters(kind: "added" | "removed" | "modified"): Promise<number[]> {
    const ruler = await this.overviewRuler.boundingBox();
    if (!ruler) return [];
    const centers: number[] = [];
    for (const marker of await this.rulerMarkers(kind).all()) {
      const box = await marker.boundingBox();
      if (box) centers.push(box.y + box.height / 2 - ruler.y);
    }
    return centers;
  }

  /** Click the first ruler marker of `kind`. Markers let clicks through to the
   *  ruler track, which resolves the marker under the pointer, so this clicks
   *  the track at the marker's position the way a user's click lands. */
  async clickRulerMarker(kind: "added" | "removed" | "modified"): Promise<void> {
    await test.step(`Click the ${kind} ruler marker`, async () => {
      const [center] = await this.rulerMarkerCenters(kind);
      if (center === undefined) throw new Error(`no ${kind} marker on the ruler`);
      const ruler = await this.overviewRuler.boundingBox();
      await this.overviewRuler.click({ position: { x: (ruler?.width ?? 12) / 2, y: center } });
    });
  }

  /** Click the ruler track at `fraction` (0 = top, 1 = bottom) of its height. */
  async clickRulerTrack(fraction: number): Promise<void> {
    await test.step(`Click the ruler track at ${Math.round(fraction * 100)}%`, async () => {
      const ruler = await this.overviewRuler.boundingBox();
      if (!ruler) throw new Error("overview ruler is not visible");
      await this.overviewRuler.click({
        position: { x: ruler.width / 2, y: ruler.height * fraction },
      });
    });
  }

  /** Drag the ruler's slider down by `dy` pixels with the mouse. */
  async dragRulerSlider(dy: number): Promise<void> {
    await test.step(`Drag the ruler slider by ${dy}px`, async () => {
      const box = await this.overviewRuler.getByTestId("diff-overview-ruler__slider").boundingBox();
      if (!box) throw new Error("overview ruler slider is not visible");
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await this.page.mouse.move(x, y);
      await this.page.mouse.down();
      await this.page.mouse.move(x, y + dy, { steps: 5 });
      await this.page.mouse.up();
    });
  }

  /** A line of the diff by its exact text. Specs pass fixture text they
   *  wrote themselves, so matching on text is stable here.
   *
   *  FRAGILITY: `.cm-line` is a class owned by CodeMirror, which exposes no
   *  testid hook on its own DOM. Centralised here so a CodeMirror upgrade
   *  that renames it flows through one file. */
  diffLine(text: string): Locator {
    return this.diffLeaf.locator(".cm-line").getByText(text, { exact: true }).first();
  }

  /** The diff scroller's current vertical scroll offset. */
  async diffScrollTop(): Promise<number> {
    return await this.diffScroller.evaluate((el) => el.scrollTop);
  }

  /** The diff scroller's scroll range: content height and visible height. */
  async diffScrollRange(): Promise<{ scrollHeight: number; clientHeight: number }> {
    return await this.diffScroller.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
  }
}
