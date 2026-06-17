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

  /** The "Collapse"/"Expand" item in a git project's context menu. Located
   *  by its `data-testid` rather than its localisable visible text, which
   *  would tie the locator to English UI copy. */
  get collapseMenuItem(): Locator {
    return this.page.getByTestId("project-list__context-menu-item--collapse");
  }

  /** Right-click a project header to open its context menu. */
  async openProjectContextMenu(projectName: string): Promise<void> {
    await test.step(`Open context menu for project ${projectName}`, async () => {
      await this.projectHeader(projectName).click({ button: "right" });
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

  /** Click the collapse/expand item via a normal left click. */
  async clickCollapseMenuItem(): Promise<void> {
    await test.step("Click the collapse/expand menu item", async () => {
      await this.collapseMenuItem.click();
    });
  }

  /** Dispatch the bug-triggering synthetic right-button pointer sequence
   *  directly on the collapse menu item: a `pointermove` (cursor over the
   *  item) followed by a `button=2` `pointerup` with no matching
   *  `pointerdown` — the exact pattern Radix's `MenuItem` heuristic
   *  mistakes for a click. `bubbles: true` is required so the event reaches
   *  React's root listener. */
  async dispatchRightButtonPointerUpOnCollapseItem(): Promise<void> {
    await test.step("Dispatch right-button pointerup on the collapse item", async () => {
      await this.collapseMenuItem.evaluate((el) => {
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
   *  Only the SharedDockviewLayout's DashboardShell is mounted on
   *  desktop (see `apps/web/src/routes/index.tsx` and the comment in
   *  `SharedDockviewLayout` § ProjectsPanelComponent), so a single
   *  trigger / item pair is in the DOM at any time. The Radix
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

  /** The mobile header's back button — navigates (in-app) to the project
   *  list at `/`. aria-label set in MobileWorkspaceLayout. */
  get backToProjectListButton(): Locator {
    return this.page.getByRole("button", { name: "Back to project list" });
  }

  /** Open the workspace switcher from the mobile header title. */
  async openSwitcherFromHeader(): Promise<void> {
    await test.step("Tap the mobile header title to open the workspace switcher", async () => {
      await this.switchWorkspaceButton.click();
    });
  }

  /** Tap the mobile header back button to return to the project list via
   *  client-side navigation (not a full reload — so the in-memory
   *  `activeWorkspaceId` store survives, which is the behaviour the
   *  active-persistence test asserts). */
  async goBackToProjectList(): Promise<void> {
    await test.step("Tap back to project list", async () => {
      await this.backToProjectListButton.click();
    });
  }

  /** Open the workspace picker on desktop via its Ctrl+R shortcut. The
   *  handler lives on a window keydown listener in
   *  `SharedDockviewLayout.tsx`; it ignores the shortcut while the
   *  terminal is focused, so we route the keypress through the project
   *  list root (focusable, non-editable) — the same anchor the label
   *  shortcut test uses. */
  async openWorkspacePickerViaShortcut(): Promise<void> {
    await test.step("Open workspace picker (Ctrl+R)", async () => {
      const root = this.projectListRoot();
      await root.waitFor({ state: "visible" });
      await root.press("Control+r");
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
    await test.step("Activate the Terminal tab", async () => {
      await this.tab("terminal").click();
    });
  }

  /** Wait for the terminal's xterm input to be attached — the DOM-level
   *  signal that the xterm instance mounted. xterm keeps its input as an
   *  offscreen "helper" textarea (Playwright reports it as hidden, never
   *  "visible"), so we wait for `attached`, not `visible`. */
  async waitForTerminalReady(): Promise<void> {
    await this.terminalInput.first().waitFor({ state: "attached", timeout: 15_000 });
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

  /** Read the active view id for a specific group from the persisted
   *  state. Asserts the test's expectation that a hidden group's
   *  saved-view is preserved across workspace switches. */
  async readActiveViewForGroup(workspaceId: string, groupId: string): Promise<string | undefined> {
    const state = await this.readActiveState(workspaceId);
    return state?.groups[groupId];
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

  /** Dismiss the QuickOpenDialog via the Escape key — same path a
   *  real user would take. Encapsulated here so test bodies don't
   *  reach for `page.keyboard.*` directly. */
  async closeQuickOpenDialog(): Promise<void> {
    await test.step("Press Escape to close Quick Open dialog", async () => {
      await this.page.keyboard.press("Escape");
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
