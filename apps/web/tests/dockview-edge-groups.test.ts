/**
 * @vitest-environment jsdom
 *
 * Pure-function tests for the edge-group helpers in
 * `apps/web/src/lib/dockview-edge-groups.ts`.
 *
 * The helpers control how the four dockview instances (main +
 * terminal + chat + browser) decide which edges are visible, which
 * edge a ⌘B/⌥⌘B/⌘J shortcut should target, and how the focus-aware
 * inner-dockview registry routes that shortcut. They're pure functions
 * over a `DockviewApi` (no I/O, no async, no React state) so the
 * stub-based contract-test pattern from
 * `dockview-section-actions.test.ts` gives the best signal here — see
 * the long comment at the top of that file for the rationale.
 *
 * What's covered (matches the [7] reviewer suggestion on PR #512):
 *   - `toggleEdgeGroup` no-ops + returns `false` for absent / empty
 *     edge groups (so the global keydown handler in SharedDockviewLayout
 *     can fall back to the main api).
 *   - `toggleEdgeGroup` flips collapsed state and returns `true` for
 *     non-empty edge groups.
 *   - `findFocusedInnerDockview` returns `null` when nothing matches,
 *     and the matching registration when `document.activeElement` is
 *     inside the registered container.
 *   - `registerInnerDockview` cleanup unregisters cleanly.
 *   - `refreshEdgeGroupVisibility` hides empty edges, shows non-empty,
 *     and force-shows all when `forceVisible` is true.
 */

import { describe, expect, it, vi } from "vitest";
import {
  attachEdgeGroupDragVisibility,
  EDGE_GROUP_IDS,
  type EdgeDirection,
  ensureEdgeGroups,
  findFocusedInnerDockview,
  refreshEdgeGroupVisibility,
  registerInnerDockview,
  toggleEdgeGroup,
} from "../src/lib/dockview-edge-groups";

// ---------------------------------------------------------------------------
// Stubs. Minimum surface area to drive each helper. Mirrors the
// approach in dockview-section-actions.test.ts — anything not touched
// by the function under test is left out so the stub doesn't quietly
// pin behaviour we don't intend to test.
// ---------------------------------------------------------------------------

interface StubPanel {
  id: string;
}

interface StubGroup {
  id: string;
  panels: StubPanel[];
  api: {
    isCollapsed: ReturnType<typeof vi.fn>;
    collapse: ReturnType<typeof vi.fn>;
    expand: ReturnType<typeof vi.fn>;
  };
}

interface StubApi {
  groups: StubGroup[];
  setEdgeGroupVisible: ReturnType<typeof vi.fn>;
  getEdgeGroup?: ReturnType<typeof vi.fn>;
  removeEdgeGroup?: ReturnType<typeof vi.fn>;
  addEdgeGroup?: ReturnType<typeof vi.fn>;
  onWillDragPanel?: ReturnType<typeof vi.fn>;
  onWillDragGroup?: ReturnType<typeof vi.fn>;
  onDidMovePanel?: ReturnType<typeof vi.fn>;
  onDidRemovePanel?: ReturnType<typeof vi.fn>;
}

function makeGroup(id: string, panelIds: string[], collapsed = false): StubGroup {
  const isCollapsed = vi.fn(() => collapsedState.value);
  const collapse = vi.fn(() => {
    collapsedState.value = true;
  });
  const expand = vi.fn(() => {
    collapsedState.value = false;
  });
  const collapsedState = { value: collapsed };
  return {
    id,
    panels: panelIds.map((id) => ({ id })),
    api: { isCollapsed, collapse, expand },
  };
}

function makeApi(groups: StubGroup[]): StubApi {
  return {
    groups,
    setEdgeGroupVisible: vi.fn(),
  };
}

/**
 * Builds an api with the surface area `ensureEdgeGroups` and
 * `attachEdgeGroupDragVisibility` touch:
 *   - `getEdgeGroup(position)` → returns a sentinel group when
 *     `existingEdges` includes that position (used to test the "top"
 *     cleanup path).
 *   - `removeEdgeGroup` / `addEdgeGroup` → tracked spies the tests
 *     assert against.
 *   - `onWillDragPanel` / `onWillDragGroup` / `onDidMovePanel` /
 *     `onDidRemovePanel` → record the registered listener and return a
 *     disposable so the drag-visibility tests can fire events directly.
 */
function makeRichApi(
  groups: StubGroup[],
  existingEdges: Set<string> = new Set(),
): StubApi & {
  // Exposed so tests can drive the listener directly.
  fireWillDragPanel: () => void;
  fireWillDragGroup: () => void;
  fireDidMovePanel: () => void;
  fireDidRemovePanel: () => void;
  // Spies tracking disposer calls — assert at end of test that the
  // returned cleanup actually disposed each subscription.
  dragPanelDisposed: ReturnType<typeof vi.fn>;
  dragGroupDisposed: ReturnType<typeof vi.fn>;
  movePanelDisposed: ReturnType<typeof vi.fn>;
  removePanelDisposed: ReturnType<typeof vi.fn>;
} {
  const listeners: Record<string, () => void> = {};
  const dragPanelDisposed = vi.fn();
  const dragGroupDisposed = vi.fn();
  const movePanelDisposed = vi.fn();
  const removePanelDisposed = vi.fn();
  return {
    groups,
    setEdgeGroupVisible: vi.fn(),
    getEdgeGroup: vi.fn((pos: string) =>
      existingEdges.has(pos) ? { id: `edge-${pos}` } : undefined,
    ),
    removeEdgeGroup: vi.fn(),
    addEdgeGroup: vi.fn(),
    onWillDragPanel: vi.fn((fn: () => void) => {
      listeners.willDragPanel = fn;
      return { dispose: dragPanelDisposed };
    }),
    onWillDragGroup: vi.fn((fn: () => void) => {
      listeners.willDragGroup = fn;
      return { dispose: dragGroupDisposed };
    }),
    onDidMovePanel: vi.fn((fn: () => void) => {
      listeners.didMovePanel = fn;
      return { dispose: movePanelDisposed };
    }),
    onDidRemovePanel: vi.fn((fn: () => void) => {
      listeners.didRemovePanel = fn;
      return { dispose: removePanelDisposed };
    }),
    fireWillDragPanel: () => listeners.willDragPanel?.(),
    fireWillDragGroup: () => listeners.willDragGroup?.(),
    fireDidMovePanel: () => listeners.didMovePanel?.(),
    fireDidRemovePanel: () => listeners.didRemovePanel?.(),
    dragPanelDisposed,
    dragGroupDisposed,
    movePanelDisposed,
    removePanelDisposed,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: stubs fed to functions typed against the real DockviewApi
function asApi(stub: StubApi): any {
  return stub;
}

// ---------------------------------------------------------------------------
// toggleEdgeGroup
// ---------------------------------------------------------------------------

describe("toggleEdgeGroup", () => {
  it("returns false when no edge group exists at that direction", () => {
    // No edge groups in api.groups — the helper looks up by id and
    // bails out so the caller knows to fall back (e.g., main layout).
    const api = makeApi([]);
    expect(toggleEdgeGroup(asApi(api), "left")).toBe(false);
  });

  it("returns false when the edge group exists but has no panels", () => {
    // Empty edge group is a no-op target — same fall-back semantics as
    // "no group" — because there is nothing for the user to interact
    // with on that side.
    const emptyLeft = makeGroup(EDGE_GROUP_IDS.left, []);
    const api = makeApi([emptyLeft]);
    expect(toggleEdgeGroup(asApi(api), "left")).toBe(false);
    expect(emptyLeft.api.collapse).not.toHaveBeenCalled();
    expect(emptyLeft.api.expand).not.toHaveBeenCalled();
  });

  it("expands an edge group that is currently collapsed (returns true)", () => {
    const left = makeGroup(EDGE_GROUP_IDS.left, ["projects"], /* collapsed */ true);
    const api = makeApi([left]);
    expect(toggleEdgeGroup(asApi(api), "left")).toBe(true);
    expect(left.api.expand).toHaveBeenCalledTimes(1);
    expect(left.api.collapse).not.toHaveBeenCalled();
  });

  it("collapses an edge group that is currently expanded (returns true)", () => {
    const left = makeGroup(EDGE_GROUP_IDS.left, ["projects"], /* collapsed */ false);
    const api = makeApi([left]);
    expect(toggleEdgeGroup(asApi(api), "left")).toBe(true);
    expect(left.api.collapse).toHaveBeenCalledTimes(1);
    expect(left.api.expand).not.toHaveBeenCalled();
  });

  it("targets the right direction's edge group, not just the first match", () => {
    // Sanity check: with three edge groups present, each direction
    // routes to its own. Without the by-id lookup, the helper could
    // accidentally pick the first group in api.groups.
    const left = makeGroup(EDGE_GROUP_IDS.left, ["a"]);
    const right = makeGroup(EDGE_GROUP_IDS.right, ["b"]);
    const bottom = makeGroup(EDGE_GROUP_IDS.bottom, ["c"]);
    const api = makeApi([left, right, bottom]);
    toggleEdgeGroup(asApi(api), "right");
    expect(right.api.collapse).toHaveBeenCalledTimes(1);
    expect(left.api.collapse).not.toHaveBeenCalled();
    expect(bottom.api.collapse).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// refreshEdgeGroupVisibility
// ---------------------------------------------------------------------------

describe("refreshEdgeGroupVisibility", () => {
  it("hides empty edge groups when forceVisible is false", () => {
    const left = makeGroup(EDGE_GROUP_IDS.left, []); // empty
    const api = makeApi([left]);
    refreshEdgeGroupVisibility(asApi(api), false);
    expect(api.setEdgeGroupVisible).toHaveBeenCalledWith("left", false);
  });

  it("shows non-empty edge groups when forceVisible is false", () => {
    const left = makeGroup(EDGE_GROUP_IDS.left, ["projects"]);
    const api = makeApi([left]);
    refreshEdgeGroupVisibility(asApi(api), false);
    expect(api.setEdgeGroupVisible).toHaveBeenCalledWith("left", true);
  });

  it("force-shows every edge group when forceVisible is true (drag)", () => {
    // During a drag, empty edges become drop targets — without
    // force-show the user wouldn't see anywhere to drop a panel.
    const left = makeGroup(EDGE_GROUP_IDS.left, []); // empty
    const right = makeGroup(EDGE_GROUP_IDS.right, ["existing"]); // non-empty
    const api = makeApi([left, right]);
    refreshEdgeGroupVisibility(asApi(api), true);
    expect(api.setEdgeGroupVisible).toHaveBeenCalledWith("left", true);
    expect(api.setEdgeGroupVisible).toHaveBeenCalledWith("right", true);
  });

  it("skips directions whose edge group is not registered yet", () => {
    // Caller might invoke refresh before all edge groups are added —
    // missing ones should be a no-op rather than throw.
    const api = makeApi([]);
    expect(() => refreshEdgeGroupVisibility(asApi(api), false)).not.toThrow();
    expect(api.setEdgeGroupVisible).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// findFocusedInnerDockview / registerInnerDockview
// ---------------------------------------------------------------------------
//
// These tests touch `document.activeElement`, so we need a real DOM —
// vitest's default jsdom environment is fine. Each test cleans up its
// registrations + DOM elements to prevent cross-test leakage through
// the module-level registry singleton.
//
// MAINTAINER NOTE: `innerDockviewRegistrations` is a process-wide Set
// that persists across tests in this file (vitest does not reset the
// module). Every test below MUST call the disposer returned by
// `registerInnerDockview` before exiting — a leaked registration
// would silently bleed into the next test's `findFocusedInnerDockview`
// lookup. The `dispose()` + `document.body.removeChild()` pair at the
// bottom of each test is non-negotiable.

describe("registerInnerDockview / findFocusedInnerDockview", () => {
  it("returns null when no inner dockview is registered", () => {
    expect(findFocusedInnerDockview()).toBe(null);
  });

  it("returns null when focus is not inside any registered container", () => {
    const containerEl = document.createElement("div");
    document.body.appendChild(containerEl);
    // biome-ignore lint/suspicious/noExplicitAny: stub api — focus lookup only uses containerEl
    const api: any = { id: "inner-api" };
    const dispose = registerInnerDockview(containerEl, api);

    // activeElement is document.body by default — not inside containerEl.
    expect(findFocusedInnerDockview()).toBe(null);

    dispose();
    document.body.removeChild(containerEl);
  });

  it("returns the matching api when document.activeElement is inside its container", () => {
    const containerEl = document.createElement("div");
    const innerInput = document.createElement("input");
    containerEl.appendChild(innerInput);
    document.body.appendChild(containerEl);
    // biome-ignore lint/suspicious/noExplicitAny: stub api
    const api: any = { id: "inner-api" };
    const dispose = registerInnerDockview(containerEl, api);

    innerInput.focus();
    expect(findFocusedInnerDockview()).toBe(api);

    dispose();
    document.body.removeChild(containerEl);
  });

  it("disposer unregisters the entry cleanly", () => {
    const containerEl = document.createElement("div");
    const innerInput = document.createElement("input");
    containerEl.appendChild(innerInput);
    document.body.appendChild(containerEl);
    // biome-ignore lint/suspicious/noExplicitAny: stub api
    const api: any = { id: "inner-api" };
    const dispose = registerInnerDockview(containerEl, api);
    innerInput.focus();
    expect(findFocusedInnerDockview()).toBe(api);

    dispose();
    // After dispose, the same focus should produce no match.
    expect(findFocusedInnerDockview()).toBe(null);

    document.body.removeChild(containerEl);
  });

  it("returns the right api when multiple inner containers are registered", () => {
    // Multi-workspace case: two inner containers active at once; the
    // routing has to pick the one that actually owns focus.
    const containerA = document.createElement("div");
    const inputA = document.createElement("input");
    containerA.appendChild(inputA);
    const containerB = document.createElement("div");
    const inputB = document.createElement("input");
    containerB.appendChild(inputB);
    document.body.appendChild(containerA);
    document.body.appendChild(containerB);

    // biome-ignore lint/suspicious/noExplicitAny: stub api
    const apiA: any = { id: "api-a" };
    // biome-ignore lint/suspicious/noExplicitAny: stub api
    const apiB: any = { id: "api-b" };
    const disposeA = registerInnerDockview(containerA, apiA);
    const disposeB = registerInnerDockview(containerB, apiB);

    inputA.focus();
    expect(findFocusedInnerDockview()).toBe(apiA);
    inputB.focus();
    expect(findFocusedInnerDockview()).toBe(apiB);

    disposeA();
    disposeB();
    document.body.removeChild(containerA);
    document.body.removeChild(containerB);
  });
});

// ---------------------------------------------------------------------------
// ensureEdgeGroups
// ---------------------------------------------------------------------------

describe("ensureEdgeGroups", () => {
  it("adds all three cardinal edge groups when none exist", () => {
    const api = makeRichApi([]);
    ensureEdgeGroups(asApi(api));
    expect(api.addEdgeGroup).toHaveBeenCalledTimes(3);
    expect(api.addEdgeGroup).toHaveBeenCalledWith("left", {
      id: EDGE_GROUP_IDS.left,
      collapsed: true,
    });
    expect(api.addEdgeGroup).toHaveBeenCalledWith("right", {
      id: EDGE_GROUP_IDS.right,
      collapsed: true,
    });
    expect(api.addEdgeGroup).toHaveBeenCalledWith("bottom", {
      id: EDGE_GROUP_IDS.bottom,
      collapsed: true,
    });
  });

  it("is idempotent — skips edge groups that already exist", () => {
    // Mimic a restored layout: edge groups already present in api.groups
    // via their EDGE_GROUP_IDS ids. addEdgeGroup must not be called.
    const groups = [
      makeGroup(EDGE_GROUP_IDS.left, []),
      makeGroup(EDGE_GROUP_IDS.right, []),
      makeGroup(EDGE_GROUP_IDS.bottom, []),
    ];
    const api = makeRichApi(groups);
    ensureEdgeGroups(asApi(api));
    expect(api.addEdgeGroup).not.toHaveBeenCalled();
  });

  it("removes a stale 'top' edge group restored from an older layout", () => {
    // Older saved layouts may carry a "top" edge group that none of
    // our layouts want — the helper has to clean it up.
    const api = makeRichApi([], new Set(["top"]));
    ensureEdgeGroups(asApi(api));
    expect(api.removeEdgeGroup).toHaveBeenCalledWith("top");
  });

  it("does not call removeEdgeGroup when there is no 'top' group", () => {
    // Skip the cleanup branch entirely when `getEdgeGroup("top")`
    // returns undefined — the truthy check is the actual guard, not
    // the try/catch (which is narrow on purpose, see the helper).
    const api = makeRichApi([]);
    ensureEdgeGroups(asApi(api));
    expect(api.removeEdgeGroup).not.toHaveBeenCalled();
  });

  it("refreshes visibility after adding the edge groups", () => {
    // The final `refreshEdgeGroupVisibility(api, false)` call should
    // fire setEdgeGroupVisible(_, false) for each direction since all
    // newly-added groups start empty. The groups argument is what's
    // visible to refreshEdgeGroupVisibility — so we seed them.
    const groups = [
      makeGroup(EDGE_GROUP_IDS.left, []),
      makeGroup(EDGE_GROUP_IDS.right, []),
      makeGroup(EDGE_GROUP_IDS.bottom, []),
    ];
    const api = makeRichApi(groups);
    ensureEdgeGroups(asApi(api));
    expect(api.setEdgeGroupVisible).toHaveBeenCalledWith("left", false);
    expect(api.setEdgeGroupVisible).toHaveBeenCalledWith("right", false);
    expect(api.setEdgeGroupVisible).toHaveBeenCalledWith("bottom", false);
  });
});

// ---------------------------------------------------------------------------
// attachEdgeGroupDragVisibility
// ---------------------------------------------------------------------------

describe("attachEdgeGroupDragVisibility", () => {
  it("subscribes to the four dockview drag events", () => {
    const api = makeRichApi([]);
    const dispose = attachEdgeGroupDragVisibility(asApi(api));
    expect(api.onWillDragPanel).toHaveBeenCalledTimes(1);
    expect(api.onWillDragGroup).toHaveBeenCalledTimes(1);
    expect(api.onDidMovePanel).toHaveBeenCalledTimes(1);
    expect(api.onDidRemovePanel).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("force-shows every edge group when a drag starts (onWillDragPanel)", () => {
    // Drag-start needs the empty edges visible so the user has a
    // drop target on each side. After `attach`, `setEdgeGroupVisible`
    // should be called with `true` for each edge.
    const groups = [
      makeGroup(EDGE_GROUP_IDS.left, []),
      makeGroup(EDGE_GROUP_IDS.right, []),
      makeGroup(EDGE_GROUP_IDS.bottom, []),
    ];
    const api = makeRichApi(groups);
    const dispose = attachEdgeGroupDragVisibility(asApi(api));
    api.setEdgeGroupVisible.mockClear(); // ignore the initial refresh
    api.fireWillDragPanel();
    expect(api.setEdgeGroupVisible).toHaveBeenCalledWith("left", true);
    expect(api.setEdgeGroupVisible).toHaveBeenCalledWith("right", true);
    expect(api.setEdgeGroupVisible).toHaveBeenCalledWith("bottom", true);
    dispose();
  });

  it("returns empty edges to hidden when the drag ends (onDidMovePanel)", () => {
    const groups = [
      makeGroup(EDGE_GROUP_IDS.left, []), // empty after drag
      makeGroup(EDGE_GROUP_IDS.right, ["docked"]), // non-empty after drag
      makeGroup(EDGE_GROUP_IDS.bottom, []),
    ];
    const api = makeRichApi(groups);
    const dispose = attachEdgeGroupDragVisibility(asApi(api));
    api.fireWillDragPanel(); // force visible
    api.setEdgeGroupVisible.mockClear();
    api.fireDidMovePanel(); // drag ended
    expect(api.setEdgeGroupVisible).toHaveBeenCalledWith("left", false); // empty → hidden
    expect(api.setEdgeGroupVisible).toHaveBeenCalledWith("right", true); // non-empty → visible
    expect(api.setEdgeGroupVisible).toHaveBeenCalledWith("bottom", false);
    dispose();
  });

  it("treats onDidRemovePanel as a drag-end signal too", () => {
    // Dropping a panel from one group to another fires onDidRemovePanel
    // on the source side. Both onDidMovePanel and onDidRemovePanel
    // should reset the drag-visibility state.
    const groups = [makeGroup(EDGE_GROUP_IDS.left, [])];
    const api = makeRichApi(groups);
    const dispose = attachEdgeGroupDragVisibility(asApi(api));
    api.fireWillDragPanel();
    api.setEdgeGroupVisible.mockClear();
    api.fireDidRemovePanel();
    expect(api.setEdgeGroupVisible).toHaveBeenCalledWith("left", false);
    dispose();
  });

  it("disposer cleans up all four dockview subscriptions", () => {
    const api = makeRichApi([]);
    const dispose = attachEdgeGroupDragVisibility(asApi(api));
    dispose();
    expect(api.dragPanelDisposed).toHaveBeenCalledTimes(1);
    expect(api.dragGroupDisposed).toHaveBeenCalledTimes(1);
    expect(api.movePanelDisposed).toHaveBeenCalledTimes(1);
    expect(api.removePanelDisposed).toHaveBeenCalledTimes(1);
  });

  it("disposer detaches the native drop / dragend listeners on document", () => {
    // The handler also wires `document.addEventListener("drop", …, true)`
    // and `"dragend"` as the Escape-cancel safety net. After dispose,
    // firing those events should NOT call setEdgeGroupVisible.
    const groups = [makeGroup(EDGE_GROUP_IDS.left, [])];
    const api = makeRichApi(groups);
    const dispose = attachEdgeGroupDragVisibility(asApi(api));
    api.fireWillDragPanel(); // mark dragging
    dispose();
    api.setEdgeGroupVisible.mockClear();
    // Dispatch a native drop event — the listener should already be
    // detached, so this is a no-op.
    document.dispatchEvent(new Event("drop", { bubbles: true }));
    expect(api.setEdgeGroupVisible).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// EDGE_GROUP_IDS sanity
// ---------------------------------------------------------------------------

describe("EDGE_GROUP_IDS", () => {
  it("exposes the three cardinal directions used across the app", () => {
    // Pin the values: SharedDockviewLayout's local copy and the helper
    // module must match, otherwise toggle/refresh would target the
    // wrong edge group ids.
    expect(EDGE_GROUP_IDS.left).toBe("edge-left");
    expect(EDGE_GROUP_IDS.right).toBe("edge-right");
    expect(EDGE_GROUP_IDS.bottom).toBe("edge-bottom");
  });

  it("only includes left, right, and bottom (no top)", () => {
    const keys = Object.keys(EDGE_GROUP_IDS).sort() as EdgeDirection[];
    expect(keys).toEqual(["bottom", "left", "right"]);
  });
});
