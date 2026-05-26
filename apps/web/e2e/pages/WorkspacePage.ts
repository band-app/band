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
 * preferred locator per `docs/frontend-testing.md` §7.
 */

import { type Locator, type Page, test } from "@playwright/test";
import { LABEL_LAST_WORKSPACE_KEY } from "../../src/dashboard/hooks/use-label-last-workspace";

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
      // Wait until the previous portal (if any) has finished its fade-out
      // before opening a new one. The trigger is always in the DOM, so
      // we anchor on the item we expect to disappear after a previous
      // selection.
      await this.labelFilterItem(labelId).waitFor({ state: "hidden" });
      await this.labelFilterTrigger().click();
      const item = this.labelFilterItem(labelId);
      await item.waitFor({ state: "visible" });
      await item.click();
      // Wait for the menu to close so the next call can detect its
      // own "previous portal gone" state cleanly.
      await item.waitFor({ state: "hidden" });
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
}
