/**
 * Pure helpers for the per-workspace dockview "active state" — the slice
 * of UI state that's specific to a single workspace and lives ALONGSIDE
 * the shared layout structure (which is global across workspaces).
 *
 * Today this covers:
 *   - which group is the active group;
 *   - which view is active inside each tab group;
 *   - which group (if any) is currently maximized.
 *
 * Extracted out of `SharedDockviewLayout.tsx` so the round-trip logic
 * (save → load → re-apply) can be exercised in isolation without React
 * or a live dockview instance.
 */

/** Per-workspace active-tab + maximize state, persisted as JSON to
 * `localStorage` under `band:dockview-active:${workspaceId}`. */
export interface ActiveTabState {
  /** Id of the group that's currently active (focused). */
  activeGroup?: string;
  /** groupId → id of the view that's active inside that group. */
  groups: Record<string, string>;
  /**
   * Id of the group that's currently maximized for this workspace, or
   * undefined when no group is maximized.
   *
   * Unlike `activeGroup` / `groups`, this isn't captured from the
   * dockview's serialized JSON — `toJSON()` doesn't include maximize
   * state, since maximize is a transient runtime overlay. Callers
   * populate this field explicitly via `findMaximizedGroupId(api)`.
   */
  maximizedGroup?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: recursive grid JSON
export function walkGridNode(node: any, callback: (leaf: any) => void): void {
  if (!node) return;
  if (node.type === "leaf") {
    callback(node);
  } else if (node.type === "branch" && Array.isArray(node.data)) {
    for (const child of node.data) {
      walkGridNode(child, callback);
    }
  }
}

/**
 * Read the per-workspace active state out of a serialized dockview
 * layout. The maximize state can't be recovered from JSON; callers that
 * care should populate `maximizedGroup` separately via
 * `findMaximizedGroupId(api)` before persisting.
 */
export function extractActiveState(json: Record<string, unknown>): ActiveTabState {
  const state: ActiveTabState = { groups: {} };
  // Dockview's serialized output uses two different keys for the
  // "currently active group" idea depending on direction of travel:
  //   - `toJSON()` emits it as `activeGroup`.
  //   - `applyActiveState(...)` (in this file) overlays it as
  //     `activePanel` to match the shape `fromJSON(...)` expects on
  //     the way back in.
  // Either may be present (toJSON output, or a layout we've already
  // overlaid). Prefer `activePanel` when both are set so the
  // overlay-then-extract round trip stays consistent; fall back to
  // `activeGroup` otherwise.
  if (typeof json.activePanel === "string") {
    state.activeGroup = json.activePanel;
  } else if (typeof json.activeGroup === "string") {
    state.activeGroup = json.activeGroup;
  }
  const grid = json.grid as Record<string, unknown> | undefined;
  if (grid?.root) {
    walkGridNode(grid.root, (leaf) => {
      const data = leaf.data;
      if (data?.id && data?.activeView) {
        state.groups[data.id] = data.activeView;
      }
    });
  }
  return state;
}

/**
 * Overlay per-workspace active-tab state back onto a serialized layout
 * before handing it to `api.fromJSON(...)`. Only the active-tab fields
 * are folded in; the maximize state has to be re-applied through the
 * live api (see `applyMaximizedGroupToApi`) because dockview doesn't
 * model "maximized group" in its serialized form.
 */
export function applyActiveState(json: Record<string, unknown>, state: ActiveTabState): void {
  if (state.activeGroup) {
    json.activePanel = state.activeGroup;
  }
  const grid = json.grid as Record<string, unknown> | undefined;
  if (grid?.root) {
    walkGridNode(grid.root, (leaf) => {
      const data = leaf.data;
      if (data?.id && state.groups[data.id]) {
        data.activeView = state.groups[data.id];
      }
    });
  }
}

/**
 * Minimal subset of `DockviewApi` we need to read/apply the maximize
 * state. Kept narrow so tests can pass a hand-rolled fake without
 * pulling in the whole dockview module.
 */
export interface MaximizeApi {
  hasMaximizedGroup(): boolean;
  exitMaximizedGroup(): void;
  readonly groups: ReadonlyArray<MaximizeGroup>;
}

export interface MaximizeGroup {
  readonly id: string;
  readonly api: {
    isMaximized(): boolean;
    maximize(): void;
    exitMaximized(): void;
    readonly location: { type: string };
  };
}

/**
 * Return the id of the currently-maximized group, or undefined when no
 * group is maximized. We only consider "grid"-located groups — edge
 * groups (left/right/bottom shells) and floating/popout groups don't
 * surface a maximize button in the Band UI and shouldn't appear here.
 */
export function findMaximizedGroupId(api: MaximizeApi): string | undefined {
  if (!api.hasMaximizedGroup()) return undefined;
  for (const g of api.groups) {
    if (g.api.location.type === "grid" && g.api.isMaximized()) {
      return g.id;
    }
  }
  return undefined;
}

/**
 * Drive the live dockview to match the saved `maximizedGroup` for the
 * incoming workspace. Idempotent: when the requested state already
 * matches the live state we skip the api calls so we don't fire
 * spurious `onDidMaximizedGroupChange` events (which would re-trigger
 * `saveLayout`).
 *
 * The behaviour matrix, given `desired` (the saved maximized group id
 * for the workspace we're switching INTO):
 *
 *   live state             | desired       | action
 *   -----------------------+---------------+------------------------------
 *   no group maximized     | undefined     | no-op
 *   no group maximized     | "g1"          | maximize g1 (if it exists)
 *   g1 maximized           | undefined     | exitMaximizedGroup()
 *   g1 maximized           | "g1"          | no-op
 *   g1 maximized           | "g2"          | exit + maximize g2
 *
 * If `desired` names a group that doesn't exist (e.g. stale state from
 * a layout that's since been edited) we just exit any current maximize
 * rather than restoring nothing — safer than leaving the previous
 * workspace's maximize visible under a workspace that "shouldn't" have
 * one. Edge / floating / popout groups are also rejected.
 */
export function applyMaximizedGroupToApi(api: MaximizeApi, desired: string | undefined): void {
  const current = findMaximizedGroupId(api);
  if (current === desired) return;

  // Always exit the previous maximize before entering a new one — dockview
  // only supports one maximized group at a time, and toggling without an
  // explicit exit can leave the UI in a weird in-between state on some
  // versions.
  if (api.hasMaximizedGroup()) {
    api.exitMaximizedGroup();
  }

  if (!desired) return;

  const next = api.groups.find((g) => g.id === desired);
  if (!next) return;
  if (next.api.location.type !== "grid") return;
  if (next.api.isMaximized()) return;
  next.api.maximize();
}

/**
 * Minimal subset of the dockview api needed to walk panels and activate
 * one. Decoupled from `dockview-react` so this helper can be unit-tested
 * with a hand-rolled fake.
 */
export interface ActiveViewsApi {
  getPanel(id: string): GroupAwarePanel | undefined;
}

export interface GroupAwarePanel {
  readonly api: { readonly isActive: boolean; setActive(): void };
  readonly group: { readonly panels: ReadonlyArray<unknown> };
}

/**
 * Drive the live dockview's per-group active view to match the saved
 * `state.groups` map for the incoming workspace. Idempotent: panels that
 * are already active in their group are skipped (so dockview doesn't fire
 * a no-op focus event that would scroll the project list back to the top
 * — see `SharedDockviewLayout.tsx` for the original rationale on
 * the workspace-switch effect).
 *
 * Called from two places:
 *
 *   1. Dockview's `onReady`, for the INITIAL mount — without this the
 *      first page load wouldn't apply per-group active tabs because the
 *      workspace-switch useEffect short-circuits on `!initializedRef.current`
 *      and never re-fires (its dep `[activeWorkspaceId]` is unchanged).
 *
 *   2. The workspace-switch useEffect, on every subsequent
 *      `activeWorkspaceId` change.
 *
 * Both call sites also call `applyMaximizedGroupToApi` afterwards, so the
 * maximize re-asserts itself over the top of any `setActive`-driven
 * implicit maximize exits.
 */
export function applyGroupActiveViewsToApi(api: ActiveViewsApi, state: ActiveTabState): void {
  try {
    for (const viewId of Object.values(state.groups)) {
      const panel = api.getPanel(viewId);
      if (!panel) continue;
      // Already the active panel — skip to avoid dockview's focus-fire
      // side effect (resets project-list scroll on the projects edge
      // group, refocuses tab content elsewhere).
      if (panel.api.isActive) continue;
      // Single-panel groups (e.g. the projects edge group) have nothing
      // to switch to; the focus side effect would also kick in here.
      if (panel.group.panels.length <= 1) continue;
      panel.api.setActive();
    }
  } catch {
    // Best-effort — the workspace-switch path runs on every navigation
    // and one stale panel id shouldn't break the others.
  }
}
