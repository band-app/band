/**
 * Pure-function tests for the per-section Dockview shortcut helpers used by
 * DockviewTerminalContainer, DockviewChatContainer, and DockviewBrowserContainer.
 *
 * These helpers were extracted from the three containers so all of them share
 * one cycling / neighbour-select implementation — these tests pin that
 * implementation. Each section then layers its own focus-target callback on
 * top, which the containers cover via manual QA.
 *
 * The bugs these guard against:
 *   - Cycling firing the refocus callback when the underlying api is missing
 *     (would null-deref inside the section).
 *   - cycleGridGroups picking up floating / popout groups (only grid groups
 *     should be cyclable via Cmd+[ / Cmd+]).
 *   - cycleGridGroups visiting groups in *creation* order rather than
 *     *visual reading* order — splitting right then down should still cycle
 *     in the clockwise order the user sees on screen.
 *   - Closing the leftmost tab snapping focus to the *next* leftmost instead
 *     of the panel on its right.
 *   - Closing a single-tab group still trying to pre-select a neighbour.
 *
 * Note on the stub `DockviewApi`: CLAUDE.md prefers black-box integration tests
 * over mock-based unit tests, but Dockview is a DOM-driven library — building
 * a real `DockviewApi` requires mounting a Dockview container against a live
 * DOM, manipulating splits via user-style drag interactions, and running this
 * in vitest + jsdom (which doesn't implement layout). The helpers under test
 * are also pure functions over the `DockviewApi` interface: no I/O, no state,
 * no async — exactly the shape where stub-based contract tests give the
 * highest signal-to-noise. Per-container behaviour (the focus-target callbacks
 * + visibility wiring) is covered by manual QA against the running app, same
 * as the rest of the dockview UI. See `apps/web/tests/browser-layout.test.ts`
 * for the same pattern applied to the browser tab-strip helpers.
 */

import { describe, expect, it, vi } from "vitest";
import {
  cycleGridGroups,
  cycleTabsInActiveGroup,
  selectNeighbourBeforeRemove,
} from "../src/lib/dockview-section-actions";

// ---------------------------------------------------------------------------
// Minimal stub builders. We only model the DockviewApi surface our helpers
// touch — anything more would just lock us into dockview's full type.
// ---------------------------------------------------------------------------

interface StubPanel {
  id: string;
  api: { setActive: ReturnType<typeof vi.fn> };
}

interface StubGroup {
  id: string;
  panels: StubPanel[];
  activePanel?: StubPanel;
  model: {
    moveToNext: ReturnType<typeof vi.fn>;
    moveToPrevious: ReturnType<typeof vi.fn>;
  };
  api: { location: { type: "grid" | "floating" | "popout" } };
}

function makePanel(id: string): StubPanel {
  return { id, api: { setActive: vi.fn() } };
}

function makeGroup(
  id: string,
  panelIds: string[],
  opts?: { location?: "grid" | "floating" | "popout"; activeIndex?: number },
): StubGroup {
  const panels = panelIds.map(makePanel);
  return {
    id,
    panels,
    activePanel: panels[opts?.activeIndex ?? 0],
    model: { moveToNext: vi.fn(), moveToPrevious: vi.fn() },
    api: { location: { type: opts?.location ?? "grid" } },
  };
}

// --- Grid-tree builders --------------------------------------------------
// Mirror the SerializedGridObject<GroupPanelViewState> shape dockview emits
// from `api.toJSON().grid.root`. `walkGridNode` walks these depth-first, so
// the order children appear in a branch's `data` array is the visual order
// (left→right for horizontal splits, top→bottom for vertical splits).

interface GridLeaf {
  type: "leaf";
  data: { id: string };
}
interface GridBranch {
  type: "branch";
  data: Array<GridLeaf | GridBranch>;
}
type GridNode = GridLeaf | GridBranch;

function leaf(groupId: string): GridLeaf {
  return { type: "leaf", data: { id: groupId } };
}
function branch(...children: GridNode[]): GridBranch {
  return { type: "branch", data: children };
}

interface StubApi {
  activeGroup: StubGroup | null;
  groups: StubGroup[];
  getGroup: (id: string) => StubGroup | undefined;
  getPanel: (id: string) => (StubPanel & { group?: StubGroup }) | undefined;
  toJSON: () => { grid: { root: GridNode } };
}

// biome-ignore lint/suspicious/noExplicitAny: stub fed to functions typed against the real DockviewApi
function asApi(stub: StubApi): any {
  return stub;
}

/**
 * Build a stub api around a set of groups. If `gridRoot` is omitted, the
 * grid tree defaults to a single horizontal branch containing every group
 * in the order they were passed in — so the existing tests that don't care
 * about spatial layout still pin the cycling order to creation order.
 */
function makeApi(groups: StubGroup[], activeGroupIdx = 0, gridRoot?: GridNode): StubApi {
  const gridGroups = groups.filter((g) => g.api.location.type === "grid");
  const root: GridNode =
    gridRoot ??
    (gridGroups.length === 1
      ? leaf(gridGroups[0].id)
      : branch(...gridGroups.map((g) => leaf(g.id))));
  return {
    activeGroup: groups[activeGroupIdx] ?? null,
    groups,
    getGroup: (id) => groups.find((g) => g.id === id),
    getPanel: (id) => {
      for (const g of groups) {
        const p = g.panels.find((pp) => pp.id === id);
        if (p) return Object.assign(p, { group: g });
      }
      return undefined;
    },
    toJSON: () => ({ grid: { root } }),
  };
}

// ---------------------------------------------------------------------------
// cycleTabsInActiveGroup
// ---------------------------------------------------------------------------

describe("cycleTabsInActiveGroup", () => {
  it("is a no-op when api is null", () => {
    const refocus = vi.fn();
    cycleTabsInActiveGroup(null, 1, refocus);
    expect(refocus).not.toHaveBeenCalled();
  });

  it("is a no-op when there is no active group", () => {
    const refocus = vi.fn();
    const api = makeApi([], -1);
    cycleTabsInActiveGroup(asApi(api), 1, refocus);
    expect(refocus).not.toHaveBeenCalled();
  });

  it("calls moveToNext + refocus for direction 1", () => {
    const group = makeGroup("g0", ["a", "b", "c"]);
    const refocus = vi.fn();
    cycleTabsInActiveGroup(asApi(makeApi([group])), 1, refocus);
    expect(group.model.moveToNext).toHaveBeenCalledTimes(1);
    expect(group.model.moveToPrevious).not.toHaveBeenCalled();
    expect(refocus).toHaveBeenCalledTimes(1);
  });

  it("calls moveToPrevious + refocus for direction -1", () => {
    const group = makeGroup("g0", ["a", "b", "c"]);
    const refocus = vi.fn();
    cycleTabsInActiveGroup(asApi(makeApi([group])), -1, refocus);
    expect(group.model.moveToPrevious).toHaveBeenCalledTimes(1);
    expect(group.model.moveToNext).not.toHaveBeenCalled();
    expect(refocus).toHaveBeenCalledTimes(1);
  });

  it("does not throw when refocus is omitted", () => {
    const group = makeGroup("g0", ["a"]);
    expect(() => cycleTabsInActiveGroup(asApi(makeApi([group])), 1)).not.toThrow();
    expect(group.model.moveToNext).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cycleGridGroups
// ---------------------------------------------------------------------------

describe("cycleGridGroups", () => {
  it("is a no-op when api is null", () => {
    const refocus = vi.fn();
    cycleGridGroups(null, 1, refocus);
    expect(refocus).not.toHaveBeenCalled();
  });

  it("is a no-op with fewer than two grid groups", () => {
    const refocus = vi.fn();
    const g = makeGroup("g0", ["a"]);
    cycleGridGroups(asApi(makeApi([g])), 1, refocus);
    expect(g.panels[0].api.setActive).not.toHaveBeenCalled();
    expect(refocus).not.toHaveBeenCalled();
  });

  it("ignores floating and popout groups when counting", () => {
    // Only one grid-located leaf → cycling is a no-op. The floating group
    // shouldn't appear in `grid.root` at all (dockview keeps floating /
    // popout groups in sibling arrays on SerializedDockview), so the stub
    // mirrors that: the grid tree has just the one leaf.
    const grid = makeGroup("g0", ["a"]);
    const floating = makeGroup("g1", ["b"], { location: "floating" });
    const refocus = vi.fn();
    cycleGridGroups(asApi(makeApi([grid, floating], 0, leaf("g0"))), 1, refocus);
    expect(floating.panels[0].api.setActive).not.toHaveBeenCalled();
    expect(grid.panels[0].api.setActive).not.toHaveBeenCalled();
    expect(refocus).not.toHaveBeenCalled();
  });

  it("activates the next grid group's active panel for direction 1", () => {
    const g0 = makeGroup("g0", ["a"]);
    const g1 = makeGroup("g1", ["b"]);
    const g2 = makeGroup("g2", ["c"]);
    const refocus = vi.fn();
    cycleGridGroups(asApi(makeApi([g0, g1, g2], 0)), 1, refocus);
    expect(g1.panels[0].api.setActive).toHaveBeenCalledTimes(1);
    expect(g0.panels[0].api.setActive).not.toHaveBeenCalled();
    expect(g2.panels[0].api.setActive).not.toHaveBeenCalled();
    expect(refocus).toHaveBeenCalledTimes(1);
  });

  it("wraps around to the first group when going forward from the last", () => {
    const g0 = makeGroup("g0", ["a"]);
    const g1 = makeGroup("g1", ["b"]);
    cycleGridGroups(asApi(makeApi([g0, g1], 1)), 1);
    expect(g0.panels[0].api.setActive).toHaveBeenCalledTimes(1);
  });

  it("wraps around to the last group when going backward from the first", () => {
    const g0 = makeGroup("g0", ["a"]);
    const g1 = makeGroup("g1", ["b"]);
    cycleGridGroups(asApi(makeApi([g0, g1], 0)), -1);
    expect(g1.panels[0].api.setActive).toHaveBeenCalledTimes(1);
  });

  it("does not refocus when the next group has no active panel", () => {
    // An empty group is unusual but possible (dockview can briefly hold a
    // group with no active panel between operations). Without the guard the
    // refocus callback would fire even though setActive() was a no-op, which
    // re-focuses whatever was already active and causes a confusing flicker.
    const g0 = makeGroup("g0", ["a"]);
    const g1 = makeGroup("g1", []);
    g1.activePanel = undefined;
    const refocus = vi.fn();
    cycleGridGroups(asApi(makeApi([g0, g1], 0)), 1, refocus);
    expect(refocus).not.toHaveBeenCalled();
  });

  it("cycles in visual reading order, not creation order", () => {
    // Reproduces the screenshot the user described in PR #487 review:
    //   ┌────────────┬────────────┐
    //   │ topLeft    │ topRight   │
    //   ├────────────┴────────────┤
    //   │ bottom (full width)     │
    //   └─────────────────────────┘
    //
    // dockview's `api.groups` reports these in *creation* order. To exercise
    // the spatial-walk fix we deliberately list them in a different order
    // (bottom was created first, then topLeft was split off it, then
    // topRight). The grid tree (which `api.toJSON()` emits in visual order)
    // pins the on-screen layout: outer vertical branch, top horizontal
    // branch with [topLeft, topRight], then bottom underneath.
    const bottom = makeGroup("bottom", ["b"]);
    const topLeft = makeGroup("topLeft", ["tl"]);
    const topRight = makeGroup("topRight", ["tr"]);
    const tree = branch(branch(leaf("topLeft"), leaf("topRight")), leaf("bottom"));
    // Active group is topLeft (index 1 in the creation-order array, but the
    // visual-first leaf in the tree).
    const api = makeApi([bottom, topLeft, topRight], 1, tree);

    cycleGridGroups(asApi(api), 1);

    // Cmd+] from topLeft should land on topRight (the next visual leaf),
    // *not* on bottom (which is `api.groups[0]` so the old creation-order
    // logic would have picked it).
    expect(topRight.panels[0].api.setActive).toHaveBeenCalledTimes(1);
    expect(bottom.panels[0].api.setActive).not.toHaveBeenCalled();
    expect(topLeft.panels[0].api.setActive).not.toHaveBeenCalled();
  });

  it("cycles in reverse visual reading order for direction -1", () => {
    // Same layout as above. From topLeft, Cmd+[ should wrap to bottom
    // (the last visual leaf), not snap forward.
    const bottom = makeGroup("bottom", ["b"]);
    const topLeft = makeGroup("topLeft", ["tl"]);
    const topRight = makeGroup("topRight", ["tr"]);
    const tree = branch(branch(leaf("topLeft"), leaf("topRight")), leaf("bottom"));
    const api = makeApi([bottom, topLeft, topRight], 1, tree);

    cycleGridGroups(asApi(api), -1);

    expect(bottom.panels[0].api.setActive).toHaveBeenCalledTimes(1);
    expect(topRight.panels[0].api.setActive).not.toHaveBeenCalled();
    expect(topLeft.panels[0].api.setActive).not.toHaveBeenCalled();
  });

  it("skips orphaned ids that the api can no longer resolve", () => {
    // `api.toJSON()` is a snapshot; if a leaf references an id whose live
    // group has already been disposed (rare race during teardown), the
    // walk should silently drop it instead of crashing.
    const g0 = makeGroup("g0", ["a"]);
    const g1 = makeGroup("g1", ["b"]);
    const tree = branch(leaf("g0"), leaf("ghost"), leaf("g1"));
    const api = makeApi([g0, g1], 0, tree);

    cycleGridGroups(asApi(api), 1);

    // From g0, forward → g1 (ghost is filtered out).
    expect(g1.panels[0].api.setActive).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// selectNeighbourBeforeRemove
// ---------------------------------------------------------------------------

describe("selectNeighbourBeforeRemove", () => {
  it("is a no-op when the panel is not found", () => {
    const g = makeGroup("g0", ["a", "b"]);
    selectNeighbourBeforeRemove(asApi(makeApi([g])), "missing");
    expect(g.panels[0].api.setActive).not.toHaveBeenCalled();
    expect(g.panels[1].api.setActive).not.toHaveBeenCalled();
  });

  it("is a no-op when the group has only one panel", () => {
    const g = makeGroup("g0", ["solo"]);
    selectNeighbourBeforeRemove(asApi(makeApi([g])), "solo");
    expect(g.panels[0].api.setActive).not.toHaveBeenCalled();
  });

  it("pre-selects the left neighbour when closing the rightmost tab", () => {
    const g = makeGroup("g0", ["a", "b", "c"]);
    selectNeighbourBeforeRemove(asApi(makeApi([g])), "c");
    expect(g.panels[1].api.setActive).toHaveBeenCalledTimes(1); // "b"
    expect(g.panels[0].api.setActive).not.toHaveBeenCalled();
    expect(g.panels[2].api.setActive).not.toHaveBeenCalled();
  });

  it("pre-selects the left neighbour when closing a middle tab", () => {
    const g = makeGroup("g0", ["a", "b", "c"]);
    selectNeighbourBeforeRemove(asApi(makeApi([g])), "b");
    expect(g.panels[0].api.setActive).toHaveBeenCalledTimes(1); // "a"
    expect(g.panels[2].api.setActive).not.toHaveBeenCalled();
  });

  it("pre-selects the right neighbour when closing the leftmost tab", () => {
    const g = makeGroup("g0", ["a", "b", "c"]);
    selectNeighbourBeforeRemove(asApi(makeApi([g])), "a");
    expect(g.panels[1].api.setActive).toHaveBeenCalledTimes(1); // "b"
    expect(g.panels[2].api.setActive).not.toHaveBeenCalled();
  });
});
