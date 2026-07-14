/**
 * Page object for the Files tab's two-panel code browser (`CodeBrowserView`):
 * the explorer (file tree) column, the editor column, and the separator
 * between them.
 *
 * It owns the two behaviours the specs drive:
 *
 *   - **Docking side** — the "Files" toolbar's right-click context menu moves
 *     the explorer to the left or right edge of the tab
 *     (`band-file-tree-side:<workspaceId>`).
 *   - **Width** — the explorer is a fixed-*pixel* column
 *     (`band-file-tree-width-px:<workspaceId>`), so it must survive container
 *     resizes (maximize / restore) and side flips unchanged.
 *
 * Locators:
 *
 *   - `file-tree__toolbar`, `file-tree__move-left`, `file-tree__move-right` are
 *     BEM `data-testid`s we set in `CodeBrowserView.tsx`.
 *   - `file-tree`, `file-viewer` and `file-tree-separator` are the panel /
 *     separator elements. react-resizable-panels renders each element's `id`
 *     prop onto BOTH `id` and `data-testid`, so those testids come straight
 *     from the `<Panel id="file-tree">` / `<Panel id="file-viewer">` /
 *     `<Separator id="file-tree-separator">` declarations in the same file —
 *     a library-provided test hook, addressed by testid rather than by a CSS
 *     or `#id` selector.
 *
 * This is a SECONDARY page object (same shape as `FileTreesPage`): it owns no
 * routes and constructs no URLs, so it takes a `WorkspacePage` and delegates
 * navigation, tab activation and maximize/restore to it.
 */

import { type Locator, type Page, test } from "@playwright/test";
import type { WorkspacePage } from "./WorkspacePage";

/** localStorage keys written by `CodeBrowserView` (mirrors `fileTreeSideKey` /
 *  `fileTreeWidthKey` in the source — duplicated here rather than imported, so
 *  a rename in production has to be a conscious change on both sides). */
const SIDE_KEY_PREFIX = "band-file-tree-side:";
const WIDTH_PX_KEY_PREFIX = "band-file-tree-width-px:";
const COLLAPSED_KEY_PREFIX = "band-file-tree-collapsed:";
/** The key the width used to live under, holding PERCENTAGES. Production
 *  deliberately moved to the `-px` key so an old "15" (15%) can't be restored as
 *  a 15px explorer; the legacy-key scenario seeds this one. */
const LEGACY_WIDTH_KEY_PREFIX = "band-file-tree-width:";

export class CodeBrowserPage {
  constructor(
    private readonly page: Page,
    private readonly workspace: WorkspacePage,
  ) {}

  /** The "Files" header row of the explorer — the context-menu trigger for the
   *  move-explorer actions. */
  get toolbar(): Locator {
    return this.page.getByTestId("file-tree__toolbar");
  }

  get moveLeftMenuItem(): Locator {
    return this.page.getByTestId("file-tree__move-left");
  }

  get moveRightMenuItem(): Locator {
    return this.page.getByTestId("file-tree__move-right");
  }

  /** The explorer panel (`<Panel id="file-tree">`). */
  get explorerPanel(): Locator {
    return this.page.getByTestId("file-tree");
  }

  /** The editor panel (`<Panel id="file-viewer">`). */
  get editorPanel(): Locator {
    return this.page.getByTestId("file-viewer");
  }

  /** The drag handle between them (`<Separator id="file-tree-separator">`). */
  get separator(): Locator {
    return this.page.getByTestId("file-tree-separator");
  }

  /** The collapse/expand chevron that sits on the separator. It carries no
   *  text — it's the only button inside the separator, so a name-less
   *  `getByRole` scoped to that container resolves it (and is immune to the
   *  chevron flipping direction with the docking side). */
  get collapseToggle(): Locator {
    return this.separator.getByRole("button");
  }

  /** Activate the outer Files tab and wait for the desktop side-by-side layout
   *  to mount. Anchors on the EDITOR panel, which is present whether or not the
   *  explorer is collapsed — a collapsed explorer is laid out at 0px, i.e.
   *  "hidden" as far as Playwright is concerned, so anchoring on it would hang
   *  exactly in the tests that reload with the explorer collapsed. */
  async openFilesTab(): Promise<void> {
    await test.step("Open the Files tab", async () => {
      await this.workspace.activateTab("files");
      await this.editorPanel.waitFor({ state: "visible", timeout: 15_000 });
    });
  }

  /** Bounding box of the explorer panel. Waits for it to be laid out first, so
   *  callers measuring right after a mount / remount don't race the layout. */
  async explorerBox(): Promise<{ x: number; width: number }> {
    await this.explorerPanel.waitFor({ state: "visible", timeout: 15_000 });
    const box = await this.explorerPanel.boundingBox();
    if (!box) throw new Error("Explorer panel has no bounding box (not rendered?)");
    return { x: box.x, width: box.width };
  }

  /** The explorer's width WITHOUT waiting for it to be visible — 0 when the
   *  panel is collapsed (`collapsedSize="0%"`, so it stays in the DOM at zero
   *  width). The counterpart of `explorerBox()` for collapse assertions. */
  async explorerWidthOrZero(): Promise<number> {
    const box = await this.explorerPanel.boundingBox();
    return box?.width ?? 0;
  }

  /** Whether the explorer is currently collapsed (laid out at zero width). */
  async isExplorerCollapsed(): Promise<boolean> {
    return (await this.explorerWidthOrZero()) < 1;
  }

  /** Bounding box of the editor panel. */
  async editorBox(): Promise<{ x: number; width: number }> {
    const box = await this.editorPanel.boundingBox();
    if (!box) throw new Error("Editor panel has no bounding box (not rendered?)");
    return { x: box.x, width: box.width };
  }

  async explorerWidth(): Promise<number> {
    return (await this.explorerBox()).width;
  }

  async editorWidth(): Promise<number> {
    return (await this.editorBox()).width;
  }

  /** Whether the explorer currently sits to the RIGHT of the editor. The
   *  geometric, user-observable signal for the docking side: the Group renders
   *  its children in DOM order (tree, separator, viewer — or the reverse), so
   *  the panels' `x` offsets are what the user actually sees. */
  async explorerIsRightOfEditor(): Promise<boolean> {
    const [explorer, editor] = await Promise.all([this.explorerBox(), this.editorBox()]);
    return explorer.x > editor.x;
  }

  /** Where the SEPARATOR sits relative to the editor. Same signal as
   *  `explorerIsRightOfEditor`, but it still works when the explorer is
   *  collapsed to 0px and therefore has no bounding box at all — which is the
   *  only way to prove the `key={treeSide}` remount re-ordered the panels while
   *  the explorer stays collapsed. */
  async separatorIsRightOfEditor(): Promise<boolean> {
    const sep = await this.separator.boundingBox();
    if (!sep) throw new Error("Separator has no bounding box (not rendered?)");
    return sep.x > (await this.editorBox()).x;
  }

  /** Right-click the "Files" toolbar and dock the explorer to `side`. Drives
   *  the exact surface the user does: the Radix context menu on the toolbar. */
  async moveExplorer(side: "left" | "right"): Promise<void> {
    await test.step(`Move the explorer to the ${side}`, async () => {
      await this.toolbar.click({ button: "right" });
      const item = side === "left" ? this.moveLeftMenuItem : this.moveRightMenuItem;
      await item.waitFor({ state: "visible" });
      await item.click();
      // The Group is keyed on the side, so it fully remounts. Waiting for the
      // menu to leave the DOM keeps a back-to-back move from clicking a portal
      // that is still fading out. Anchor the remount on the editor panel, not
      // the explorer — the explorer has no box while collapsed.
      await item.waitFor({ state: "hidden" });
      await this.editorPanel.waitFor({ state: "visible" });
    });
  }

  async moveExplorerRight(): Promise<void> {
    await this.moveExplorer("right");
  }

  async moveExplorerLeft(): Promise<void> {
    await this.moveExplorer("left");
  }

  /** Drag the separator horizontally by `dx` CSS px — a real mouse press /
   *  move / release, so it goes through react-resizable-panels' pointer
   *  resize path exactly as a user's drag does. */
  async dragSeparatorBy(dx: number): Promise<void> {
    await test.step(`Drag the explorer separator by ${dx}px`, async () => {
      const box = await this.separator.boundingBox();
      if (!box) throw new Error("Separator has no bounding box (not rendered?)");
      // Grab the separator BELOW its midpoint: the 28px collapse chevron is
      // absolutely positioned at the centre with `z-10` and is revealed by the
      // hover that `mouse.move` itself triggers, so pressing at the exact centre
      // presses the button, not the handle.
      const y = box.y + box.height * 0.85;
      const startX = box.x + box.width / 2;
      await this.page.mouse.move(startX, y);
      await this.page.mouse.down();
      // Intermediate steps: the resize handler tracks pointermove, and a single
      // jump can be coalesced or land outside the drag threshold.
      await this.page.mouse.move(startX + dx / 2, y, { steps: 5 });
      await this.page.mouse.move(startX + dx, y, { steps: 5 });
      await this.page.mouse.up();
    });
  }

  /** The FileTabBar's "Show / Hide File Explorer" button (`data-testid` set in
   *  `FileTabBar.tsx`). Rendered whenever at least one editor tab is open — it
   *  is the affordance the user has for RE-opening a collapsed explorer, which
   *  is why `CodeBrowserView` auto-expands the tree when the last tab closes. */
  get tabBarTreeToggle(): Locator {
    return this.page.getByTestId("file-tab-bar__tree-toggle");
  }

  /** Collapse / expand the explorer through the tab bar's tree-toggle button.
   *
   *  This — not the separator chevron — is the toggle the specs drive, because
   *  the chevron is unreachable once the explorer IS collapsed: the panel
   *  shrinks to 0px, the chevron lands on the Files group's outer edge, and
   *  dockview's own `.dv-sash` (the handle between the two dockview groups)
   *  sits on top of it and swallows the click. Verified in Chromium — Playwright
   *  reports `<div class="dv-sash dv-enabled"> … intercepts pointer events`. */
  async toggleExplorerCollapsed(): Promise<void> {
    await test.step("Toggle the explorer via the tab bar's tree-toggle button", async () => {
      await this.tabBarTreeToggle.click();
    });
  }

  /** Collapse the explorer via the separator's chevron — the OTHER affordance,
   *  covered so the chevron's collapse direction doesn't rot. Only valid while
   *  the explorer is expanded (see `toggleExplorerCollapsed`). */
  async collapseExplorerViaSeparatorChevron(): Promise<void> {
    await test.step("Collapse the explorer via the separator chevron", async () => {
      await this.collapseToggle.click();
    });
  }

  /** Resize the browser window to `width` (keeping the current height) — a real
   *  window resize, which is what drives a container-driven `onResize` of the
   *  explorer panel (as opposed to a user-driven separator drag).
   *
   *  Callers that need the Group to stay mounted must keep the Files tab's own
   *  container above CodeBrowserView's 600px mobile threshold; that container is
   *  roughly half the width left over after the project sidebar, so a viewport
   *  around 1700px still leaves it comfortably desktop. */
  async setWindowWidth(width: number): Promise<void> {
    await test.step(`Resize the window to ${width}px wide`, async () => {
      const size = this.page.viewportSize();
      if (!size) throw new Error("No viewport size — cannot resize");
      await this.page.setViewportSize({ width, height: size.height });
    });
  }

  /** Force the `key={treeSide}` Group to REMOUNT without changing the docking
   *  side: narrow the window until the Files tab's own container drops under
   *  `CodeBrowserView`'s 600px threshold (the desktop Group unmounts in favour
   *  of the mobile single-column layout), then restore it.
   *
   *  This is the remount path the specs can actually drive while the explorer is
   *  COLLAPSED. The other one — flipping the docking side — is unreachable in
   *  that state: its context-menu trigger is the "Files" toolbar, which lives
   *  *inside* the 0px-wide collapsed panel and can't be right-clicked.
   *
   *  1100px keeps the workspace in its desktop layout (`useIsDesktop()` is
   *  ≥1024) while squeezing the Files group itself below 600px, so only the
   *  CodeBrowserView Group remounts — the dockview around it stays put. */
  async remountGroupViaWindowResize(): Promise<void> {
    await test.step("Remount the explorer Group by narrowing and restoring the window", async () => {
      const size = this.page.viewportSize();
      if (!size) throw new Error("No viewport size — cannot resize");
      await this.page.setViewportSize({ width: 1100, height: size.height });
      // The mobile branch renders no `Panel`s at all: the editor panel leaving
      // the DOM is the proof the Group actually unmounted.
      await this.editorPanel.waitFor({ state: "detached", timeout: 15_000 });
      await this.page.setViewportSize(size);
      await this.editorPanel.waitFor({ state: "visible", timeout: 15_000 });
    });
  }

  /** Maximize the outer dockview group that hosts the Files tab — the
   *  container-widening event the fixed-pixel width has to survive. */
  async maximizeFilesGroup(): Promise<void> {
    await this.workspace.maximizeGroupContaining("files");
  }

  /** Exit maximize (delegates to the shared header Restore button). */
  async restoreFilesGroup(): Promise<void> {
    await this.workspace.restorePanel();
  }

  /** The persisted docking side. `null` when nothing has been written yet
   *  (production then defaults to "left"). */
  async readPersistedSide(workspaceId: string): Promise<string | null> {
    return await this.page.evaluate(([prefix, id]) => localStorage.getItem(`${prefix}${id}`), [
      SIDE_KEY_PREFIX,
      workspaceId,
    ] as const);
  }

  /** The persisted explorer width in px. `null` when nothing has been written
   *  yet. Returned as a number so specs can compare it against a measured
   *  bounding box. */
  async readPersistedWidthPx(workspaceId: string): Promise<number | null> {
    const raw = await this.page.evaluate(([prefix, id]) => localStorage.getItem(`${prefix}${id}`), [
      WIDTH_PX_KEY_PREFIX,
      workspaceId,
    ] as const);
    return raw === null ? null : Number(raw);
  }

  /** The persisted collapsed flag. `null` when nothing has been written yet
   *  (production then defaults to expanded). */
  async readPersistedCollapsed(workspaceId: string): Promise<string | null> {
    return await this.page.evaluate(([prefix, id]) => localStorage.getItem(`${prefix}${id}`), [
      COLLAPSED_KEY_PREFIX,
      workspaceId,
    ] as const);
  }

  /** Seed the LEGACY width key (`band-file-tree-width:<wsId>`, whose values were
   *  PERCENTAGES) before the app mounts. Uses `addInitScript`, so it MUST be
   *  called before `goto`. Exists to prove the deliberate key rename: a stored
   *  "15" (meaning 15%) must not come back as a 15px explorer. */
  async seedLegacyWidthValue(workspaceId: string, value: string): Promise<void> {
    await this.page.addInitScript(
      ([prefix, id, v]) => {
        localStorage.setItem(`${prefix}${id}`, v);
      },
      [LEGACY_WIDTH_KEY_PREFIX, workspaceId, value] as const,
    );
  }
}
