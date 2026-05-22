/**
 * Pure-function tests for the per-workspace dockview active-state
 * helpers. These cover the round-trip of:
 *
 *   - active-tab state extracted from a serialized layout, applied back
 *     to a layout for restoration;
 *   - maximize state captured from a live dockview-style api, applied
 *     back via a fake api to verify the maximize/exit/no-op behaviour
 *     matrix.
 *
 * The fake api implements the narrow `MaximizeApi` surface that the
 * helpers depend on — explicitly NOT the full DockviewApi — so the
 * tests act as a contract pinning what `applyMaximizedGroupToApi`
 * actually touches.
 */

import { describe, expect, it } from "vitest";
import {
  type ActiveTabState,
  applyActiveState,
  applyMaximizedGroupToApi,
  extractActiveState,
  findMaximizedGroupId,
  type MaximizeApi,
  type MaximizeGroup,
} from "../src/lib/dockview-active-state";

// ---------------------------------------------------------------------------
// Fake dockview api implementing only `MaximizeApi`
// ---------------------------------------------------------------------------

interface FakeGroupOptions {
  id: string;
  maximized?: boolean;
  location?: string;
}

function makeFakeApi(groupOpts: FakeGroupOptions[]): MaximizeApi & {
  calls: Array<{ kind: "maximize" | "exitMaximized" | "exitMaximizedGroup"; id?: string }>;
} {
  const calls: Array<{ kind: "maximize" | "exitMaximized" | "exitMaximizedGroup"; id?: string }> =
    [];

  const groups: MaximizeGroup[] = groupOpts.map((opt) => {
    const state = {
      maximized: opt.maximized ?? false,
      location: opt.location ?? "grid",
    };
    const group: MaximizeGroup = {
      id: opt.id,
      api: {
        isMaximized: () => state.maximized,
        maximize: () => {
          calls.push({ kind: "maximize", id: opt.id });
          // Mimic dockview's "only one group can be maximized at a time" rule.
          for (const g of groups) {
            const inner = (g.api as unknown as { __state: { maximized: boolean } }).__state;
            if (inner) inner.maximized = false;
          }
          state.maximized = true;
        },
        exitMaximized: () => {
          calls.push({ kind: "exitMaximized", id: opt.id });
          state.maximized = false;
        },
        get location() {
          return { type: state.location };
        },
      },
    };
    // Expose the inner state mutation hook used by the maximize() shim
    // above without leaking it on the public type.
    (group.api as unknown as { __state: typeof state }).__state = state;
    return group;
  });

  return {
    groups,
    hasMaximizedGroup: () => groups.some((g) => g.api.isMaximized()),
    exitMaximizedGroup: () => {
      calls.push({ kind: "exitMaximizedGroup" });
      for (const g of groups) {
        const state = (g.api as unknown as { __state: { maximized: boolean } }).__state;
        if (state) state.maximized = false;
      }
    },
    calls,
  };
}

// ---------------------------------------------------------------------------
// extractActiveState / applyActiveState
// ---------------------------------------------------------------------------

describe("extractActiveState", () => {
  it("returns an empty state for a layout with no grid", () => {
    expect(extractActiveState({})).toEqual({ groups: {} });
  });

  it("captures activeGroup from the top-level field", () => {
    const state = extractActiveState({ activeGroup: "g1" });
    expect(state.activeGroup).toBe("g1");
  });

  it("captures active view ids from leaf nodes", () => {
    const state = extractActiveState({
      activeGroup: "g1",
      grid: {
        root: {
          type: "branch",
          data: [
            {
              type: "leaf",
              data: { id: "g1", activeView: "chat", views: ["chat", "changes"] },
            },
            {
              type: "leaf",
              data: { id: "g2", activeView: "files", views: ["files", "terminal"] },
            },
          ],
        },
      },
    });
    expect(state).toEqual({
      activeGroup: "g1",
      groups: { g1: "chat", g2: "files" },
    });
  });

  it("does not capture maximizedGroup from the serialized layout (must be set explicitly)", () => {
    // Dockview's `toJSON` omits maximize state, so a layout-only extract
    // should leave the field undefined. Callers populate it through
    // `findMaximizedGroupId(api)`.
    const state = extractActiveState({ activeGroup: "g1" });
    expect(state.maximizedGroup).toBeUndefined();
  });
});

describe("applyActiveState", () => {
  it("writes activeGroup into activePanel and active views into leaf data", () => {
    const layout: Record<string, unknown> = {
      grid: {
        root: {
          type: "branch",
          data: [{ type: "leaf", data: { id: "g1", views: ["chat", "files"] } }],
        },
      },
    };
    applyActiveState(layout, { activeGroup: "g1", groups: { g1: "files" } });
    expect(layout.activePanel).toBe("g1");
    const leaf = (layout.grid as { root: { data: Array<{ data: { activeView?: string } }> } }).root
      .data[0];
    expect(leaf.data.activeView).toBe("files");
  });

  it("ignores group entries that don't match any leaf", () => {
    const layout: Record<string, unknown> = {
      grid: {
        root: {
          type: "leaf",
          data: { id: "g1", views: ["chat"] },
        },
      },
    };
    applyActiveState(layout, { groups: { g2: "files" } });
    const leaf = layout.grid as { root: { data: { activeView?: string } } };
    expect(leaf.root.data.activeView).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findMaximizedGroupId
// ---------------------------------------------------------------------------

describe("findMaximizedGroupId", () => {
  it("returns undefined when no group is maximized", () => {
    const api = makeFakeApi([
      { id: "g1", maximized: false },
      { id: "g2", maximized: false },
    ]);
    expect(findMaximizedGroupId(api)).toBeUndefined();
  });

  it("returns the id of the currently maximized grid group", () => {
    const api = makeFakeApi([
      { id: "g1", maximized: false },
      { id: "g2", maximized: true },
    ]);
    expect(findMaximizedGroupId(api)).toBe("g2");
  });

  it("ignores non-grid (edge / floating) groups even when isMaximized() lies", () => {
    // Edge groups don't surface a maximize button in the UI, but a stale
    // saved-state could in principle restore one. The helper filters
    // them out as a defense-in-depth check.
    const api = makeFakeApi([
      { id: "edge-left", maximized: true, location: "popout" },
      { id: "g1", maximized: false },
    ]);
    expect(findMaximizedGroupId(api)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyMaximizedGroupToApi
// ---------------------------------------------------------------------------

describe("applyMaximizedGroupToApi", () => {
  it("is a no-op when there is no maximize and none is desired", () => {
    const api = makeFakeApi([{ id: "g1" }, { id: "g2" }]);
    applyMaximizedGroupToApi(api, undefined);
    expect(api.calls).toEqual([]);
  });

  it("maximizes the desired group when none is currently maximized", () => {
    const api = makeFakeApi([{ id: "g1" }, { id: "g2" }]);
    applyMaximizedGroupToApi(api, "g2");
    expect(api.calls).toEqual([{ kind: "maximize", id: "g2" }]);
    expect(findMaximizedGroupId(api)).toBe("g2");
  });

  it("exits the current maximize when nothing is desired", () => {
    const api = makeFakeApi([{ id: "g1", maximized: true }, { id: "g2" }]);
    applyMaximizedGroupToApi(api, undefined);
    expect(api.calls).toEqual([{ kind: "exitMaximizedGroup" }]);
    expect(findMaximizedGroupId(api)).toBeUndefined();
  });

  it("is a no-op when the desired state already matches", () => {
    const api = makeFakeApi([{ id: "g1", maximized: true }, { id: "g2" }]);
    applyMaximizedGroupToApi(api, "g1");
    // No calls at all — critically, we don't emit any maximize/exit
    // events that would re-trigger `saveLayout` and cause cascading
    // writes during the workspace-switch effect.
    expect(api.calls).toEqual([]);
  });

  it("swaps maximize from one group to another", () => {
    const api = makeFakeApi([{ id: "g1", maximized: true }, { id: "g2" }]);
    applyMaximizedGroupToApi(api, "g2");
    // Must exit g1's maximize before maximizing g2 — dockview only
    // supports one maximized group at a time.
    expect(api.calls).toEqual([{ kind: "exitMaximizedGroup" }, { kind: "maximize", id: "g2" }]);
    expect(findMaximizedGroupId(api)).toBe("g2");
  });

  it("clears any existing maximize when the desired group no longer exists", () => {
    // Defensive: a stale saved-state could reference a group that's
    // since been removed (panel deletion, layout rebuild). We exit any
    // current maximize rather than leaving the previous workspace's
    // overlay visible.
    const api = makeFakeApi([{ id: "g1", maximized: true }]);
    applyMaximizedGroupToApi(api, "ghost-group");
    expect(api.calls).toEqual([{ kind: "exitMaximizedGroup" }]);
    expect(findMaximizedGroupId(api)).toBeUndefined();
  });

  it("refuses to maximize a non-grid group (edge / popout)", () => {
    const api = makeFakeApi([{ id: "edge-left", location: "popout" }, { id: "g1" }]);
    applyMaximizedGroupToApi(api, "edge-left");
    expect(api.calls).toEqual([]);
    expect(findMaximizedGroupId(api)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// End-to-end round trip: save → load → apply
// ---------------------------------------------------------------------------

describe("active-state save/load round trip with maximize", () => {
  it("captures + restores maximizedGroup across a JSON serialize boundary", () => {
    // Simulate the save side: extract from layout, augment with live
    // maximize state, serialize to localStorage.
    const layout: Record<string, unknown> = {
      activeGroup: "g1",
      grid: {
        root: { type: "leaf", data: { id: "g1", activeView: "chat", views: ["chat"] } },
      },
    };
    const api = makeFakeApi([{ id: "g1", maximized: true }]);

    const saved: ActiveTabState = extractActiveState(layout);
    saved.maximizedGroup = findMaximizedGroupId(api);
    const serialized = JSON.stringify(saved);

    // Simulate the load side on a different "session": parse the saved
    // state and apply it to a fresh live api.
    const loaded = JSON.parse(serialized) as ActiveTabState;
    expect(loaded.maximizedGroup).toBe("g1");

    const freshApi = makeFakeApi([{ id: "g1" }]);
    applyMaximizedGroupToApi(freshApi, loaded.maximizedGroup);
    expect(findMaximizedGroupId(freshApi)).toBe("g1");
  });

  it("restores a workspace as un-maximized when the saved state has no maximize", () => {
    // Models switching from a maximized workspace to an un-maximized
    // one: the live api carries A's maximize, the loaded state says B
    // shouldn't have one, and applying B's state must clear the
    // overlay.
    const api = makeFakeApi([{ id: "g1", maximized: true }]);
    const loaded: ActiveTabState = { groups: {} }; // no maximizedGroup
    applyMaximizedGroupToApi(api, loaded.maximizedGroup);
    expect(findMaximizedGroupId(api)).toBeUndefined();
  });
});
