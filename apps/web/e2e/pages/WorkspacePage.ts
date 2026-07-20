/**
 * Page object for the workspace dockview route (`/workspace/:id`).
 *
 * Owns the locators for the shared dockview's header buttons (Maximize /
 * Restore) and provides high-level actions (`maximizePanel`,
 * `restorePanel`) plus helpers for reading client-side persisted state
 * out of `localStorage`.
 *
 * The aria-label values "Maximize" / "Restore" are set in
 * `SharedDockviewLayout.tsx` (`MainGroupRightActions`) — system-
 * controlled, not localised user copy — so `getByRole({ name })` is the
 * preferred locator.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { LABEL_FILTER_KEY, LABEL_LAST_WORKSPACE_KEY } from "@/dashboard";

/** localStorage key prefix used by `SharedDockviewLayout` for per-workspace
 *  state (matches `ACTIVE_STATE_KEY_PREFIX` in the source). */
const ACTIVE_STATE_KEY_PREFIX = "band:dockview-active:";

export interface SavedActiveState {
  activeGroup?: string;
  groups: Record<string, string>;
  maximizedGroup?: string;
}

export class WorkspacePage {
  /** All "Maximize" buttons in the dockview. Multiple groups expose
   *  their own button; tests use `.first()` / `.nth()` when they need a
   *  specific group. */
  readonly maximizeButtons: Locator;
  /** "Restore" button — only present when SOME group is maximized. */
  readonly restoreButton: Locator;
  /** Terminal panel's input textbox — visible only when the terminal
   *  tab is the active view in its group AND that group isn't hidden
   *  behind a maximize. Used as a DOM-level proof that the terminal
   *  tab is showing. */
  readonly terminalInput: Locator;
  /** "Files changed" heading inside the Changes panel — visible when
   *  the Changes tab is active in its group. Counterpart of
   *  `terminalInput` for the "wrong tab leaked across workspaces"
   *  regression assertion. */
  readonly changesHeading: Locator;
  /** "Delete workspace" menu item inside the WorkspaceCard's context
   *  menu (right-click). Only present for non-default branches of git
   *  projects. Used by the cache-eviction regression test (issue #508). */
  readonly deleteWorkspaceMenuItem: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.maximizeButtons = page.getByRole("button", { name: "Maximize" });
    this.restoreButton = page.getByRole("button", { name: "Restore" });
    this.terminalInput = page.getByRole("textbox", { name: "Terminal input" });
    this.changesHeading = page.getByRole("heading", { name: "Files changed" });
    this.deleteWorkspaceMenuItem = page.getByRole("menuitem", { name: "Delete workspace" });
  }

  /** Locate a workspace card in the project-list sidebar by its canonical
   *  workspaceId. The `data-testid` is set by `WorkspaceCard` (see issue
   *  #508 for the rationale) so a test can drive the per-card context
   *  menu without depending on visible text that may differ by project. */
  workspaceCard(workspaceId: string): Locator {
    return this.page.getByTestId(`project-list__workspace-card--${workspaceId}`);
  }

  /** The root (default-branch) workspace card's house icon — the identity
   *  marker `AgentStatusIndicator` renders as its idle fallback for the root
   *  card. `data-testid` set on the lucide `Home` glyph in `WorkspaceCard`.
   *  Scoped to the card so it never matches another project's root. Present
   *  only while the root agent is idle; a live status replaces it with the
   *  status dot — mirroring how the branch glyph is replaced on non-root
   *  cards. */
  rootWorkspaceHomeIcon(workspaceId: string): Locator {
    return this.workspaceCard(workspaceId).getByTestId("workspace-card__home-icon");
  }

  /** The agent status dot inside a workspace card. `data-testid` set on the
   *  dot `<span>` in `AgentStatusIndicator`, shown only when the agent status
   *  is "working" / "needs_attention". Scoped to the card. */
  agentStatusDot(workspaceId: string): Locator {
    return this.workspaceCard(workspaceId).getByTestId("workspace-card__agent-status");
  }

  /** Set a workspace's agent status via the real `statuses.update` tRPC
   *  mutation (the same procedure the dashboard uses), which emits an SSE
   *  update the mounted status watcher consumes — so the card re-renders
   *  live, the way it would in production. Auth via the `band_token` cookie,
   *  matching the other tRPC HTTP helpers. */
  async setAgentStatus(workspaceId: string, status: string): Promise<void> {
    await test.step(`Set agent status of ${workspaceId} to ${status}`, async () => {
      const res = await this.page.request.post(`${this.baseUrl}/trpc/statuses.update`, {
        headers: {
          "Content-Type": "application/json",
          Cookie: `band_token=${this.token}`,
        },
        data: { workspaceId, agent: { status } },
      });
      if (!res.ok()) {
        throw new Error(
          `setAgentStatus(${workspaceId}, ${status}) failed: ${res.status()} ${await res.text()}`,
        );
      }
    });
  }

  /** Locate the per-panel-host cached entry div for the given workspaceId
   *  (issue #508). `MultiWorkspacePanelHost` renders one of these per
   *  workspace it currently caches; the test asserts on their presence /
   *  absence to verify the LRU map's contents through a public DOM
   *  surface, without exporting internals. There are multiple panel
   *  hosts (chat / changes / files / terminal / browser), so each cached
   *  workspaceId can produce up to five matching elements — the test
   *  cares about "any" vs "none", not exact count. */
  cachedPanelEntries(workspaceId: string): Locator {
    return this.page.getByTestId(`workspace-panel-host__cached-entry--${workspaceId}`);
  }

  /** Locator for the chat tab panel's visibility marker inside a specific
   *  workspace's cached panel host (issue #469). The marker testid is set
   *  by `ChatTabContent` in `DockviewChatContainer.tsx` and encodes the
   *  visibility signal the shared `PanelVisibilityContext` propagated
   *  into the tab — so the test can observe context plumbing directly,
   *  independent of dockview's outer detach behaviour.
   *
   *  Scoping the locator to the workspace's cached entry lets a test
   *  query workspace A's marker and workspace B's marker independently
   *  even when both are mounted (active + cached) at once. */
  chatTabVisibilityMarker(workspaceId: string, visible: boolean): Locator {
    return this.cachedPanelEntries(workspaceId).getByTestId(
      `dockview-chat-tab__visible-${visible ? "true" : "false"}`,
    );
  }

  /** Locator for the terminal tab panel's visibility marker inside a
   *  specific workspace's cached panel host (issue #469). Counterpart of
   *  `chatTabVisibilityMarker` for the terminal container — see that
   *  method's doc comment for the rationale. */
  terminalTabVisibilityMarker(workspaceId: string, visible: boolean): Locator {
    return this.cachedPanelEntries(workspaceId).getByTestId(
      `dockview-terminal-tab__visible-${visible ? "true" : "false"}`,
    );
  }

  /** Right-click the workspace card to open its context menu, then click
   *  "Delete workspace". The deletion goes through the real
   *  `useRemoveWorkspace` mutation — same path the user takes — so the
   *  reconcile-against-projects effect this test guards must actually
   *  fire end-to-end. */
  async deleteWorkspaceFromSidebar(workspaceId: string): Promise<void> {
    await test.step(`Delete workspace ${workspaceId} via sidebar context menu`, async () => {
      await this.workspaceCard(workspaceId).click({ button: "right" });
      await this.deleteWorkspaceMenuItem.click();
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Project-list context menu (zoom regression — context menu disappears /
  // mispositions under app zoom). Locators + actions so the spec body never
  // touches raw `page.*`.
  // ──────────────────────────────────────────────────────────────────────

  /** A project header row in the sidebar. `data-testid` is set by the
   *  `SortableProject` component that renders each project header. */
  projectHeader(projectName: string): Locator {
    return this.page.getByTestId(`project-list__project-header--${projectName}`);
  }

  /** The currently-open context menu (Radix `role="menu"`). */
  get contextMenu(): Locator {
    return this.page.getByRole("menu");
  }

  /** The "Add workspace" item — the first action in a git project's menu,
   *  shared by the right-click context menu and the "⋮" dropdown. Located by
   *  `data-testid` rather than its localisable visible text. */
  get addWorkspaceMenuItem(): Locator {
    return this.page.getByTestId("project-list__action--add-workspace");
  }

  /** The New Workspace dialog opened by the "Add workspace" action — the
   *  observable side effect used to prove whether the action fired. */
  get newWorkspaceDialog(): Locator {
    return this.page.getByTestId("new-workspace-form__dialog");
  }

  /** The header's "⋮" project-actions button (revealed on hover / focus). */
  projectMenuTrigger(projectName: string): Locator {
    return this.page.getByTestId(`project-list__project-menu-trigger--${projectName}`);
  }

  /** Right-click a project header to open its context menu. */
  async openProjectContextMenu(projectName: string): Promise<void> {
    await test.step(`Open context menu for project ${projectName}`, async () => {
      await this.projectHeader(projectName).click({ button: "right" });
    });
  }

  /** Open a project's action menu via the header "⋮" button: hover the row to
   *  reveal the button, then left-click it. Distinct from the right-click
   *  `openProjectContextMenu`. */
  async openProjectMenuViaKebab(projectName: string): Promise<void> {
    await test.step(`Open project menu via kebab for ${projectName}`, async () => {
      await this.projectHeader(projectName).hover();
      await this.projectMenuTrigger(projectName).click();
    });
  }

  /** Apply a browser zoom factor on `<body>` — the legacy reproduction path
   *  for the disappearing-menu bug. */
  async applyBodyZoom(factor: number): Promise<void> {
    await test.step(`Apply body zoom ${factor}`, async () => {
      await this.page.evaluate((z) => {
        document.body.style.zoom = String(z);
      }, factor);
    });
  }

  /** Apply an app-wide zoom the way production does: set CSS `zoom` on
   *  `<html>` and mirror the factor onto the `--app-zoom` custom property,
   *  which the global popper counter-scale rule keys off so menus stay
   *  anchored at the cursor under zoom. */
  async applyAppZoom(factor: number): Promise<void> {
    await test.step(`Apply app zoom ${factor}`, async () => {
      await this.page.evaluate((z) => {
        document.documentElement.style.zoom = String(z);
        document.documentElement.style.setProperty("--app-zoom", String(z));
      }, factor);
    });
  }

  /** Zoom the app in by one step via the real production keyboard shortcut
   *  (Ctrl/Cmd+=). In browser mode `useZoom` (mounted in `__root.tsx`) handles
   *  this keydown and calls `zoomIn()` → `applyZoomLevel()`, which dispatches
   *  the `band:zoom-changed` event that every mounted `TerminalPanel` reacts to
   *  (re-measuring + re-attaching its WebGL surface). Unlike `applyAppZoom`,
   *  which only mutates CSS for the menu-positioning regression, this drives
   *  the subscriber path — the one that touches even hidden background
   *  terminals.
   *
   *  Routes the keypress through the project-list root (focusable, non-
   *  editable) — the same stable anchor `pressLabelShortcut` and the
   *  workspace-picker shortcuts use — so an editable focus target (chat
   *  textarea / terminal) can't swallow the key. Uses the "Equal" physical key
   *  so `e.key` resolves to "=" (the literal the handler matches),
   *  unambiguously separated from the modifier. */
  async zoomInViaShortcut(): Promise<void> {
    await test.step("Zoom in via Ctrl+= keyboard shortcut", async () => {
      const root = this.projectListRoot();
      await root.waitFor({ state: "visible" });
      await root.press("Control+Equal");
    });
  }

  /** Left-click the first action ("Add workspace") in the open menu. */
  async clickAddWorkspaceMenuItem(): Promise<void> {
    await test.step("Click the Add workspace menu item", async () => {
      await this.addWorkspaceMenuItem.click();
    });
  }

  /** Dispatch the bug-triggering synthetic right-button pointer sequence
   *  directly on the first menu item ("Add workspace"): a `pointermove`
   *  (cursor over the item) followed by a `button=2` `pointerup` with no
   *  matching `pointerdown` — the exact pattern Radix's `MenuItem` heuristic
   *  mistakes for a click. `bubbles: true` is required so the event reaches
   *  React's root listener. */
  async dispatchRightButtonPointerUpOnAddWorkspaceItem(): Promise<void> {
    await test.step("Dispatch right-button pointerup on the Add workspace item", async () => {
      await this.addWorkspaceMenuItem.evaluate((el) => {
        el.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            cancelable: true,
            pointerType: "mouse",
          }),
        );
        el.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            cancelable: true,
            pointerType: "mouse",
            button: 2,
            buttons: 0,
          }),
        );
      });
    });
  }

  /** Right-click the project header while capturing the `contextmenu`
   *  event's client coordinates, then return both the captured cursor point
   *  and the opened menu's top-left — so a test can assert the menu anchors
   *  at the cursor under zoom. Waits for the menu to be visible (the
   *  positive anchor) before measuring. */
  async openProjectContextMenuAndMeasureAnchor(projectName: string): Promise<{
    cursor: { x: number; y: number };
    menu: { left: number; top: number };
  }> {
    return await test.step(`Measure context-menu anchor for ${projectName}`, async () => {
      await this.page.evaluate(() => {
        (window as unknown as { __ctxCursor?: unknown }).__ctxCursor = undefined;
        window.addEventListener(
          "contextmenu",
          (e) => {
            (window as unknown as { __ctxCursor: unknown }).__ctxCursor = {
              x: (e as MouseEvent).clientX,
              y: (e as MouseEvent).clientY,
            };
          },
          { once: true },
        );
      });
      await this.projectHeader(projectName).click({ button: "right" });
      await expect(this.contextMenu).toBeVisible();
      const cursor = await this.page.evaluate(
        () => (window as unknown as { __ctxCursor?: { x: number; y: number } }).__ctxCursor ?? null,
      );
      if (!cursor) {
        throw new Error(
          "contextmenu event was not captured — the right-click may have been swallowed",
        );
      }
      const menu = await this.contextMenu.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top };
      });
      return { cursor, menu };
    });
  }

  /** Click a workspace card to switch to that workspace via the dashboard
   *  sidebar's client-side navigation. Unlike `goto()`, which does a full
   *  browser navigation that resets React state (including the
   *  `MultiWorkspacePanelHost` LRU cache), this uses TanStack Router's
   *  in-app navigation — the previously-active workspace's panels stay
   *  mounted, which is what makes them cache candidates in the first
   *  place. */
  async switchWorkspace(workspaceId: string): Promise<void> {
    await test.step(`Switch workspace to ${workspaceId} via sidebar click`, async () => {
      await this.workspaceCard(workspaceId).click();
    });
  }

  /** Trigger button for the label filter dropdown in the dashboard
   *  sidebar toolbar (issue #505). Only rendered when at least one label
   *  is defined in settings. */
  labelFilterTrigger(): Locator {
    return this.page.getByTestId("dashboard__label-filter-trigger");
  }

  /** Menu item inside the label-filter dropdown. Pass `null` for the
   *  "All" (no-filter) item, or a label id for a specific label. */
  labelFilterItem(labelId: string | null): Locator {
    const key = labelId ?? "all";
    return this.page.getByTestId(`dashboard__label-filter-item--${key}`);
  }

  /** Open the label-filter dropdown and click the item for `labelId`.
   *  `null` selects the "All" item. Mirrors what `setLabelFilter` would
   *  produce — including the per-label "last workspace" restore added in
   *  issue #505 — so this is the right path for tests that need the
   *  full click→restore behaviour.
   *
   *  Only one DashboardShell is mounted on desktop — it now lives in the
   *  sidebar `Panel` inside `AppShell` (`apps/web/src/routes/__root.tsx`),
   *  separate from the dockview — so a single trigger / item pair is in the
   *  DOM at any time. The Radix
   *  DropdownMenu portals its content to `document.body` with a fade
   *  animation on close, so a back-to-back reopen can briefly see the
   *  previous portal animating out while the new one mounts. Waiting
   *  for the new portal to be both visible AND stable before clicking
   *  (via Locator's auto-waits + `state: "visible"`) avoids the
   *  `element was detached from the DOM` flake. */
  async selectLabelFilter(labelId: string | null): Promise<void> {
    const label = labelId ?? "all";
    await test.step(`Select label filter "${label}" via dropdown`, async () => {
      await this.labelFilterTrigger().click();
      const item = this.labelFilterItem(labelId);
      await item.waitFor({ state: "visible" });
      await item.click();
      // Wait for the menu to close before returning so a back-to-back
      // call doesn't try to interact with the previous portal as it
      // animates out (Radix DropdownMenu keeps the portal mounted
      // during the fade-out, which Playwright would detect as
      // "element was detached from the DOM" mid-click).
      await item.waitFor({ state: "hidden" });
    });
  }

  /** Reset both label-related localStorage entries (active filter +
   *  per-label "last workspace" map) and navigate to `workspaceId`, so
   *  tests start from a known-clean slate. Two-step: navigate first to
   *  land on the origin (localStorage isn't accessible until a same-
   *  origin page is loaded), then evaluate the clear. Keeps the raw
   *  `page.evaluate` out of test bodies and centralises the
   *  storage-key constants in this page object.
   *
   *  IMPORTANT: the clear runs AFTER the page mounts, so the React
   *  tree's in-memory copies of those values (e.g. `useLabelFilter`'s
   *  state, `lastSeenActiveRef`) still reflect what was in storage at
   *  mount time. Tests that call this helper should follow up with
   *  another `goto(...)` (or `reload()`) before exercising label-state
   *  behaviour, so the React tree re-reads the now-clean storage on
   *  remount. All in-tree callers already do — every test body opens
   *  with its own `goto(...)`. */
  async resetLabelStateAndGoto(workspaceId: string): Promise<void> {
    await test.step(`Reset label state, navigate to ${workspaceId}`, async () => {
      await this.goto(workspaceId);
      await this.page.evaluate(
        ([filterKey, mapKey]) => {
          localStorage.removeItem(filterKey);
          localStorage.removeItem(mapKey);
        },
        [LABEL_FILTER_KEY, LABEL_LAST_WORKSPACE_KEY] as const,
      );
    });
  }

  /** Read the persisted per-label "last workspace" map from
   *  localStorage. Returns an empty object when nothing has been
   *  recorded yet. */
  async readLabelLastWorkspaces(): Promise<Record<string, string>> {
    return await this.page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      if (!raw) return {};
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, string>;
        }
      } catch {
        // Corrupted entry — treat as empty.
      }
      return {};
    }, LABEL_LAST_WORKSPACE_KEY);
  }

  /** Sidebar project-list root — the keyboard nav anchor in
   *  `ProjectList.tsx` (a `tabindex=-1` div). `DashboardShell`'s
   *  keydown handler skips the Cmd+1..9 / Ctrl+1..9 label shortcuts
   *  when `e.target.tagName` is `INPUT` / `TEXTAREA` / `SELECT` /
   *  `contentEditable`, so tests that fire the shortcut must route the
   *  keystroke through a non-editable target. The project list root
   *  fits the bill — it's both keyboard-focusable and intentionally
   *  not editable. */
  projectListRoot(): Locator {
    return this.page.getByTestId("project-list__root");
  }

  // ──────────────────────────────────────────────────────────────────────
  // Project-list sidebar (lives left of the dockview, outside it) + its
  // header toggle button. The sidebar is a collapsible resizable-panel:
  // collapsing shrinks its width to ~0 rather than unmounting, so the
  // user-observable signal for hidden/shown is its rendered width.
  // ──────────────────────────────────────────────────────────────────────

  /** The project-list sidebar wrapper. `data-testid` set in `__root.tsx`
   *  (`AppShell`). */
  get sidebar(): Locator {
    return this.page.getByTestId("app-shell__sidebar");
  }

  /** The header button that toggles the sidebar (⌘B). Rendered by
   *  `NavControls` in `DesktopTitleBar.tsx`, hosted once in `AppShell`'s
   *  stationary overlay pinned over the title-bar row's left edge — it stays put in both
   *  sidebar states rather than relocating between the title bars. Its
   *  `aria-pressed` reflects current visibility. */
  get sidebarToggle(): Locator {
    return this.page.getByTestId("desktop-title-bar__sidebar-toggle");
  }

  /** The old collapsed-sidebar hamburger menu trigger. The hamburger was
   *  removed — the overflow actions live solely in the project-list bottom
   *  action bar now — so this button no longer renders in any state. Retained
   *  as a locator so specs can assert its absence. */
  get menuTrigger(): Locator {
    return this.page.getByRole("button", { name: "Menu" });
  }

  /** The project-list bottom action bar (Settings + Resources/Usage/overflow),
   *  scoped to the sidebar column. Present whenever the list is visible. */
  get actionBarWithinSidebar(): Locator {
    return this.sidebar.getByTestId("project-list__action-bar");
  }

  /** The workspace-history back arrow (⌘[). Part of the stationary-overlay
   *  `NavControls` cluster. Targeted by testid: the "Back"/"Forward" ARIA
   *  names aren't unique app-wide (ScreencastPanel's address bar reuses them). */
  get backButton(): Locator {
    return this.page.getByTestId("desktop-title-bar__back");
  }

  /** The workspace-history forward arrow (⌘]). Part of the stationary-overlay
   *  `NavControls` cluster. Targeted by testid for the same uniqueness reason
   *  as `backButton`. */
  get forwardButton(): Locator {
    return this.page.getByTestId("desktop-title-bar__forward");
  }

  /** The stationary nav-cluster overlay that hosts the sidebar toggle and
   *  back/forward arrows. `data-testid` set in `__root.tsx` (`AppShell`). */
  get navOverlay(): Locator {
    return this.page.getByTestId("app-shell__nav-overlay");
  }

  /** Whether the nav-cluster overlay renders AFTER every title-bar drag
   *  surface in DOM order. Load-bearing in the desktop shell: Chromium
   *  computes the window's draggable region by walking the layout tree in
   *  document order — unioning `app-region: drag` rects and subtracting
   *  `no-drag` rects as it goes, z-index irrelevant. If the overlay renders
   *  before the bars, the bars' drag rects re-cover the buttons and every
   *  click on them starts a window drag (PR #634). True drag-region
   *  hit-testing only exists in Electron, so DOM order is the assertable
   *  projection of the invariant in this browser harness. Throws when either
   *  side is missing so a renamed testid can't produce a vacuous pass. */
  async navOverlayFollowsTitleBars(): Promise<boolean> {
    return await this.navOverlay.evaluate((overlay) => {
      const bars = document.querySelectorAll(
        '[data-testid="desktop-title-bar__sidebar-surface"], [data-testid="desktop-title-bar__workspace-surface"]',
      );
      if (bars.length === 0) {
        throw new Error("no title-bar drag surfaces found — testids renamed?");
      }
      return Array.from(bars).every(
        (bar) => (bar.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      );
    });
  }

  /** The sidebar-toggle button's viewport x-position. The nav cluster lives
   *  in a stationary overlay, so this must not change when the sidebar collapses
   *  or expands — the geometric signal that the toggle neither relocates nor
   *  jumps during the tween. */
  async sidebarToggleX(): Promise<number> {
    const box = await this.sidebarToggle.boundingBox();
    // Throw rather than return NaN: `expect(NaN).toBe(NaN)` passes
    // (Object.is), so a hidden toggle would make two compared reads
    // vacuously equal instead of failing loudly.
    if (!box) throw new Error("sidebar toggle has no bounding box — not visible");
    return box.x;
  }

  /** Current rendered width of the sidebar in CSS px — ~0 when collapsed.
   *  The geometric, user-observable signal for show/hide (a collapsed Panel
   *  shrinks its width rather than unmounting). */
  async sidebarWidth(): Promise<number> {
    return (await this.sidebar.boundingBox())?.width ?? 0;
  }

  /** Click the header sidebar-toggle button. */
  async toggleSidebarViaButton(): Promise<void> {
    await test.step("Toggle the sidebar via the header button", async () => {
      await this.sidebarToggle.click();
    });
  }

  /** Toggle the sidebar via the ⌘B keyboard shortcut. The keydown is caught
   *  by a window listener in `SharedDockviewLayout.tsx` and re-dispatched as
   *  `band:toggle-sidebar`; the actual panel collapse/expand is handled in
   *  `AppShell` (`__root.tsx`). ⌘ is a meta key so it fires regardless of
   *  focus. Anchored on the always-present toggle button so the key press has
   *  a stable, non-editable focus target. */
  async toggleSidebarViaShortcut(): Promise<void> {
    await test.step("Toggle the sidebar via ⌘B", async () => {
      await this.sidebarToggle.focus();
      await this.page.keyboard.press("Meta+b");
    });
  }

  /** Read the persisted sidebar-collapsed flag (`band:sidebar-collapsed`)
   *  from localStorage. */
  async readSidebarCollapsed(): Promise<boolean> {
    return await this.page.evaluate(() => localStorage.getItem("band:sidebar-collapsed") === "1");
  }

  /** Trigger the ⌃0 "Focus Projects" shortcut, which reveals the sidebar
   *  (`band:show-sidebar`) and focuses the list (`band:focus-projects`). The
   *  keydown is caught by the window listener in `SharedDockviewLayout.tsx`.
   *  Anchored on the always-present toggle button so the key press has a
   *  stable focus target even when the sidebar (and its list) is collapsed. */
  async focusProjectsViaShortcut(): Promise<void> {
    await test.step("Trigger ⌃0 (Focus Projects)", async () => {
      await this.sidebarToggle.focus();
      await this.page.keyboard.press("Control+0");
    });
  }

  /** Drive the ⌘1..9 / Ctrl+1..9 label shortcut as a real user keypress.
   *  Uses `projectListRoot.press(...)` so Playwright moves focus there
   *  before dispatching the key, bypassing the chat textarea autofocus
   *  on the workspace route. The keydown bubbles to the window listener
   *  in `DashboardShell` where the shortcut is wired up. `index` is
   *  0-based; 0 picks "All" (⌘0), 1..9 pick the Nth label (⌘1..9). */
  async pressLabelShortcut(index: number): Promise<void> {
    if (index < 0 || index > 9) {
      throw new Error(`pressLabelShortcut: index must be 0..9, got ${index}`);
    }
    await test.step(`Press Control+${index} (label shortcut)`, async () => {
      const root = this.projectListRoot();
      await root.waitFor({ state: "visible" });
      await root.press(`Control+${index}`);
    });
  }

  /** Locate a tab in the OUTER shared-dockview tab strip by its panel
   *  component id ("chat" | "changes" | "files" | "terminal" |
   *  "browser"). `data-testid` is set by `DefaultTab` / `BadgeTab` in
   *  `SharedDockviewLayout.tsx`, scoped to outer tabs only, so this
   *  locator never collides with nested dockview tab strips (which
   *  render their own per-instance tab components and never carry
   *  `workspace__tab--*` testids). */
  tab(panelComponent: "chat" | "changes" | "files" | "terminal" | "browser"): Locator {
    return this.page.getByTestId(`workspace__tab--${panelComponent}`);
  }

  /** Locate the dockview-owned `.dv-tab` wrapper that contains the named
   *  outer tab. The `data-testid` we set in `DefaultTab` / `BadgeTab` lives
   *  on the inner `.dv-default-tab` element; dockview wraps it with its
   *  own `.dv-tab` parent, which gets `dv-active-tab` added/removed by
   *  the library as the user (or our code) switches the active panel in
   *  the group. Using this wrapper is the fastest deterministic signal
   *  that a specific tab is the active view in its group — much faster
   *  than waiting for the panel's content (e.g. xterm) to finish
   *  booting, and it isn't affected by xterm's offscreen helper textarea
   *  visibility quirks. */
  tabContainer(panelComponent: "chat" | "changes" | "files" | "terminal" | "browser"): Locator {
    // Anchor on our own testid (the one on `.dv-default-tab`) and walk
    // up to dockview's `.dv-tab` wrapper via the `:has(...)` pseudo —
    // a Playwright-supported CSS selector that picks the parent
    // containing a descendant matching the inner selector. Keeps the
    // locator scoped to outer tabs only (nested dockviews use their
    // own per-instance tab renderers and never carry
    // `workspace__tab--*` testids).
    return this.page.locator(`.dv-tab:has([data-testid="workspace__tab--${panelComponent}"])`);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Inner-dockview header toolbar actions ("+" / split). These live in each
  // inner container's `rightHeaderActionsComponent` (`RightHeaderActions` in
  // DockviewChatContainer.tsx etc.). The buttons carry no visible text — the
  // accessible name comes from the `title` attribute ("New chat tab",
  // "Split right", "Split down"), so `getByRole("button", { name })` resolves
  // them. We scope to a workspace's cached panel host and filter to the
  // visible button so the locator picks the active workspace's CENTRAL group
  // toolbar, not the collapsed edge groups' hidden buttons nor the OTHER
  // (hidden) cached workspace's chat header. This is the surface the
  // wrong-workspace-panel regression test drives.
  // ──────────────────────────────────────────────────────────────────────

  /** The central (grid) group's header toolbar for a given inner container in
   *  a workspace's panel host. Each container's `RightHeaderActions` tags its
   *  GRID-group toolbar with `dockview-<container>__toolbar` (edge groups get
   *  no testid), so `getByTestId` resolves only the central action row — never
   *  the collapsed edge groups' "+"-only rows whose buttons can overlap
   *  content and steal a click. The container-specific testid also keeps the
   *  chat toolbar distinct from the terminal toolbar when both inner dockviews
   *  are visible at once (default outer layout shows Chat in one group and the
   *  active right-group tab in another). Scoped to the workspace's cached
   *  entry + filtered to visible so it never resolves the OTHER (hidden)
   *  workspace's header. */
  private centralToolbar(workspaceId: string, container: "chat" | "terminal" | "browser"): Locator {
    return this.cachedPanelEntries(workspaceId)
      .getByTestId(`dockview-${container}__toolbar`)
      .filter({ visible: true });
  }

  /** The visible "New chat tab" ("+") button for a workspace's chat host. */
  chatAddTabButton(workspaceId: string): Locator {
    return this.centralToolbar(workspaceId, "chat").getByRole("button", { name: "New chat tab" });
  }

  /** The visible chat "Split right" button for a workspace's chat host. */
  chatSplitRightButton(workspaceId: string): Locator {
    return this.centralToolbar(workspaceId, "chat").getByRole("button", { name: "Split right" });
  }

  /** The visible "New terminal" ("+") button for a workspace's terminal host. */
  terminalAddTabButton(workspaceId: string): Locator {
    return this.centralToolbar(workspaceId, "terminal").getByRole("button", {
      name: "New terminal",
    });
  }

  /** The visible terminal "Split right" button for a workspace's terminal host. */
  terminalSplitRightButton(workspaceId: string): Locator {
    return this.centralToolbar(workspaceId, "terminal").getByRole("button", {
      name: "Split right",
    });
  }

  /** Click the chat "+" (add tab) button in the given workspace's host. */
  async clickChatAddTab(workspaceId: string): Promise<void> {
    await test.step(`Click chat "+" in workspace ${workspaceId}`, async () => {
      await this.chatAddTabButton(workspaceId).first().click();
    });
  }

  /** Click the chat "Split right" button in the given workspace's host. */
  async clickChatSplitRight(workspaceId: string): Promise<void> {
    await test.step(`Click chat "Split right" in workspace ${workspaceId}`, async () => {
      await this.chatSplitRightButton(workspaceId).first().click();
    });
  }

  /** Click the terminal "+" (add tab) button in the given workspace's host. */
  async clickTerminalAddTab(workspaceId: string): Promise<void> {
    await test.step(`Click terminal "+" in workspace ${workspaceId}`, async () => {
      await this.terminalAddTabButton(workspaceId).first().click();
    });
  }

  /** Click the terminal "Split right" button in the given workspace's host. */
  async clickTerminalSplitRight(workspaceId: string): Promise<void> {
    await test.step(`Click terminal "Split right" in workspace ${workspaceId}`, async () => {
      await this.terminalSplitRightButton(workspaceId).first().click();
    });
  }

  /** Click the first terminal tab's "Close terminal" (×) button within the
   *  given workspace's terminal host. The button is only rendered when a group
   *  has more than one tab. Scoped to the workspace's cached entry (like the
   *  sibling terminal-toolbar helpers) so it never targets another mounted
   *  workspace's terminal. */
  async closeTerminalTab(workspaceId: string): Promise<void> {
    await test.step(`Close the first terminal tab in workspace ${workspaceId}`, async () => {
      await this.cachedPanelEntries(workspaceId)
        .getByRole("button", { name: "Close terminal" })
        .first()
        .click();
    });
  }

  /** Count the panels in a workspace's persisted inner layout for the given
   *  container. Returns 0 when no layout has been persisted yet. Reads the
   *  server-side layout (via `readInnerLayout`) so it reflects which
   *  workspace's dockview an add/split actually mutated — the crux of the
   *  wrong-workspace regression. */
  async countInnerPanels(
    container: "chat" | "terminal" | "browser",
    workspaceId: string,
  ): Promise<number> {
    const tree = await this.readInnerLayout(container, workspaceId);
    return tree ? Object.keys(tree.panels).length : 0;
  }

  /** Convenience: panel count for a workspace's persisted chat layout. */
  async countChatPanels(workspaceId: string): Promise<number> {
    return this.countInnerPanels("chat", workspaceId);
  }

  /** Convenience: panel count for a workspace's persisted terminal layout. */
  async countTerminalPanels(workspaceId: string): Promise<number> {
    return this.countInnerPanels("terminal", workspaceId);
  }

  /** Navigate to the given workspace. The workspace URL no longer carries a
   *  sub-path for the active tab — see issue #467 for the route unification
   *  that folded `/changes`, `/code`, `/terminal` into `/workspace/:id`. */
  async goto(workspaceId: string): Promise<void> {
    const url = `${this.baseUrl}/workspace/${encodeURIComponent(workspaceId)}?token=${this.token}`;
    await test.step(`Navigate to workspace ${workspaceId}`, async () => {
      await this.page.goto(url);
    });
  }

  /** Hard-reload the current page (preserves `localStorage`). */
  async reload(): Promise<void> {
    await test.step("Reload the dashboard", async () => {
      await this.page.reload();
    });
  }

  /** Wait for the shared dockview to render its header buttons. The
   *  app boot is multi-stage (settings query → workspaces fetch →
   *  dockview mount) and any test that interacts with the buttons must
   *  wait for them to be in the DOM. */
  async waitForReady(): Promise<void> {
    await this.maximizeButtons.first().waitFor({ state: "visible", timeout: 15_000 });
  }

  /** Wait for the mobile workspace layout to be interactive. The
   *  mobile route doesn't render the dockview's header buttons, so
   *  `waitForReady` (which keys off Maximize) won't work — instead
   *  we anchor on the workspace tab nav's "Files" button, set by
   *  `WorkspaceTabNav.tsx`. The aria-label is system-controlled,
   *  not localisable copy. */
  async waitForMobileReady(): Promise<void> {
    await this.page
      .getByRole("button", { name: "Files" })
      .waitFor({ state: "visible", timeout: 15_000 });
  }

  /** The mobile workspace header's title button. Its aria-label
   *  ("Switch workspace") is system-controlled (set in
   *  `workspace.$workspaceId.tsx` MobileWorkspaceLayout), so
   *  `getByRole({ name })` is the preferred locator. Tapping it opens the
   *  WorkspacePickerDialog. */
  get switchWorkspaceButton(): Locator {
    return this.page.getByRole("button", { name: "Switch workspace" });
  }

  /** The mobile header's hamburger button — opens the project-list fly-out
   *  drawer *over* the current workspace (no route change). aria-label set in
   *  MobileWorkspaceLayout. */
  get projectListTrigger(): Locator {
    return this.page.getByTestId("mobile-workspace__project-list-trigger");
  }

  /** The left project-list fly-out drawer (a `Sheet side="left"` wrapping the
   *  DashboardShell). data-testid set in MobileWorkspaceLayout. */
  get projectListFlyout(): Locator {
    return this.page.getByTestId("project-list-flyout");
  }

  /** The active workspace card *scoped to the project-list fly-out* — proves
   *  the card rendered inside the drawer (not elsewhere on the page) and
   *  carries the `data-active` marker. Same `[data-active]` state-filter
   *  rationale as `activeWorkspaceCard`. */
  activeWorkspaceCardInFlyout(workspaceId: string): Locator {
    return this.projectListFlyout
      .getByTestId(`project-list__workspace-card--${workspaceId}`)
      .and(this.page.locator("[data-active]"));
  }

  /** Open the workspace switcher from the mobile header title. */
  async openSwitcherFromHeader(): Promise<void> {
    await test.step("Tap the mobile header title to open the workspace switcher", async () => {
      await this.switchWorkspaceButton.click();
    });
  }

  /** Tap the hamburger to open the project-list fly-out over this workspace.
   *  Opening it must not change the route — the workspace stays mounted
   *  underneath. */
  async openProjectListFlyout(): Promise<void> {
    await test.step("Open the project-list fly-out", async () => {
      await this.projectListTrigger.click();
      await this.projectListFlyout.waitFor({ state: "visible", timeout: 15_000 });
    });
  }

  /** Dismiss the fly-out by clicking the backdrop overlay (tap-outside). The
   *  overlay sits behind the drawer, so we click near the right edge of the
   *  viewport where only the overlay is present. */
  async dismissProjectListFlyoutViaBackdrop(): Promise<void> {
    await test.step("Dismiss the project-list fly-out via the backdrop", async () => {
      // The Radix overlay covers the full viewport; the drawer is on the left
      // (max-w-sm). Click far right so the click lands on the overlay, not the
      // drawer content.
      const viewport = this.page.viewportSize();
      const x = viewport ? viewport.width - 10 : 780;
      const y = viewport ? Math.floor(viewport.height / 2) : 400;
      await this.page.mouse.click(x, y);
    });
  }

  /** Open the workspace picker on desktop via its ⌘K shortcut. The handler
   *  lives on a window keydown listener in `SharedDockviewLayout.tsx`.
   *  Because ⌘ is a meta key the shortcut fires regardless of focus
   *  (including from inside a focused terminal), but we still route the
   *  keypress through the project list root (focusable, non-editable) —
   *  the same stable anchor the label shortcut test uses. */
  async openWorkspacePickerViaShortcut(): Promise<void> {
    await test.step("Open workspace picker (⌘K)", async () => {
      const root = this.projectListRoot();
      await root.waitFor({ state: "visible" });
      await root.press("Meta+k");
    });
  }

  /** Open the workspace picker via the non-macOS Ctrl+K shortcut. Distinct
   *  from the ⌘K branch: Ctrl+K bails when a terminal is focused (it's
   *  kill-to-end-of-line in most shells), so we route the keypress through
   *  the project-list root — a focusable, non-terminal element — to exercise
   *  the non-terminal path. */
  async openWorkspacePickerViaCtrlShortcut(): Promise<void> {
    await test.step("Open workspace picker (Ctrl+K)", async () => {
      const root = this.projectListRoot();
      await root.waitFor({ state: "visible" });
      await root.press("Control+k");
    });
  }

  /** The desktop title-bar workspace-name button. On a wide viewport
   *  `useDesktopLayout` is true, so __root.tsx mounts the WorkspaceTitleBar
   *  (in `DesktopTitleBar.tsx`) with `onWorkspaceNameClick` wired — the name
   *  renders as a button that opens the same picker as ⌘K. Targeted by its
   *  BEM testid rather than the shared "Switch workspace" aria-label so it
   *  never collides with the mobile header button of the same name. */
  get desktopTitleWorkspaceNameButton(): Locator {
    return this.page.getByTestId("desktop-title-bar__workspace-name");
  }

  /** Assert the desktop title-bar workspace-name button is visible — the
   *  desktop affordance that opens the picker. Routed through a page-object
   *  method so the test body never touches the raw locator. */
  async assertTitleBarWorkspaceNameVisible(): Promise<void> {
    await test.step("Assert the desktop title-bar workspace name is visible", async () => {
      await expect(this.desktopTitleWorkspaceNameButton).toBeVisible();
    });
  }

  /** Open the workspace picker by clicking the desktop title-bar workspace
   *  name (mirrors the mobile header's tap-to-switch). */
  async openWorkspacePickerViaTitleBar(): Promise<void> {
    await test.step("Click the desktop title-bar workspace name", async () => {
      await this.desktopTitleWorkspaceNameButton.click();
    });
  }

  /** The active workspace card, identified by the `data-active` attribute
   *  `WorkspaceCard` sets when its workspaceId matches the store's
   *  `activeWorkspaceId`. Scoped to a specific workspaceId so the test can
   *  assert the right card carries the active marker.
   *
   *  The `[data-active]` presence filter is intentional rather than a CSS
   *  selector smell: `data-active` is a binary *state* marker (present ⇔
   *  active), so the card's identity still comes from its `getByTestId`-based
   *  `workspaceCard(...)` locator — this only narrows it to the active state.
   *  A separate testid per state would duplicate the marker the component
   *  already owns. */
  activeWorkspaceCard(workspaceId: string): Locator {
    return this.workspaceCard(workspaceId).and(this.page.locator("[data-active]"));
  }

  /** Activate the outer Terminal tab so the inner
   *  `DockviewTerminalContainer` mounts and (on cold start) seeds a
   *  default terminal panel, which boots a real PTY server-side. */
  async openTerminalTab(): Promise<void> {
    await this.activateTab("terminal");
  }

  /** Activate an outer shared-dockview tab by its panel component id. Wraps the
   *  raw tab click in a `test.step` so spec bodies switch tabs through the page
   *  object instead of touching the `tab(...)` locator directly. */
  async activateTab(
    panelComponent: "chat" | "changes" | "files" | "terminal" | "browser",
  ): Promise<void> {
    await test.step(`Activate the ${panelComponent} tab`, async () => {
      await this.tab(panelComponent).click();
    });
  }

  /** Read the server's recorded last-focused panel ids for a workspace via the
   *  `panelFocus.get` tRPC query. Used as a synchronisation barrier: focus is
   *  reported fire-and-forget, so a test polls this until the pane it just
   *  focused is recorded before triggering an "Add to …" action that reads it.
   *  Auth is the `band_token` cookie, matching the tRPC HTTP helpers. */
  async readServerPanelFocus(
    workspaceId: string,
  ): Promise<{ chat?: string; terminal?: string; browser?: string }> {
    const input = encodeURIComponent(JSON.stringify({ workspaceId }));
    const res = await this.page.request.get(`${this.baseUrl}/trpc/panelFocus.get?input=${input}`, {
      headers: { Cookie: `band_token=${this.token}` },
    });
    const body = (await res.json()) as { result?: { data?: Record<string, string> } };
    return body.result?.data ?? {};
  }

  /** Wait for the terminal's xterm input to be attached — the DOM-level
   *  signal that the xterm instance mounted. xterm keeps its input as an
   *  offscreen "helper" textarea (Playwright reports it as hidden, never
   *  "visible"), so we wait for `attached`, not `visible`.
   *
   *  `timeoutMs` defaults to 15 s, which is the right budget for tests
   *  that boot xterm from a freshly-mounted dockview without parallel
   *  CI contention. Tests running under high parallel load (or chained
   *  with workspace switches that re-mount the panel host) can pass a
   *  longer budget — see `workspace-maximize-state.spec.ts:346` and
   *  `workspace-create-via-terminal.spec.ts:179`, both at 75 s. */
  async waitForTerminalReady(timeoutMs = 15_000): Promise<void> {
    await this.terminalInput.first().waitFor({ state: "attached", timeout: timeoutMs });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Parking-model surface probes (band-app/band#617).
  //
  // Each cached terminal keeps ONE xterm opened into a persistent wrapper
  // (`[data-testid="terminal-wrapper"]`, tagged with `data-workspace-id` /
  // `data-terminal-id`). The wrapper is *moved* between its live panel and the
  // shared off-screen parking container (`[data-testid="terminal-parking"]`),
  // never disposed on a switch. Unlike the panel-host-scoped probes above,
  // these locate a terminal by its wrapper's `data-workspace-id`, so they see
  // the surface whether it's attached (live) or parked.
  // ──────────────────────────────────────────────────────────────────────

  /** Start counting terminal WebSocket opens for a SPECIFIC workspace (matched
   *  on the `workspaceId=` query param). Returns a getter for the running count.
   *  Call BEFORE `goto`. Lets a test prove a given workspace's terminal did NOT
   *  reconnect across a switch, independent of other workspaces' sockets. */
  trackTerminalSocketOpensFor(workspaceId: string): () => number {
    const needle = `workspaceId=${encodeURIComponent(workspaceId)}`;
    let count = 0;
    this.page.on("websocket", (ws) => {
      if (ws.url().includes("/terminal?") && ws.url().includes(needle)) count += 1;
    });
    return () => count;
  }

  /** Dispatch a window `online` event in the page — the resume trigger the
   *  terminal client uses to reconnect a dropped socket. Lets a test drive the
   *  reconnect path deterministically instead of waiting on a real network flap. */
  async simulateNetworkOnline(): Promise<void> {
    await test.step("Dispatch window 'online'", async () => {
      await this.page.evaluate(() => window.dispatchEvent(new Event("online")));
    });
  }

  /** Dispatch a window `focus` event in the page — the foreground trigger the
   *  terminal client reacts to with a CHEAP repaint (fit + refresh). It must
   *  NOT rebuild the WebGL surface (that raced the compositor and flickered);
   *  genuine texture loss is driven by `loseTerminalWebglContext`. Lets a test
   *  assert the surface survives a foreground return. */
  async simulateWindowForeground(): Promise<void> {
    await test.step("Dispatch window 'focus'", async () => {
      await this.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    });
  }

  /** Blur then refocus the terminal's xterm input textarea — fires a real
   *  `focusin` on the terminal wrapper. A click into the terminal now does a
   *  cheap repaint only, never a rebuild, so this is used to assert the surface
   *  SURVIVES a click. Blurring first matters: focus() on an already-focused
   *  element fires nothing. */
  async refocusTerminal(): Promise<void> {
    await test.step("Blur + refocus terminal input", async () => {
      await this.terminalInput.first().evaluate((el) => {
        (el as HTMLElement).blur();
        (el as HTMLElement).focus();
      });
    });
  }

  /** Wait for `n` animation frames to elapse in the page. Used to let the
   *  client's rAF-debounced repair path (`scheduleRepair` → `repairAndFit`)
   *  actually RUN before a "surface was NOT rebuilt" assertion — otherwise the
   *  assertion reads the pre-repair state and passes vacuously (the rebuild, if
   *  any, lands a frame or two later). A rebuild completes synchronously inside
   *  `repairAndFit`, so a few frames deterministically covers it. */
  async settleAnimationFrames(n = 3): Promise<void> {
    await this.page.evaluate(
      (frames) =>
        new Promise<void>((resolve) => {
          if (frames <= 0) {
            resolve();
            return;
          }
          let left = frames;
          const tick = () => {
            left -= 1;
            if (left <= 0) resolve();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
      n,
    );
  }

  /** Force a genuine WebGL context loss on the workspace's terminal canvas via
   *  the `WEBGL_lose_context` extension. This fires the real `webglcontextlost`
   *  event that xterm's WebglAddon listens for, driving the ONE client repair
   *  path that legitimately rebuilds the surface (`onContextLoss`). Lets a test
   *  prove genuine loss still rebuilds even though ordinary focus/switch no
   *  longer do. Throws if no live WebGL canvas/context is found so the test
   *  fails loudly rather than passing vacuously. */
  async loseTerminalWebglContext(workspaceId: string): Promise<void> {
    await test.step(`Force WebGL context loss on ${workspaceId} terminal`, async () => {
      await this.page.evaluate((id) => {
        const wrapper = document.querySelector(`[data-workspace-id="${id}"]`);
        const canvases = wrapper
          ? Array.from(wrapper.querySelectorAll<HTMLCanvasElement>(".xterm-screen canvas"))
          : [];
        // Pick the WebGL canvas by probing for a context, not by DOM order —
        // xterm could add a non-WebGL canvas sibling. Matches the
        // context-agnostic `querySelectorAll(".xterm-screen canvas")` the other
        // surface probes use.
        for (const canvas of canvases) {
          const gl = (canvas.getContext("webgl2") ??
            canvas.getContext("webgl")) as WebGLRenderingContext | null;
          const ext = gl?.getExtension("WEBGL_lose_context");
          if (ext) {
            ext.loseContext();
            return;
          }
        }
        throw new Error(`no WebGL terminal canvas for workspace ${id}`);
      }, workspaceId);
    });
  }

  /** Wait up to `timeoutMs` for the page to open a NEW terminal WebSocket for the
   *  given workspace; resolves `true` if one opens, `false` on timeout. Used to
   *  assert a reconnect did (or, for a terminated terminal, did NOT) happen —
   *  event-driven, so the negative case fails fast rather than fixed-sleeping. */
  async waitForTerminalSocket(workspaceId: string, timeoutMs: number): Promise<boolean> {
    const needle = `workspaceId=${encodeURIComponent(workspaceId)}`;
    try {
      await this.page.waitForEvent("websocket", {
        timeout: timeoutMs,
        predicate: (ws) => ws.url().includes("/terminal?") && ws.url().includes(needle),
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Whether the given workspace's terminal wrapper currently lives inside the
   *  off-screen parking container (i.e. the terminal is detached/inactive). */
  async isTerminalParked(workspaceId: string): Promise<boolean> {
    return await this.page.evaluate((id) => {
      const wrapper = document.querySelector(`[data-workspace-id="${id}"]`);
      return !!wrapper?.closest('[data-testid="terminal-parking"]');
    }, workspaceId);
  }

  /** Read the set of terminalIds currently mounted for a workspace (from each
   *  wrapper's `data-terminal-id`). Lets a test assert a terminal was REUSED
   *  (same id) vs re-created (new id) across a navigation. */
  async terminalIds(workspaceId: string): Promise<string[]> {
    return await this.page.evaluate(
      (id) =>
        Array.from(document.querySelectorAll(`[data-workspace-id="${id}"]`))
          .map((el) => (el as HTMLElement).dataset.terminalId ?? "")
          .filter(Boolean),
      workspaceId,
    );
  }

  /** Count the cached terminal wrappers for a workspace (one per terminal
   *  session). Drops to 0 once the workspace's terminals are disposed. */
  async terminalWrapperCount(workspaceId: string): Promise<number> {
    return await this.page.evaluate(
      (id) => document.querySelectorAll(`[data-workspace-id="${id}"]`).length,
      workspaceId,
    );
  }

  /** Tag every canvas inside a workspace's terminal wrapper (parked or live) so
   *  a later read can tell whether the renderer surface was left untouched
   *  (tags survive) or rebuilt with a fresh WebGL addon (tags gone — what the
   *  corruption-repair paths guarantee on re-attach / foreground return).
   *  Returns the number of canvases tagged. */
  async tagTerminalCanvasesByWorkspace(workspaceId: string): Promise<number> {
    return await this.page.evaluate((id) => {
      const wrapper = document.querySelector(`[data-workspace-id="${id}"]`);
      const canvases = wrapper
        ? Array.from(wrapper.querySelectorAll<HTMLCanvasElement>(".xterm-screen canvas"))
        : [];
      canvases.forEach((c, i) => {
        c.dataset.bandProbe = `tagged-${i}`;
      });
      return canvases.length;
    }, workspaceId);
  }

  /** Read a workspace's terminal render surface by wrapper (parked or live):
   *  canvas count, surviving tags, `.xterm-screen` CSS size, per-canvas backing
   *  store size, and dpr. */
  async readTerminalSurfaceByWorkspace(workspaceId: string): Promise<{
    canvasCount: number;
    survivingTags: number;
    screen: { w: number; h: number };
    backing: { w: number; h: number }[];
    dpr: number;
  }> {
    return await this.page.evaluate((id) => {
      const wrapper = document.querySelector(`[data-workspace-id="${id}"]`);
      const screenEl = wrapper?.querySelector(".xterm-screen") as HTMLElement | null;
      const canvases = wrapper
        ? Array.from(wrapper.querySelectorAll<HTMLCanvasElement>(".xterm-screen canvas"))
        : [];
      const rect = screenEl?.getBoundingClientRect();
      return {
        canvasCount: canvases.length,
        survivingTags: canvases.filter((c) => c.dataset.bandProbe).length,
        screen: { w: Math.round(rect?.width ?? 0), h: Math.round(rect?.height ?? 0) },
        backing: canvases.map((c) => ({ w: c.width, h: c.height })),
        dpr: window.devicePixelRatio,
      };
    }, workspaceId);
  }

  /** Read the rendered text of a workspace's terminal from xterm's DOM-renderer
   *  rows (`.xterm-rows`). Only populated under the DOM renderer (no WebGL flags
   *  in the test's launch options), which is exactly the case that lets a test
   *  read the actual glyphs. Joins across all of the workspace's wrappers. */
  async readTerminalRenderedText(workspaceId: string): Promise<string> {
    return await this.page.evaluate((id) => {
      const wrappers = Array.from(document.querySelectorAll(`[data-workspace-id="${id}"]`));
      // `textContent` (not `innerText`) so it works for a parked wrapper that
      // is rendered off-screen — `innerText` can collapse for non-viewport nodes.
      return wrappers
        .map((w) => (w.querySelector(".xterm-rows") as HTMLElement | null)?.textContent ?? "")
        .join("\n");
    }, workspaceId);
  }

  /** Read the live xterm column count for a workspace's terminal from the
   *  module-level terminal cache (`globalThis.__bandTerminalCache__`). Lets a
   *  width-sensitive test calibrate against the ACTUAL fitted width instead of
   *  guessing cols from the viewport (which varies with font metrics across
   *  platforms). Returns 0 when the terminal isn't cached / not yet loaded.
   *
   *  Assumes ONE terminal per workspace: it returns the first cache entry
   *  matching `workspaceId`, so with multiple terminal tabs the result is
   *  whichever the Map iterator yields first. Current callers seed a single
   *  terminal; add a `terminalId` param if that ever changes. */
  async terminalCols(workspaceId: string): Promise<number> {
    return await this.page.evaluate((id) => {
      const cache = (
        globalThis as unknown as {
          __bandTerminalCache__?: Map<string, { workspaceId: string; getTerminal(): unknown }>;
        }
      ).__bandTerminalCache__;
      if (!cache) return 0;
      for (const entry of cache.values()) {
        if (entry.workspaceId === id) {
          const term = entry.getTerminal() as { cols?: number } | null;
          if (term && typeof term.cols === "number") return term.cols;
        }
      }
      return 0;
    }, workspaceId);
  }

  /** Read a workspace terminal's rendered text ROW BY ROW from the DOM
   *  renderer's `.xterm-rows` (one `<div>` per visual row). Unlike
   *  `readTerminalRenderedText` (which joins everything into one string), this
   *  preserves the per-row layout so a test can assert WHERE a token landed —
   *  the observable that reflow-scatter corrupts. Only meaningful under the DOM
   *  renderer (`useWebGLTerminalRenderer: false`); joins across the workspace's
   *  wrappers, first wrapper first. */
  async readTerminalRenderedRows(workspaceId: string): Promise<string[]> {
    return await this.page.evaluate((id) => {
      const wrappers = Array.from(document.querySelectorAll(`[data-workspace-id="${id}"]`));
      const rows: string[] = [];
      for (const w of wrappers) {
        const rowsEl = w.querySelector(".xterm-rows");
        if (!rowsEl) continue;
        for (const child of Array.from(rowsEl.children)) {
          rows.push((child as HTMLElement).textContent ?? "");
        }
      }
      return rows;
    }, workspaceId);
  }

  /** Navigate to a blank page, fully tearing down the mounted client (its
   *  terminal xterm + WebSocket). Used to drop the live client WITHOUT sending
   *  a resize, so a subsequent viewport change + re-navigation makes the fresh
   *  client fit to a DIFFERENT width than the server-side mirror still holds —
   *  the reconnect width mismatch under test. */
  async navigateToBlank(): Promise<void> {
    await test.step("Navigate to a blank page (tear down client)", async () => {
      await this.page.goto("about:blank");
    });
  }

  /** Resize the browser viewport. A thin wrapper so the spec body drives the
   *  viewport through the page object like every other action. */
  async setViewport(width: number, height: number): Promise<void> {
    await test.step(`Set viewport to ${width}x${height}`, async () => {
      await this.page.setViewportSize({ width, height });
    });
  }

  /** Whether the shared terminal parking container is properly isolated:
   *  `inert` + `aria-hidden` so a parked terminal's hidden textarea can't take
   *  focus or receive keystrokes (band-app/band#617). Returns null when no
   *  parking container exists yet. */
  async readParkingIsolation(): Promise<{ inert: boolean; ariaHidden: boolean } | null> {
    return await this.page.evaluate(() => {
      const el = document.querySelector('[data-testid="terminal-parking"]') as HTMLElement | null;
      if (!el) return null;
      return {
        inert: el.hasAttribute("inert"),
        ariaHidden: el.getAttribute("aria-hidden") === "true",
      };
    });
  }

  /** Type a line into the focused terminal and submit it with Enter.
   *  Routes the keystrokes through the real xterm input (which calls
   *  `terminal.onData` → `ws.send`), exactly as a user typing would.
   *  `focus()` (not `click()`) because xterm's helper textarea is
   *  offscreen and not click-targetable. A leading Enter clears any
   *  partial line left by keystrokes dropped while the socket was
   *  mid-reconnect, so a retried command never concatenates onto a
   *  half-typed previous attempt. */
  async runInTerminal(line: string): Promise<void> {
    await test.step(`Run in terminal: ${line}`, async () => {
      await this.terminalInput.first().focus();
      await this.page.keyboard.press("Enter");
      await this.page.keyboard.type(line);
      await this.page.keyboard.press("Enter");
    });
  }

  /** Wait until the workspace's terminal has rendered ANY text into xterm's
   *  DOM-renderer rows — i.e. the shell prompt has been drawn. Two failure
   *  modes collapse into "rendered text is empty forever" without this
   *  barrier, and it splits them apart: rows that never fill mean the DOM
   *  renderer isn't active (a WebGL terminal keeps `.xterm-rows` empty), while
   *  rows that fill but never show a later marker mean the keystrokes were
   *  lost. Call it after `waitForTerminalReady` and before the first
   *  `runInTerminal*` a rendered-text assertion depends on. */
  async waitForTerminalRenderedPrompt(workspaceId: string, timeoutMs = 20_000): Promise<void> {
    await test.step(`Wait for rendered shell prompt in ${workspaceId}`, async () => {
      await expect
        .poll(async () => (await this.readTerminalRenderedText(workspaceId)).trim().length, {
          timeout: timeoutMs,
        })
        .toBeGreaterThan(0);
    });
  }

  /** `runInTerminal`, made self-verifying: type `line`, then wait until
   *  `marker` shows up in the workspace's rendered rows; if it doesn't within
   *  `renderTimeoutMs`, retype (up to `attempts` total). Keystrokes typed into
   *  xterm's hidden textarea can be dropped wholesale under parallel CI load
   *  (a focus steal or a socket hiccup mid-`keyboard.type`), and a plain
   *  `runInTerminal` has no way to notice — the test then times out on a
   *  downstream assertion with no clue the command never ran. A retry starts
   *  with Ctrl+C, which resets both a half-typed line AND a PS2 continuation
   *  state (a dropped tail like `for … do` without its `done`, or an unclosed
   *  quote — `runInTerminal`'s leading Enter alone can't escape those), and
   *  kills a loop a false-negative render wait left running. Only use with an
   *  idempotent `line` — a retype after a false negative would run it again.
   *  `marker` must not match the typed line's own echo (quote a fragment,
   *  e.g. `echo C_OWN_"MARKER"`, so only executed output can match) —
   *  otherwise a dropped trailing Enter passes verification. */
  async runInTerminalUntilRendered(
    workspaceId: string,
    line: string,
    marker: RegExp,
    { attempts = 3, renderTimeoutMs = 8_000 }: { attempts?: number; renderTimeoutMs?: number } = {},
  ): Promise<void> {
    await test.step(`Run in terminal until ${marker} renders: ${line}`, async () => {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (attempt > 1) {
          await this.terminalInput.first().focus();
          await this.page.keyboard.press("Control+C");
        }
        await this.runInTerminal(line);
        try {
          await expect
            .poll(async () => marker.test(await this.readTerminalRenderedText(workspaceId)), {
              timeout: renderTimeoutMs,
            })
            .toBe(true);
          return;
        } catch (error) {
          if (attempt === attempts) throw error;
        }
      }
    });
  }

  /** Start counting terminal WebSocket connections the page opens.
   *  Returns a getter for the running count. Call this BEFORE `goto` so
   *  the listener is attached before the first socket opens. A test
   *  asserts the count climbs past 1 after a network drop — protocol-
   *  level proof the client auto-reconnected, without depending on the
   *  (WebGL-canvas) rendered terminal text. */
  trackTerminalSocketOpens(): () => number {
    let count = 0;
    this.page.on("websocket", (ws) => {
      if (ws.url().includes("/terminal?")) count += 1;
    });
    return () => count;
  }

  /** Install a browser-side wrapper around `window.WebSocket` that records
   *  every terminal socket the page opens in `window.__terminalSockets`.
   *  Must run BEFORE `goto` (uses `addInitScript`). Test-only
   *  instrumentation — it touches no production code — that lets a test
   *  force-close the live socket to simulate the TCP death a machine sleep
   *  causes (Chromium's `context.setOffline` does NOT drop an established
   *  loopback WebSocket, so it can't reproduce the disconnect). */
  async installTerminalSocketInstrumentation(): Promise<void> {
    await this.page.addInitScript(() => {
      const w = window as unknown as {
        WebSocket: typeof WebSocket;
        __terminalSockets?: WebSocket[];
      };
      const Orig = w.WebSocket;
      w.__terminalSockets = [];
      // A function *declaration*, not an arrow — arrows aren't constructors
      // and `new WebSocket(...)` in the app would throw "not a constructor".
      function TrackedWebSocket(url: string | URL, protocols?: string | string[]) {
        const ws = new Orig(url, protocols);
        if (String(url).includes("/terminal?")) {
          w.__terminalSockets?.push(ws);
        }
        return ws;
      }
      const Wrapped = TrackedWebSocket as unknown as typeof WebSocket;
      Wrapped.prototype = Orig.prototype;
      const statics = Wrapped as unknown as Record<string, number>;
      statics.CONNECTING = Orig.CONNECTING;
      statics.OPEN = Orig.OPEN;
      statics.CLOSING = Orig.CLOSING;
      statics.CLOSED = Orig.CLOSED;
      w.WebSocket = Wrapped;
    });
  }

  /** Force-close the most recently opened terminal WebSocket from inside
   *  the page — the deterministic stand-in for a socket dying on machine
   *  wake. Fires the client's `onclose`, which drives the auto-reconnect
   *  path under test. Requires `installTerminalSocketInstrumentation`. */
  async dropLatestTerminalSocket(): Promise<void> {
    await test.step("Force-close the live terminal WebSocket (simulate sleep)", async () => {
      await this.page.evaluate(() => {
        const w = window as unknown as { __terminalSockets?: WebSocket[] };
        const list = w.__terminalSockets ?? [];
        list[list.length - 1]?.close();
      });
    });
  }

  /** The outer dockview group shell (`.dv-groupview`) that currently hosts the
   *  named outer tab. dockview owns this markup — we don't render it — so, as
   *  with `tabContainer`'s `.dv-tab` wrapper, anchoring on our own
   *  `workspace__tab--*` testid and walking up to the library's shell via
   *  `:has(...)` is the only way to address a specific group. Nested (inner)
   *  dockviews render their own `.dv-groupview`s but never carry
   *  `workspace__tab--*` testids, so this stays scoped to the outer layout. */
  groupContaining(panelComponent: "chat" | "changes" | "files" | "terminal" | "browser"): Locator {
    return this.page.locator(
      `.dv-groupview:has([data-testid="workspace__tab--${panelComponent}"])`,
    );
  }

  /** Maximize the outer group that hosts the named tab (rather than the Nth
   *  group, which depends on the default layout's ordering). Each center group
   *  renders exactly one Maximize/Restore toggle in its right header actions
   *  (`MainGroupRightActions` in `SharedDockviewLayout.tsx`). */
  async maximizeGroupContaining(
    panelComponent: "chat" | "changes" | "files" | "terminal" | "browser",
  ): Promise<void> {
    await test.step(`Maximize the group hosting the ${panelComponent} tab`, async () => {
      await this.groupContaining(panelComponent).getByRole("button", { name: "Maximize" }).click();
    });
  }

  /** Click the Nth Maximize button (0-indexed). Useful when the layout
   *  has multiple groups and the test wants to target a specific one. */
  async maximizePanel(index = 0): Promise<void> {
    await test.step(`Maximize panel at index ${index}`, async () => {
      await this.maximizeButtons.nth(index).click();
    });
  }

  /** Exit the currently-maximized panel. */
  async restorePanel(): Promise<void> {
    await test.step("Restore (un-maximize) the active panel", async () => {
      await this.restoreButton.click();
    });
  }

  /** Read the persisted active-state blob for a workspace out of
   *  `localStorage`. Returns `undefined` when no entry exists for that
   *  workspace. */
  async readActiveState(workspaceId: string): Promise<SavedActiveState | undefined> {
    return await this.page.evaluate(
      ([prefix, id]) => {
        const raw = localStorage.getItem(`${prefix}${id}`);
        if (!raw) return undefined;
        try {
          return JSON.parse(raw);
        } catch {
          return undefined;
        }
      },
      [ACTIVE_STATE_KEY_PREFIX, workspaceId] as const,
    );
  }

  /** Convenience: read just the `maximizedGroup` field of the saved
   *  state. */
  async readMaximizedGroup(workspaceId: string): Promise<string | undefined> {
    const state = await this.readActiveState(workspaceId);
    return state?.maximizedGroup;
  }

  /** Replace the persisted active-state for a workspace. Used to seed
   *  specific group/tab state before navigating, for scenarios that
   *  need to start from a non-default position (e.g. asserting that a
   *  saved active-view in a hidden group survives a workspace switch). */
  async writeActiveState(workspaceId: string, state: SavedActiveState): Promise<void> {
    await this.page.evaluate(
      ([prefix, id, value]) => {
        localStorage.setItem(`${prefix}${id}`, value);
      },
      [ACTIVE_STATE_KEY_PREFIX, workspaceId, JSON.stringify(state)] as const,
    );
  }

  /** Distance in CSS px between the right edge of the given inner
   *  container's visible header toolbar (the inner dockview's "Split
   *  right / Split down / +" action row) and the right edge of the
   *  viewport.
   *
   *  Geometric probe for the maximize-restore "ghost panel" regression
   *  (#490's flow): the toolbar is right-aligned inside the inner
   *  dockview's group header, so its right edge tracks the inner
   *  dockview's laid-out width. When the outer group is maximized the
   *  inner dockview must span the full grid — a small gap (≈ the header
   *  padding). If the inner splitview is stuck at a stale split width,
   *  the gap is roughly half the grid (the blank ghost region). Returns
   *  `null` while the toolbar has no box yet (callers poll). */
  async readToolbarRightGap(
    workspaceId: string,
    container: "terminal" | "browser",
  ): Promise<number | null> {
    const box = await this.centralToolbar(workspaceId, container).first().boundingBox();
    const viewport = this.page.viewportSize();
    if (!box || !viewport) return null;
    return viewport.width - (box.x + box.width);
  }

  /** Read the active view id for a specific group from the persisted
   *  state. Asserts the test's expectation that a hidden group's
   *  saved-view is preserved across workspace switches. */
  async readActiveViewForGroup(workspaceId: string, groupId: string): Promise<string | undefined> {
    const state = await this.readActiveState(workspaceId);
    return state?.groups[groupId];
  }

  /** Seed the shared global dockview layout (`band:dockview-layout-v7`)
   *  before the app mounts. Uses `addInitScript`, so it MUST run BEFORE
   *  the first `goto` — the value is applied to `localStorage` ahead of
   *  the page script, exactly like `installTerminalSocketInstrumentation`.
   *
   *  The empty default layout leaves all three edge groups collapsed and
   *  empty (so they render at zero size and there's nothing to observe a
   *  maximize collapsing). Seeding a layout that docks a panel into an
   *  edge group is the only non-flaky way to start with a populated,
   *  visible edge — dockview's edge docking is native HTML5 drag-and-drop,
   *  which is unreliable to drive through Playwright. */
  async seedGlobalLayout(layout: unknown): Promise<void> {
    await this.page.addInitScript((serialized) => {
      localStorage.setItem("band:dockview-layout-v7", serialized as string);
    }, JSON.stringify(layout));
  }

  /** The dockview bottom edge-group container that is currently on-screen.
   *
   *  dockview tags every edge-group shell element with a library-provided
   *  `data-testid` (`dv-edge-group-edge-<direction>`), and renders the
   *  bottom slot in more than one shell position — only the populated one
   *  is laid out at a non-zero size. Filtering to `visible` collapses that
   *  to the single on-screen instance, so the test can assert
   *  `toHaveCount(1)` (edge shown) vs `toHaveCount(0)` (edge collapsed to
   *  zero size while a group is maximized).
   *
   *  Using dockview's own testid here mirrors how the maximize spec already
   *  asserts on dockview-owned chrome (e.g. the `dv-active-tab` class on
   *  `.dv-tab`): the edge shell is third-party markup we don't render, so
   *  there's no BEM `data-testid` of our own to key off. */
  bottomEdgeGroup(): Locator {
    return this.page.getByTestId("dv-edge-group-edge-bottom").filter({ visible: true });
  }

  /** Reset the per-workspace shared-dockview state entry in
   *  `localStorage` and (re-)navigate to the workspace so the next
   *  mount runs against a clean slate. Two-step (matches
   *  `resetLabelStateAndGoto`): navigate first to land on the origin
   *  (localStorage isn't accessible until a same-origin page has
   *  loaded), then evaluate the clear. Centralises the
   *  `ACTIVE_STATE_KEY_PREFIX` key construction so test bodies don't
   *  rebuild the key inline.
   *
   *  IMPORTANT: the clear runs AFTER the initial `goto`, so the React
   *  tree's in-memory copy of the active state still reflects what was
   *  in storage at mount time. Tests that need a fully clean React
   *  state should follow up with another `goto(...)` (or `reload()`)
   *  before exercising layout behaviour. */
  async resetDockviewActiveStateAndGoto(workspaceId: string): Promise<void> {
    await test.step(`Reset dockview active state, navigate to ${workspaceId}`, async () => {
      await this.goto(workspaceId);
      await this.page.evaluate(
        ([prefix, id]) => {
          localStorage.removeItem(`${prefix}${id}`);
        },
        [ACTIVE_STATE_KEY_PREFIX, workspaceId] as const,
      );
    });
  }

  /** Fetch the persisted server-side dockview layout for the given
   *  inner container (`chat`, `terminal`, or `browser`). Each container
   *  has its own tRPC namespace (`chatLayout.get`, `terminalLayout.get`,
   *  `browserLayout.get`) that returns `{ tree }`; this helper unwraps
   *  the response and returns the parsed tree (or `null` when no layout
   *  has been persisted yet).
   *
   *  Used by the panel-default-position regression test to verify that
   *  newly-added panels end up in a central (grid-located) leaf instead
   *  of being appended into one of the three collapsed edge groups
   *  (`edge-left`, `edge-right`, `edge-bottom`) that `ensureEdgeGroups`
   *  adds in `onReady`. The return type narrows the response into the
   *  dockview-toJSON shape the test traverses — keeps dockview
   *  knowledge inside the page object so test bodies can skip casts. */
  async readInnerLayout(
    container: "chat" | "terminal" | "browser",
    workspaceId: string,
  ): Promise<DockviewLayoutSnapshot | null> {
    const procedure =
      container === "chat"
        ? "chatLayout.get"
        : container === "terminal"
          ? "terminalLayout.get"
          : "browserLayout.get";
    const input = encodeURIComponent(JSON.stringify({ workspaceId }));
    const res = await this.page.request.get(
      `${this.baseUrl}/trpc/${procedure}?input=${input}&token=${this.token}`,
    );
    if (!res.ok()) {
      throw new Error(`readInnerLayout(${container}) failed: ${res.status()} ${await res.text()}`);
    }
    const body = (await res.json()) as {
      result: { data: { tree: DockviewLayoutSnapshot | null } };
    };
    return body.result.data.tree;
  }

  /** Fire the `workspaces.create` mutation over HTTP with `via:
   *  "terminal"` — the same wire shape the Rust CLI sends after
   *  resolving the `--via` precedence chain (`cmd_workspaces_create`).
   *  Keeps the raw `page.request.post` out of test bodies (issue #551).
   *  Authenticates via the `band_token` cookie, mirroring how the
   *  dashboard's tRPC client reaches the server. Returns the unwrapped
   *  create payload so the test can assert on `via` / `terminalId` /
   *  `path`. */
  async createWorkspaceViaTerminal(
    project: string,
    branch: string,
    prompt: string,
  ): Promise<{ path: string; via?: string; terminalId?: string }> {
    const res = await this.page.request.post(`${this.baseUrl}/trpc/workspaces.create`, {
      headers: {
        "Content-Type": "application/json",
        Cookie: `band_token=${this.token}`,
      },
      data: { project, branch, prompt, via: "terminal" },
    });
    if (!res.ok()) {
      throw new Error(
        `createWorkspaceViaTerminal(${project}, ${branch}) failed: ${res.status()} ${await res.text()}`,
      );
    }
    const body = (await res.json()) as {
      result: { data: { path: string; via?: string; terminalId?: string } };
    };
    return body.result.data;
  }

  /** The QuickOpenDialog content root. `data-testid` is set on
   *  `DialogContent` in `QuickOpenDialog.tsx` — system-controlled,
   *  BEM convention — so the locator stays stable against placeholder
   *  string changes or visible-copy edits (the alternative
   *  `getByPlaceholder("Search files by name...")` would tie the test
   *  to a localisable English copy).
   *
   *  Used by tests that need to observe whether the dialog is mounted
   *  in response to a `band:open-file` event, particularly when proving
   *  cross-workspace event filtering (issue #539). */
  quickOpenDialog(): Locator {
    return this.page.getByTestId("quick-open__root");
  }

  /** The SearchFilesDialog content root. `data-testid` set on `DialogContent`
   *  in `SearchFilesDialog.tsx` (BEM convention), so the locator survives
   *  placeholder / visible-copy changes. */
  searchFilesDialog(): Locator {
    return this.page.getByTestId("search-files__root");
  }

  /** Dispatch the `band:open-quick-open` window event — the same event the
   *  file-tree toolbar's "Quick Open" action fires (see `CodeBrowserView.tsx`).
   *  On desktop `SharedDockviewLayout` listens for it; on mobile
   *  `MobileWorkspaceLayout` does. Either way it opens the QuickOpenDialog with
   *  an empty query (unlike `band:open-file`, which pre-fills a query and can
   *  auto-open a single match without ever showing the dialog). */
  async dispatchOpenQuickOpen(): Promise<void> {
    await test.step("Dispatch band:open-quick-open", async () => {
      await this.page.evaluate(() => {
        window.dispatchEvent(new CustomEvent("band:open-quick-open"));
      });
    });
  }

  /** Dispatch the `band:open-search-files` window event — the same event the
   *  file-tree toolbar's "Search in Files" action fires (see
   *  `CodeBrowserView.tsx`). On desktop `SharedDockviewLayout` listens for it;
   *  on mobile `MobileWorkspaceLayout` does. Either way it opens the
   *  SearchFilesDialog. Mirrors `dispatchOpenFileEvent`. */
  async dispatchOpenSearchFiles(): Promise<void> {
    await test.step("Dispatch band:open-search-files", async () => {
      await this.page.evaluate(() => {
        window.dispatchEvent(new CustomEvent("band:open-search-files"));
      });
    });
  }

  /** Bounding box of a locator once its open/slide animation has settled —
   *  used to assert bottom-drawer geometry deterministically. Throws if the
   *  element isn't rendered so a caller never asserts against `null`. */
  async settledBoxOf(
    locator: Locator,
  ): Promise<{ x: number; y: number; width: number; height: number }> {
    await locator.evaluate((el) =>
      Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))),
    );
    const box = await locator.boundingBox();
    if (!box) throw new Error("Locator has no bounding box (not visible)");
    return box;
  }

  /** Press Escape — the user's universal "dismiss" gesture. Encapsulated so
   *  test bodies (and the helpers below) don't reach for `page.keyboard.*`
   *  directly; keyboard interactions belong on the page object. */
  async pressEscape(): Promise<void> {
    await test.step("Press Escape", async () => {
      await this.page.keyboard.press("Escape");
    });
  }

  /** Dismiss the QuickOpenDialog via the Escape key — same path a
   *  real user would take. */
  async closeQuickOpenDialog(): Promise<void> {
    await this.pressEscape();
  }

  // ──────────────────────────────────────────────────────────────────────
  // Quick Open selection / scroll probes.
  //
  // The dialog is a cmdk `Command`; its input, list, and item rows carry the
  // `data-slot` attributes set by the `@band-app/ui` command wrappers plus the
  // `aria-selected` / `data-value` attributes cmdk owns. All locators below are
  // scoped to the QuickOpenDialog root so they never collide with the other
  // command palettes (workspace picker, command palette) mounted in the tree.
  // ──────────────────────────────────────────────────────────────────────

  /** The Quick Open search input. ARIA role is system-controlled (cmdk sets
   *  `role="combobox"`); scoped to the dialog root. */
  get quickOpenInput(): Locator {
    return this.quickOpenDialog().getByRole("combobox");
  }

  /** The scrollable results list — cmdk renders `role="listbox"` on
   *  `Command.List` (a system-controlled ARIA role), the element whose
   *  `scrollTop` the fix must reset to 0, so `getByRole("listbox")` is the
   *  correct locator. */
  get quickOpenList(): Locator {
    return this.quickOpenDialog().getByRole("listbox");
  }

  /** All rendered result rows — cmdk renders `role="option"` on every
   *  `Command.Item` (a system-controlled ARIA role), so `getByRole("option")`
   *  is the correct locator. Covers the file/recent rows plus any action row;
   *  the test reads each row's `data-value` (the file path) to reason about
   *  order and selection. */
  get quickOpenItems(): Locator {
    return this.quickOpenDialog().getByRole("option");
  }

  /** Open Quick Open via the same `band:open-quick-open` window event the file
   *  tree toolbar fires, then wait for the dialog to render. */
  async openQuickOpen(): Promise<void> {
    await test.step("Open Quick Open", async () => {
      await this.dispatchOpenQuickOpen();
      await this.quickOpenDialog().waitFor({ state: "visible" });
    });
  }

  /** Type a query into the Quick Open input (replacing any existing text), the
   *  way a user editing the search field would. Focuses first, selects all so
   *  the new text replaces a restored `lastQuery`, then types. */
  async typeQuickOpen(text: string): Promise<void> {
    await test.step(`Type Quick Open query "${text}"`, async () => {
      await this.quickOpenInput.focus();
      await this.page.keyboard.press("ControlOrMeta+a");
      await this.page.keyboard.type(text);
    });
  }

  /** Append text to the Quick Open query without clearing it — the way a user
   *  refining an existing search types the next character. Distinct from
   *  `typeQuickOpen`, which replaces the field: appending keeps the previously
   *  matched files continuously mounted, which is the exact condition under
   *  which the stale-selection bug reproduced. */
  async appendQuickOpen(text: string): Promise<void> {
    await test.step(`Append "${text}" to Quick Open query`, async () => {
      await this.quickOpenInput.focus();
      await this.page.keyboard.type(text);
    });
  }

  /** Clear the Quick Open input entirely (select-all + delete) so the empty-
   *  query recent-files view is shown. */
  async clearQuickOpenQuery(): Promise<void> {
    await test.step("Clear Quick Open query", async () => {
      await this.quickOpenInput.focus();
      await this.page.keyboard.press("ControlOrMeta+a");
      await this.page.keyboard.press("Delete");
    });
  }

  /** Press a key while the Quick Open input is focused — the real path for
   *  keyboard navigation (ArrowDown / ArrowUp / Enter). */
  async pressQuickOpenKey(key: string): Promise<void> {
    await test.step(`Press "${key}" in Quick Open`, async () => {
      await this.quickOpenInput.focus();
      await this.page.keyboard.press(key);
    });
  }

  /** Move the Quick Open selection onto the row whose `data-value` is `value`
   *  by stepping `ArrowDown` from the current position. Deterministic where
   *  cmdk's `End` binding is not: with focus in the search input, `End` is
   *  ambiguous with a caret-to-end-of-text move, so it can't be relied on to
   *  jump the list selection. `ArrowDown` is unambiguous and walks every row in
   *  DOM order until it wraps, so a bounded loop reaches any rendered row.
   *  Throws (rather than looping forever) if `value` is never selected.
   *  Precondition: the caller must have waited for the result count to settle
   *  (e.g. `expect.poll(() => quickOpenItems.count())`) — the press bound is
   *  snapshotted once, so a still-growing list could make it give up early. */
  async navigateQuickOpenTo(value: string): Promise<void> {
    await test.step(`Navigate Quick Open selection to "${value}"`, async () => {
      // One press per row is always enough to reach any row from any start
      // position; +2 leaves slack for the initial (already-selected) row and a
      // possible trailing action row without risking a wrap past the target.
      const maxPresses = (await this.quickOpenItems.count()) + 2;
      for (let i = 0; i < maxPresses; i++) {
        if ((await this.selectedQuickOpenValue()) === value) return;
        await this.pressQuickOpenKey("ArrowDown");
      }
      throw new Error(`Quick Open never selected "${value}" after ${maxPresses} ArrowDown presses`);
    });
  }

  /** The `data-value` (file path) of every rendered result row, in DOM order.
   *  cmdk mirrors each item's `value` prop onto its `data-value` attribute. */
  async quickOpenItemValues(): Promise<string[]> {
    return await this.quickOpenItems.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-value") ?? ""),
    );
  }

  /** The `data-value` of the single row cmdk currently marks
   *  `aria-selected="true"`, or `null` when nothing is selected. */
  async selectedQuickOpenValue(): Promise<string | null> {
    const selected = this.quickOpenDialog().getByRole("option", { selected: true });
    if ((await selected.count()) === 0) return null;
    return await selected.first().getAttribute("data-value");
  }

  /** Current `scrollTop` of the Quick Open results list. 0 ⇔ scrolled to top. */
  async quickOpenListScrollTop(): Promise<number> {
    return await this.quickOpenList.evaluate((el) => el.scrollTop);
  }

  /** Poll `read` until it returns the same value on two consecutive samples —
   *  i.e. the selection has settled — and return that stable value. Needed
   *  because the *pre-fix* palettes briefly highlight the first row while React
   *  re-renders a new result set, then snap the highlight back to a stale
   *  surviving row; a one-shot poll for "selection is first" would pass on that
   *  transient and miss the regression. The post-fix selection is first AND
   *  stays first, so the settled value is the honest signal for both.
   *
   *  The canonical stability-polling primitive for any cmdk dialog's selection;
   *  `protected` so a future dialog page object can reuse it. */
  protected async waitForStableSelection(
    read: () => Promise<string | null>,
  ): Promise<string | null> {
    let previous: string | null | undefined;
    await expect
      .poll(
        async () => {
          const current = await read();
          const isStable = previous !== undefined && current === previous;
          previous = current;
          return isStable;
        },
        {
          // Sample ~10 times at 200ms so a sub-render transient on slow CI
          // can't be mistaken for a settled value by two adjacent samples.
          intervals: [200, 200, 200, 200, 200, 200, 200, 200, 200, 200],
          timeout: 8000,
          message: "Quick Open / Search-in-Files selection never stabilized within 8s",
        },
      )
      .toBe(true);
    // The poll resolved on two consecutive equal samples, so `previous` holds
    // the settled value.
    return previous ?? null;
  }

  /** The Quick Open selection once it has settled — see `waitForStableSelection`. */
  async settledSelectedQuickOpenValue(): Promise<string | null> {
    return await this.waitForStableSelection(() => this.selectedQuickOpenValue());
  }

  // ──────────────────────────────────────────────────────────────────────
  // Search-in-Files selection / scroll probes.
  //
  // SearchFilesDialog is the sibling cmdk `Command` with `shouldFilter={false}`
  // — the same manual-filtering pattern as QuickOpen, so it carries the same
  // stale-selection contract: a new result set must snap the highlight to the
  // first row and scroll the list to the top. Its input is a custom `SearchBar`
  // textbox (not cmdk's `CommandInput`), but the rows are still cmdk items, so
  // the list/option/selected probes match the QuickOpen ones. All locators are
  // scoped to the SearchFilesDialog root.
  // ──────────────────────────────────────────────────────────────────────

  /** The Search-in-Files query input — the `SearchBar`'s plain `<input>`
   *  (role `textbox`), the only textbox inside the dialog. */
  get searchFilesInput(): Locator {
    return this.searchFilesDialog().getByRole("textbox");
  }

  /** The scrollable results list — cmdk renders `role="listbox"` on
   *  `Command.List`, the element whose `scrollTop` the fix resets to 0. */
  get searchFilesList(): Locator {
    return this.searchFilesDialog().getByRole("listbox");
  }

  /** All rendered content-match rows — cmdk renders `role="option"` on every
   *  `Command.Item`. Each row's `data-value` is `file:line:content`. */
  get searchFilesItems(): Locator {
    return this.searchFilesDialog().getByRole("option");
  }

  /** Open Search-in-Files via the same `band:open-search-files` window event
   *  the file-tree toolbar fires, then wait for the dialog to render. */
  async openSearchFiles(): Promise<void> {
    await test.step("Open Search in Files", async () => {
      await this.dispatchOpenSearchFiles();
      await this.searchFilesDialog().waitFor({ state: "visible" });
    });
  }

  /** Type a query into the Search-in-Files input, replacing any existing text
   *  (focus, select-all, type) the way a user editing the field would. */
  async typeSearchFiles(text: string): Promise<void> {
    await test.step(`Type Search-in-Files query "${text}"`, async () => {
      await this.searchFilesInput.focus();
      await this.page.keyboard.press("ControlOrMeta+a");
      await this.page.keyboard.type(text);
    });
  }

  /** Append text to the Search-in-Files query without clearing it — the way a
   *  user refining an existing search types the next character. Keeps the
   *  previously matched rows continuously mounted, the exact condition under
   *  which the stale-selection bug reproduces. */
  async appendSearchFiles(text: string): Promise<void> {
    await test.step(`Append "${text}" to Search-in-Files query`, async () => {
      await this.searchFilesInput.focus();
      await this.page.keyboard.type(text);
    });
  }

  /** Press a key while the Search-in-Files input is focused — ArrowDown /
   *  ArrowUp / Enter. */
  async pressSearchFilesKey(key: string): Promise<void> {
    await test.step(`Press "${key}" in Search in Files`, async () => {
      await this.searchFilesInput.focus();
      await this.page.keyboard.press(key);
    });
  }

  /** The `data-value` (`file:line:content`) of every rendered row, in DOM
   *  order. */
  async searchFilesItemValues(): Promise<string[]> {
    return await this.searchFilesItems.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-value") ?? ""),
    );
  }

  /** The `data-value` of the single row cmdk currently marks
   *  `aria-selected="true"`, or `null` when nothing is selected. */
  async selectedSearchFilesValue(): Promise<string | null> {
    const selected = this.searchFilesDialog().getByRole("option", { selected: true });
    if ((await selected.count()) === 0) return null;
    return await selected.first().getAttribute("data-value");
  }

  /** Current `scrollTop` of the Search-in-Files results list. */
  async searchFilesListScrollTop(): Promise<number> {
    return await this.searchFilesList.evaluate((el) => el.scrollTop);
  }

  /** The Search-in-Files selection once it has settled — see
   *  `waitForStableSelection`. */
  async settledSelectedSearchFilesValue(): Promise<string | null> {
    return await this.waitForStableSelection(() => this.selectedSearchFilesValue());
  }

  /** Move the Search-in-Files selection onto the row whose `data-value` is
   *  `value` by stepping ArrowDown (deterministic where cmdk's `End` is not —
   *  see `navigateQuickOpenTo`). Throws if `value` is never selected.
   *  Precondition: the caller must have waited for the result count to settle
   *  (the press bound is snapshotted once, as in `navigateQuickOpenTo`). */
  async navigateSearchFilesTo(value: string): Promise<void> {
    await test.step(`Navigate Search-in-Files selection to "${value}"`, async () => {
      const maxPresses = (await this.searchFilesItems.count()) + 2;
      for (let i = 0; i < maxPresses; i++) {
        if ((await this.selectedSearchFilesValue()) === value) return;
        await this.pressSearchFilesKey("ArrowDown");
      }
      throw new Error(
        `Search in Files never selected "${value}" after ${maxPresses} ArrowDown presses`,
      );
    });
  }

  /** Dispatch a synthetic `band:open-file` window event into the page
   *  context. Captures the cross-workspace routing contract under test:
   *  events addressed to a specific workspace must reach only THAT
   *  workspace's listener, while events with no `workspaceId` fall
   *  through to the currently-active workspace (backwards-compat for
   *  legacy / non-chat dispatchers). */
  async dispatchOpenFileEvent(opts: { filename: string; workspaceId?: string }): Promise<void> {
    const target = opts.workspaceId ? ` for workspace ${opts.workspaceId}` : "";
    await test.step(`Dispatch band:open-file for "${opts.filename}"${target}`, async () => {
      await this.page.evaluate(({ filename, workspaceId }) => {
        window.dispatchEvent(
          new CustomEvent("band:open-file", {
            detail: { filename, workspaceId },
          }),
        );
      }, opts);
    });
  }

  /** Dispatch a synthetic `band:lsp-navigate` window event — the same event
   *  the CodeMirror LSP client fires on go-to-definition (see
   *  `codemirror-lsp.ts`). Captures the cross-workspace routing contract under
   *  test: an LSP navigation belongs to the workspace that owns the editor, so
   *  a navigate addressed to workspace A must NOT drive the (different) active
   *  workspace B's CodeBrowserView to open A's relative path against B's root
   *  (ENOENT + poisoned `band-open-tabs:<B>`). Mirrors `dispatchOpenFileEvent`;
   *  an event with no `workspaceId` falls through to the active workspace
   *  (forward-compat). See the issue #539 pattern. */
  async dispatchLspNavigateEvent(opts: { filePath: string; workspaceId?: string }): Promise<void> {
    const target = opts.workspaceId ? ` for workspace ${opts.workspaceId}` : "";
    await test.step(`Dispatch band:lsp-navigate for "${opts.filePath}"${target}`, async () => {
      await this.page.evaluate(({ filePath, workspaceId }) => {
        window.dispatchEvent(
          new CustomEvent("band:lsp-navigate", {
            detail: { filePath, workspaceId },
          }),
        );
      }, opts);
    });
  }

  /** Dispatch a synthetic `band:editor-go-back` / `band:editor-go-forward`
   *  window event — the same events the command palette fires for the editor
   *  history "Go Back" / "Go Forward" commands (see `command-registry.ts` +
   *  `SharedDockviewLayout.tsx`). Captures the cross-workspace routing contract
   *  under test: an editor-history step belongs to the workspace that owns the
   *  editor, so a step addressed to workspace A must NOT also walk the (hidden)
   *  active workspace B's independent history stack. Mirrors
   *  `dispatchLspNavigateEvent`; a missing `workspaceId` falls through to the
   *  active workspace (forward-compat). See the issue #539 pattern. */
  async dispatchEditorHistoryEvent(opts: {
    direction: "back" | "forward";
    workspaceId?: string;
  }): Promise<void> {
    const eventName = opts.direction === "back" ? "band:editor-go-back" : "band:editor-go-forward";
    const target = opts.workspaceId ? ` for workspace ${opts.workspaceId}` : "";
    await test.step(`Dispatch ${eventName}${target}`, async () => {
      await this.page.evaluate(
        ({ name, workspaceId }) => {
          window.dispatchEvent(new CustomEvent(name, { detail: { workspaceId } }));
        },
        { name: eventName, workspaceId: opts.workspaceId },
      );
    });
  }

  /** Write the persisted open-tabs state for a workspace directly into
   *  localStorage under the key `band-open-tabs:<workspaceId>`. Used
   *  by tests that need to seed a "this workspace has a stale tab
   *  restored from a prior session" baseline, e.g. the self-heal
   *  regression for issue #539: a tab pointing at a path that doesn't
   *  exist on disk must be silently dropped on the next mount. */
  async writeOpenTabsState(
    workspaceId: string,
    state: { tabs: string[]; active: string | null },
  ): Promise<void> {
    await test.step(`Seed band-open-tabs:${workspaceId}`, async () => {
      await this.page.evaluate(
        ({ key, value }) => {
          localStorage.setItem(key, value);
        },
        { key: `band-open-tabs:${workspaceId}`, value: JSON.stringify(state) },
      );
    });
  }

  /** Read the persisted open-tabs state for a workspace out of
   *  localStorage. Returns `null` when the entry is missing or
   *  malformed (matches the runtime parse semantics in
   *  `parseTabState`). Used by self-heal regression tests to assert
   *  that a stale tab was actually removed from storage, not just
   *  hidden from the UI. */
  async readOpenTabsState(
    workspaceId: string,
  ): Promise<{ tabs: string[]; active: string | null } | null> {
    return await this.page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as { tabs?: unknown; active?: unknown };
        if (!Array.isArray(parsed.tabs)) return null;
        const tabs: string[] = [];
        for (const t of parsed.tabs) {
          if (typeof t === "string") tabs.push(t);
          else if (
            t !== null &&
            typeof t === "object" &&
            typeof (t as { filePath?: unknown }).filePath === "string"
          ) {
            tabs.push((t as { filePath: string }).filePath);
          }
        }
        const active = typeof parsed.active === "string" ? parsed.active : null;
        return { tabs, active };
      } catch {
        return null;
      }
    }, `band-open-tabs:${workspaceId}`);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Chat tab context menu ("Continue in terminal" / "Copy session ID").
  // The tab header is a dockview-rendered `.dv-default-tab`; we tag it with
  // `chat-tab__trigger--<chatId>` in `DockviewChatContainer.tsx`. chatIds
  // are client-generated, so the locator matches the testid PREFIX and the
  // single-chat workspaces these tests use resolve to `.first()`.
  // ──────────────────────────────────────────────────────────────────────

  /** The chat tab header (right-click target). The `data-testid` is
   *  `chat-tab__trigger--<chatId>` where the chatId suffix is generated at
   *  runtime, so we match the stable testid PREFIX with a regex (testid-first
   *  locator priority) and take `.first()` — the workspaces these tests seed
   *  have a single chat tab. */
  chatTabTrigger(): Locator {
    return this.page.getByTestId(/^chat-tab__trigger--/).first();
  }

  /** The opened chat-tab context menu content (portalled to body). */
  get chatTabContextMenu(): Locator {
    return this.page.getByTestId("chat-tab__context-menu");
  }

  /** "Continue in terminal" item. */
  get continueInTerminalItem(): Locator {
    return this.page.getByTestId("chat-tab__context-menu-item--continue-in-terminal");
  }

  /** "Copy session ID" item. */
  get copySessionIdItem(): Locator {
    return this.page.getByTestId("chat-tab__context-menu-item--copy-session-id");
  }

  /** Right-click the chat tab header to open its context menu. */
  async openChatTabContextMenu(): Promise<void> {
    await test.step("Right-click the chat tab to open its context menu", async () => {
      await this.chatTabTrigger().click({ button: "right" });
    });
  }

  /** Simulate a NON-secure context (`navigator.clipboard === undefined`,
   *  the LAN-IP / non-HTTPS-tunnel case) and capture the `execCommand("copy")`
   *  fallback's payload into `window.__copied`. Must run BEFORE `goto` (uses
   *  `addInitScript`) — same instrumentation pattern as
   *  `ChatPanePage.installOpenFileCapture`.
   *
   *  This deliberately removes `navigator.clipboard` so the test is a real
   *  regression guard: code that calls `navigator.clipboard.writeText`
   *  directly (instead of the shared `writeClipboardText` helper) silently
   *  no-ops here and leaves `__copied` empty, failing the assertion. The
   *  helper's `document.execCommand("copy")` fallback — the only path that
   *  works without a secure context — is what we record. */
  async installClipboardCapture(): Promise<void> {
    await this.page.addInitScript(() => {
      const w = window as unknown as { __copied: string[] };
      w.__copied = [];
      // No `navigator.clipboard` — forces the execCommand fallback path.
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: undefined,
      });
      // Capture the value the fallback copies. `writeClipboardText`'s legacy
      // path sets a textarea's value, calls `.select()` on it, then runs
      // `execCommand("copy")`. We record the selected textarea's value (the
      // `.select()` receiver, reliable regardless of headless focus quirks)
      // and push it when the matching `copy` command fires.
      let lastSelected = "";
      const originalSelect = HTMLTextAreaElement.prototype.select;
      HTMLTextAreaElement.prototype.select = function select(this: HTMLTextAreaElement) {
        lastSelected = this.value;
        return originalSelect.call(this);
      };
      const originalExec = document.execCommand.bind(document);
      document.execCommand = (commandId: string, ...rest: unknown[]): boolean => {
        if (commandId === "copy") {
          w.__copied.push(lastSelected);
          return true;
        }
        return (originalExec as (c: string, ...r: unknown[]) => boolean)(commandId, ...rest);
      };
    });
  }

  /** Read the strings captured by `installClipboardCapture()`. */
  async readCopied(): Promise<string[]> {
    return await this.page.evaluate(
      () => (window as unknown as { __copied?: string[] }).__copied ?? [],
    );
  }

  /** Patch `WebSocket.prototype.send` to record every STRING frame the page
   *  writes to a terminal socket (`/terminal?…`) into `window.__terminalSent`.
   *  Must run BEFORE `goto` (uses `addInitScript`). This is the deterministic
   *  proof surface for "Add to Terminal": the production path is
   *  `ws.send(reference)` → server → `pty.write`, and the terminal renders via
   *  a WebGL canvas whose text the DOM can't read, so capturing the outgoing
   *  frame is how the suite already asserts terminal I/O (cf.
   *  `installTerminalSocketInstrumentation`). Control frames (init/resize/ping)
   *  are JSON strings; the reference is a bare `path:line` string, so the two
   *  are trivially distinguishable in assertions. */
  async installTerminalSendCapture(): Promise<void> {
    await this.page.addInitScript(() => {
      const w = window as unknown as { __terminalSent: string[] };
      w.__terminalSent = [];
      const origSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function patchedSend(
        this: WebSocket,
        data: string | ArrayBufferLike | Blob | ArrayBufferView,
      ) {
        try {
          if (
            typeof this.url === "string" &&
            this.url.includes("/terminal?") &&
            typeof data === "string"
          ) {
            w.__terminalSent.push(data);
          }
        } catch {
          // Ignore — never let instrumentation break the real send.
        }
        return origSend.call(this, data as never);
      };
    });
  }

  /** Read the frames captured by `installTerminalSendCapture()`. */
  async readTerminalSent(): Promise<string[]> {
    return await this.page.evaluate(
      () => (window as unknown as { __terminalSent?: string[] }).__terminalSent ?? [],
    );
  }

  /** Like `installTerminalSendCapture`, but records each STRING frame together
   *  with the socket URL it was written to (`/terminal?…&terminalId=<id>`) so a
   *  test with several open terminals can prove WHICH terminal received a
   *  reference. Must run BEFORE `goto` (uses `addInitScript`). */
  async installTerminalSendUrlCapture(): Promise<void> {
    await this.page.addInitScript(() => {
      const w = window as unknown as { __terminalSentUrls: { url: string; data: string }[] };
      w.__terminalSentUrls = [];
      const origSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function patchedSend(
        this: WebSocket,
        data: string | ArrayBufferLike | Blob | ArrayBufferView,
      ) {
        try {
          if (
            typeof this.url === "string" &&
            this.url.includes("/terminal?") &&
            typeof data === "string"
          ) {
            w.__terminalSentUrls.push({ url: this.url, data });
          }
        } catch {
          // Ignore — never let instrumentation break the real send.
        }
        return origSend.call(this, data as never);
      };
    });
  }

  /** The terminalIds whose socket received a frame containing `needle`. Reads
   *  the `{url, data}` pairs captured by `installTerminalSendUrlCapture()` and
   *  extracts each matching frame's `terminalId` query param. Used to assert a
   *  reference reached exactly the last-focused terminal and no sibling. */
  async terminalIdsThatReceived(needle: string): Promise<string[]> {
    return await this.page.evaluate((n) => {
      const frames =
        (window as unknown as { __terminalSentUrls?: { url: string; data: string }[] })
          .__terminalSentUrls ?? [];
      const ids = new Set<string>();
      for (const f of frames) {
        if (!f.data.includes(n)) continue;
        const id = new URL(f.url).searchParams.get("terminalId");
        if (id) ids.add(id);
      }
      return [...ids];
    }, needle);
  }

  /** Click into the Nth terminal pane's render surface so it becomes the active
   *  (focused) terminal — what the container reports to the server as the
   *  workspace's last-focused terminal. `.xterm-screen` is xterm-owned DOM (no
   *  testid to hook; same FRAGILITY carve-out as the other xterm probes here),
   *  and clicking it routes focus through xterm → dockview's focusin tracking. */
  async focusTerminalPane(index: number): Promise<void> {
    await test.step(`Focus terminal pane #${index}`, async () => {
      await this.page.locator(".xterm-screen").nth(index).click();
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Terminal file links → file browser
  // ──────────────────────────────────────────────────────────────────────

  /** Read the workspace-relative paths of the file tabs the file browser
   *  has open, from the `band-open-tabs:<workspaceId>` localStorage entry
   *  `useFileTabs` persists. Returns `[]` when nothing is open yet. Used to
   *  prove a clicked terminal link actually opened its file in the browser.
   *  Delegates to `readOpenTabsState` so the persisted-tab parse lives in one
   *  place. */
  async readOpenTabPaths(workspaceId: string): Promise<string[]> {
    return (await this.readOpenTabsState(workspaceId))?.tabs ?? [];
  }

  /** Click a file-path link rendered in the terminal output.
   *
   *  xterm paints to a `<canvas>` under the WebGL renderer (no hittable DOM
   *  text), so tests that need to click rendered glyphs force the DOM
   *  renderer via `seedSettings({ useWebGLTerminalRenderer: false })`. With
   *  that renderer the visible buffer lives as real text in `.xterm-rows >
   *  div` — library-owned DOM with no `data-testid`, so a class selector is
   *  the only hook (same carve-out the WebGL-surface probes above rely on).
   *
   *  We locate the output row whose trimmed text exactly equals `text`
   *  (the bare path printed on its own line — distinct from the echoed
   *  command line that carries an `echo `/prompt prefix), then click a few
   *  pixels in from its left edge. The path starts at column 0, so that
   *  point lands on its first character — inside the link range the file
   *  link provider registered — regardless of cell width. A `mouse.move`
   *  precedes the click so xterm's link layer resolves the hovered line
   *  before activation. */
  async clickTerminalFileLink(text: string): Promise<void> {
    await test.step(`Click terminal file link "${text}"`, async () => {
      const rect = await this.waitForTerminalRowRect(text);
      const y = rect.y + rect.height / 2;
      // xterm paints the link to a surface with no per-link DOM node, so we
      // hover the row to make its linkifier resolve the link, then click.
      // The path is printed at column 0, but the exact cell width varies with
      // the monospace font (CI's Linux fallback differs from local), so rather
      // than assume a fixed pixel offset we sweep x across the left of the row
      // and click the first point xterm reports as a link hover — it toggles
      // `xterm-cursor-pointer` on the terminal element while the pointer sits
      // over a link cell. Sweeping also absorbs any small offset between the
      // row's bounding box and xterm's internal hit-test grid. A fixed offset
      // is what made this flaky in CI while passing locally.
      const maxDx = Math.min(rect.width - 2, 200);
      for (let dx = 3; dx <= maxDx; dx += 6) {
        const x = rect.x + dx;
        await this.page.mouse.move(x, y);
        const hovered = await this.page
          .locator(".xterm-cursor-pointer")
          .first()
          .waitFor({ state: "attached", timeout: 500 })
          .then(
            () => true,
            () => false,
          );
        if (hovered) {
          await this.page.mouse.click(x, y);
          return;
        }
      }
      // No hover registered anywhere along the row — click the left edge so
      // the spec's outcome assertion fails against the real (un-opened) state
      // rather than this helper swallowing the miss.
      await this.page.mouse.click(rect.x + 4, y);
    });
  }

  /** Poll the DOM-renderer rows until one whose trimmed text equals `text`
   *  is painted, returning its viewport rectangle. */
  private async waitForTerminalRowRect(
    text: string,
  ): Promise<{ x: number; y: number; width: number; height: number }> {
    let rect: { x: number; y: number; width: number; height: number } | null = null;
    await expect
      .poll(
        async () => {
          rect = await this.page.evaluate((target) => {
            const rows = Array.from(document.querySelectorAll<HTMLElement>(".xterm-rows > div"));
            const row = rows.find((r) => (r.textContent ?? "").trim() === target);
            if (!row) return null;
            const r = row.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          }, text);
          return rect;
        },
        { timeout: 15_000 },
      )
      .not.toBeNull();
    // `rect` is set on the last (passing) poll iteration.
    return rect!;
  }
}

/** Narrowed shape for what `*.Layout.get` returns. Mirrors the parts of
 *  `dockview.toJSON()` the regression test traverses (`grid.root` walk
 *  + `panels` lookup); other fields are ignored. Lives at the bottom of
 *  the page-object file so callers get a typed return from
 *  `readInnerLayout` without re-deriving the shape inline. */
export interface DockviewLayoutSnapshot {
  grid?: {
    root?: DockviewGridNode;
  };
  panels: Record<string, unknown>;
}

export type DockviewGridNode =
  | { type: "leaf"; data: { id: string; views: string[]; activeView?: string } }
  | { type: "branch"; data: DockviewGridNode[] };
