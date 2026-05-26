/**
 * Page object for the Changes panel inside a workspace's shared dockview.
 *
 * Centralises the locators and the "navigate + seed expand-all + reload"
 * dance so individual spec files don't reach into `localStorage` /
 * `page.goto` directly. Per `CLAUDE.md` and the `write-integration-test`
 * skill, test bodies should drive UI exclusively through methods on a
 * page object — the test body stays focused on assertions instead of
 * setup plumbing.
 *
 * What lives here:
 *  - The diff scroller (matched via `getByTestId("diff-view__scroller")`).
 *  - The per-file header buttons (matched via `getByRole("button",
 *    { name: /<filename>\s+<status>/ })` — the file row exposes its
 *    filename + status as the button's accessible name).
 *  - The CodeMirror editor / scroller elements rendered inside each
 *    expanded file. These are 3rd-party CodeMirror class selectors
 *    (`.cm-editor`, `.cm-scroller`) — we don't own those names, but we
 *    encapsulate them here so the spec body never repeats the literal
 *    selector and a future CodeMirror upgrade flows through one file.
 *  - Setup helpers for the expand-all and split-mode localStorage flags
 *    (`band:diff-expand-all`, `band:diff-view-mode`), and the seed-and-
 *    reload step that activates them.
 */

import { type Locator, type Page, test } from "@playwright/test";

/** localStorage keys read on first paint by DiffView. */
const EXPAND_ALL_KEY = "band:diff-expand-all";
const VIEW_MODE_KEY = "band:diff-view-mode";

export type DiffViewMode = "unified" | "split";

export class ChangesPanelPage {
  /** Scroll container around the file rows — used to programmatically
   *  scroll the panel in the mount-once test. `data-testid` is set in
   *  DiffView.tsx so the locator stays anchored if the layout markup
   *  shifts around it. */
  readonly scroller: Locator;
  /** Every `.cm-editor` rendered inside the panel. In unified mode
   *  there's one per visible expanded file; in split mode each visible
   *  expanded file contributes two (one per side of the MergeView). */
  readonly cmEditors: Locator;
  /** Every `.cm-scroller` rendered inside the panel. Same per-file
   *  cardinality as `cmEditors`. The class is owned by CodeMirror; we
   *  hide that fact behind this locator so the test body doesn't
   *  reach for the literal class name. */
  readonly cmScrollers: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.scroller = page.getByTestId("diff-view__scroller");
    this.cmEditors = page.locator(".cm-editor");
    this.cmScrollers = page.locator(".cm-scroller");
  }

  /** Locate the diff-row header button for a specific filename + git
   *  status (e.g. `M` for modified). The accessible name is built from
   *  the disclosure arrow + filename + status badge in `LazyFileRow`
   *  (e.g. `▶ src/foo.ts M`), so we anchor on the leading `▶` to
   *  disambiguate from the file tree sidebar's same-named button,
   *  which exposes the bare `<filename> <status>` name. The role-name
   *  match is the locator the doctrine prefers over text / CSS. */
  fileRowButton(filename: string, status: string): Locator {
    // Escape `.` and other regex meta-characters in the filename so a
    // path like `src/foo.ts` doesn't accidentally match
    // `src/foo<anychar>ts`.
    const escapedFilename = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return this.page.getByRole("button", {
      name: new RegExp(`▶\\s+${escapedFilename}\\s+${status}`),
    });
  }

  /** Navigate to the workspace's Changes panel with one or more
   *  client-side defaults pre-seeded in `localStorage`. Uses
   *  `addInitScript` so the seed runs before any page script — DiffView
   *  reads `band:diff-view-mode` / `band:diff-expand-all` in
   *  `useState(getStoredViewMode)` / `useState(getStoredExpandAll)`
   *  during its FIRST render, so the seed has to land before that
   *  point or the lazy initializer captures the default (`unified` /
   *  `false`) and never re-reads.
   *
   *  The init script is keyed via the (filename, status) shape that
   *  comes from `JSON.stringify` so re-calling `openWorkspace` with
   *  different options on the same `Page` is idempotent — each call
   *  re-registers a new init script that runs on subsequent
   *  navigations (Playwright doesn't deregister old init scripts, so
   *  this would compose: last value wins because writes overwrite).
   */
  async openWorkspace(
    workspaceId: string,
    options: { expandAll?: boolean; viewMode?: DiffViewMode } = {},
  ): Promise<void> {
    const url = `${this.baseUrl}/workspace/${encodeURIComponent(workspaceId)}?token=${this.token}`;
    await test.step(`Open Changes panel for ${workspaceId}`, async () => {
      const { expandAll, viewMode } = options;
      if (expandAll != null || viewMode != null) {
        await this.page.addInitScript(
          ({ expandAll, viewMode, expandAllKey, viewModeKey }) => {
            if (expandAll != null) {
              localStorage.setItem(expandAllKey, expandAll ? "true" : "false");
            }
            if (viewMode != null) localStorage.setItem(viewModeKey, viewMode);
          },
          {
            expandAll,
            viewMode,
            expandAllKey: EXPAND_ALL_KEY,
            viewModeKey: VIEW_MODE_KEY,
          },
        );
      }
      await this.page.goto(url);
    });
  }

  /** Scroll the diff panel to a specific pixel offset. Used in the
   *  mount-once test to push a row well outside the IntersectionObserver
   *  rootMargin zone. */
  async scrollTo(offsetPx: number): Promise<void> {
    await this.scroller.evaluate((el, top) => {
      (el as HTMLDivElement).scrollTop = top;
    }, offsetPx);
  }

  /** Current `scrollTop` of the diff panel. Useful for polling on
   *  scroll commit without relying on `waitForTimeout`. */
  async scrollTop(): Promise<number> {
    return await this.scroller.evaluate((el) => (el as HTMLDivElement).scrollTop);
  }

  /** Count of currently-mounted `.cm-editor` elements across all
   *  visible file rows. Used as a direct proxy for mount-once: the
   *  count stays stable across scroll-away with mount-once, but drops
   *  under the pre-mount-once behaviour. */
  async mountedEditorCount(): Promise<number> {
    return await this.cmEditors.count();
  }

  /** Click the "Split view" / "Unified view" toggle. The buttons are
   *  rendered with aria-name "Split view" / "Unified view" by
   *  `DiffViewModeToggle`, so the role-name locator is the doctrine-
   *  preferred path. Using the visible toggle (rather than seeding
   *  localStorage) is more reliable across the app's auto-downgrade
   *  rules (e.g. `effectiveViewMode` collapses split → unified when the
   *  scroll container is narrower than `SPLIT_VIEW_MIN_WIDTH`) — the
   *  toggle exposes the same control surface the user has. */
  async setViewMode(mode: DiffViewMode): Promise<void> {
    const label = mode === "split" ? "Split view" : "Unified view";
    await this.page.getByRole("button", { name: label, exact: true }).click();
  }

  /** Mark the first rendered `.cm-editor` element with a JS property so
   *  later assertions can verify DOM identity preservation across
   *  scroll-away/back. If the editor is destroyed and re-mounted, the
   *  marker is lost on the new element. */
  async tagFirstEditor(marker: string): Promise<void> {
    await this.cmEditors.first().evaluate((el, value) => {
      (el as HTMLElement & { __bandMountOnceMarker?: string }).__bandMountOnceMarker = value;
    }, marker);
  }

  /** Read the marker set by `tagFirstEditor` from the first rendered
   *  `.cm-editor`. Returns `undefined` if the element no longer carries
   *  it (i.e. it's a fresh re-mount). */
  async firstEditorMarker(): Promise<string | undefined> {
    return await this.cmEditors
      .first()
      .evaluate(
        (el) => (el as HTMLElement & { __bandMountOnceMarker?: string }).__bandMountOnceMarker,
      );
  }

  /** Measurements of the first rendered `.cm-scroller` — used by the
   *  horizontal-scroll test. Returns the geometric properties as a
   *  single object so the test only pays one round-trip per assertion
   *  block. */
  async firstScrollerMetrics(): Promise<{
    scrollWidth: number;
    clientWidth: number;
    clientHeight: number;
    scrollHeight: number;
    computedOverflowX: string;
    computedOverflowY: string;
  }> {
    return await this.cmScrollers.first().evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      computedOverflowX: window.getComputedStyle(el).overflowX,
      computedOverflowY: window.getComputedStyle(el).overflowY,
    }));
  }

  /** Per-scroller metrics for ALL rendered `.cm-scroller` elements.
   *  Used by the split-mode assertion path — MergeView renders one
   *  scroller per side, and both should report horizontal-scroll
   *  capability for the fix to be considered complete. */
  async allScrollerMetrics(): Promise<
    Array<{
      scrollWidth: number;
      clientWidth: number;
      clientHeight: number;
      computedOverflowX: string;
    }>
  > {
    const handles = await this.cmScrollers.elementHandles();
    const out: Array<{
      scrollWidth: number;
      clientWidth: number;
      clientHeight: number;
      computedOverflowX: string;
    }> = [];
    for (const handle of handles) {
      out.push(
        await handle.evaluate((el) => ({
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          clientHeight: el.clientHeight,
          computedOverflowX: window.getComputedStyle(el).overflowX,
        })),
      );
    }
    return out;
  }

  /** Write to the first scroller's `scrollLeft` and read back the
   *  committed value. The round-trip is what the horizontal-scroll
   *  test uses to prove the scroller actually accepts horizontal
   *  scroll input (the pre-fix `overflow: visible` path silently
   *  clamps the write to 0). */
  async roundTripFirstScrollLeft(value: number): Promise<number> {
    return await this.cmScrollers.first().evaluate((el, target) => {
      el.scrollLeft = target;
      return el.scrollLeft;
    }, value);
  }
}
