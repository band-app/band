/**
 * Page object for the workspace dockview route (`/workspace/:id/code`).
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

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.maximizeButtons = page.getByRole("button", { name: "Maximize" });
    this.restoreButton = page.getByRole("button", { name: "Restore" });
    this.terminalInput = page.getByRole("textbox", { name: "Terminal input" });
    this.changesHeading = page.getByRole("heading", { name: "Files changed" });
  }

  /** Navigate to the code view of the given workspace. The only place
   *  in this page object where a URL is constructed. */
  async goto(workspaceId: string): Promise<void> {
    const url = `${this.baseUrl}/workspace/${encodeURIComponent(workspaceId)}/code?token=${this.token}`;
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
