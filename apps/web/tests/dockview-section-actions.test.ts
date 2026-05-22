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
 *   - cycleGridGroups visiting groups in creation order, or in the order
 *     dictated by the split tree, rather than the on-screen reading order
 *     — splitting right-then-down vs down-then-right produces identical
 *     pixels but opposite traversal orders, so the cycle must depend on
 *     measured pixel position, not tree shape.
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
  type GroupRect,
  selectNeighbourBeforeRemove,
  sortGroupsInReadingOrder,
} from "../src/lib/dockview-section-actions";

// ---------------------------------------------------------------------------
// Minimal stub builders. We only model the DockviewApi surface our helpers
// touch — anything more would just lock us into dockview's full type.
// ---------------------------------------------------------------------------

interface StubPanel {
  id: string;
  api: { setActive: ReturnType<typeof vi.fn> };
}

interface StubRect {
  left: number;
  top: number;
  width: number;
  height: number;
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
  /** Stand-in for the runtime `element` getter dockview exposes via
   * `BasePanelView`. `cycleGridGroups` reads this through an
   * `unknown`-cast so we don't need to fake the rest of HTMLElement. */
  element: {
    getBoundingClientRect: () => StubRect;
  };
}

function makePanel(id: string): StubPanel {
  return { id, api: { setActive: vi.fn() } };
}

interface MakeGroupOpts {
  location?: "grid" | "floating" | "popout";
  activeIndex?: number;
  rect?: StubRect;
}

function makeGroup(id: string, panelIds: string[], opts?: MakeGroupOpts): StubGroup {
  const panels = panelIds.map(makePanel);
  const rect = opts?.rect ?? { left: 0, top: 0, width: 100, height: 100 };
  return {
    id,
    panels,
    activePanel: panels[opts?.activeIndex ?? 0],
    model: { moveToNext: vi.fn(), moveToPrevious: vi.fn() },
    api: { location: { type: opts?.location ?? "grid" } },
    element: { getBoundingClientRect: () => rect },
  };
}

interface StubApi {
  activeGroup: StubGroup | null;
  groups: StubGroup[];
  getGroup: (id: string) => StubGroup | undefined;
  getPanel: (id: string) => (StubPanel & { group?: StubGroup }) | undefined;
}

// biome-ignore lint/suspicious/noExplicitAny: stub fed to functions typed against the real DockviewApi
function asApi(stub: StubApi): any {
  return stub;
}

function makeApi(groups: StubGroup[], activeGroupIdx = 0): StubApi {
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
// sortGroupsInReadingOrder — pure algorithm, no DOM
// ---------------------------------------------------------------------------

describe("sortGroupsInReadingOrder", () => {
  it("returns input unchanged for fewer than two groups", () => {
    expect(sortGroupsInReadingOrder([])).toEqual([]);
    const one: GroupRect[] = [{ id: "solo", top: 10, left: 10 }];
    expect(sortGroupsInReadingOrder(one).map((g) => g.id)).toEqual(["solo"]);
  });

  it("sorts a 2x2 grid as TL, TR, BL, BR", () => {
    // User's naming: 1=TL, 2=TR, 3=BR, 4=BL → expected cycle 1, 2, 4, 3.
    const rects: GroupRect[] = [
      { id: "1", top: 0, left: 0 },
      { id: "2", top: 0, left: 200 },
      { id: "3", top: 200, left: 200 },
      { id: "4", top: 200, left: 0 },
    ];
    const ids = sortGroupsInReadingOrder(rects).map((r) => r.id);
    expect(ids).toEqual(["1", "2", "4", "3"]);
  });

  it("sorts top-row + bottom-full-width as TL, TR, B", () => {
    // First screenshot from the PR thread.
    const rects: GroupRect[] = [
      { id: "TL", top: 0, left: 0 },
      { id: "TR", top: 0, left: 200 },
      { id: "B", top: 200, left: 0 },
    ];
    const ids = sortGroupsInReadingOrder(rects).map((r) => r.id);
    expect(ids).toEqual(["TL", "TR", "B"]);
  });

  it("sorts a horizontal row left→right", () => {
    const rects: GroupRect[] = [
      { id: "C", top: 0, left: 400 },
      { id: "A", top: 0, left: 0 },
      { id: "B", top: 0, left: 200 },
    ];
    expect(sortGroupsInReadingOrder(rects).map((r) => r.id)).toEqual(["A", "B", "C"]);
  });

  it("sorts a vertical column top→bottom", () => {
    const rects: GroupRect[] = [
      { id: "M", top: 200, left: 0 },
      { id: "B", top: 400, left: 0 },
      { id: "T", top: 0, left: 0 },
    ];
    expect(sortGroupsInReadingOrder(rects).map((r) => r.id)).toEqual(["T", "M", "B"]);
  });

  it("groups visually-aligned rows even with sub-pixel top differences", () => {
    // Dockview's flex sizing can give panels on the same row slightly
    // different `top` values (e.g. 199.5 vs 200). Without row snapping
    // the BR panel below would sort between TR and BL, producing
    // TL, TR, BR, BL — wrong.
    const rects: GroupRect[] = [
      { id: "TL", top: 0, left: 0 },
      { id: "TR", top: 0, left: 200 },
      { id: "BL", top: 200, left: 0 },
      { id: "BR", top: 199.5, left: 200 },
    ];
    const ids = sortGroupsInReadingOrder(rects).map((r) => r.id);
    // BR should be grouped into the bottom row (within ~4px tolerance)
    // and tie-broken by left.
    expect(ids).toEqual(["TL", "TR", "BL", "BR"]);
  });

  it("is independent of input ordering", () => {
    const a: GroupRect[] = [
      { id: "BR", top: 200, left: 200 },
      { id: "TL", top: 0, left: 0 },
      { id: "BL", top: 200, left: 0 },
      { id: "TR", top: 0, left: 200 },
    ];
    const b: GroupRect[] = [
      { id: "TR", top: 0, left: 200 },
      { id: "BL", top: 200, left: 0 },
      { id: "TL", top: 0, left: 0 },
      { id: "BR", top: 200, left: 200 },
    ];
    expect(sortGroupsInReadingOrder(a).map((r) => r.id)).toEqual(
      sortGroupsInReadingOrder(b).map((r) => r.id),
    );
  });
});

// ---------------------------------------------------------------------------
// cycleGridGroups — exercises the full DOM-measure → sort → setActive path
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
    const grid = makeGroup("g0", ["a"]);
    const floating = makeGroup("g1", ["b"], { location: "floating" });
    const refocus = vi.fn();
    cycleGridGroups(asApi(makeApi([grid, floating])), 1, refocus);
    expect(floating.panels[0].api.setActive).not.toHaveBeenCalled();
    expect(grid.panels[0].api.setActive).not.toHaveBeenCalled();
    expect(refocus).not.toHaveBeenCalled();
  });

  it("does not refocus when the next group has no active panel", () => {
    // An empty group is unusual but possible (dockview can briefly hold a
    // group with no active panel between operations). Without the guard the
    // refocus callback would fire even though setActive() was a no-op, which
    // re-focuses whatever was already active and causes a confusing flicker.
    const g0 = makeGroup("g0", ["a"], { rect: { left: 0, top: 0, width: 200, height: 200 } });
    const g1 = makeGroup("g1", [], { rect: { left: 200, top: 0, width: 200, height: 200 } });
    g1.activePanel = undefined;
    const refocus = vi.fn();
    cycleGridGroups(asApi(makeApi([g0, g1], 0)), 1, refocus);
    expect(refocus).not.toHaveBeenCalled();
  });

  it("cycles a 2x2 grid in reading order (TL → TR → BL → BR → TL) regardless of api.groups order", () => {
    // User's screenshot: 1=TL, 2=TR, 3=BR, 4=BL. `api.groups` is in
    // deliberately scrambled creation order so the test fails if the sort
    // ever regresses to `api.groups` ordering.
    const g1 = makeGroup("1", ["t1"], { rect: { left: 0, top: 0, width: 200, height: 200 } });
    const g2 = makeGroup("2", ["t2"], { rect: { left: 200, top: 0, width: 200, height: 200 } });
    const g3 = makeGroup("3", ["t3"], { rect: { left: 200, top: 200, width: 200, height: 200 } });
    const g4 = makeGroup("4", ["t4"], { rect: { left: 0, top: 200, width: 200, height: 200 } });

    // From TL: forward = TR.
    let api = makeApi([g4, g2, g1, g3], 2);
    cycleGridGroups(asApi(api), 1);
    expect(g2.panels[0].api.setActive).toHaveBeenCalledTimes(1);

    // From TR: forward = BL.
    api = makeApi([g4, g2, g1, g3], 1);
    cycleGridGroups(asApi(api), 1);
    expect(g4.panels[0].api.setActive).toHaveBeenCalledTimes(1);

    // From BL: forward = BR.
    api = makeApi([g4, g2, g1, g3], 0);
    cycleGridGroups(asApi(api), 1);
    expect(g3.panels[0].api.setActive).toHaveBeenCalledTimes(1);

    // From BR: forward wraps to TL.
    api = makeApi([g4, g2, g1, g3], 3);
    cycleGridGroups(asApi(api), 1);
    expect(g1.panels[0].api.setActive).toHaveBeenCalledTimes(1);
  });

  it("cycles a 2x2 grid backwards in reverse reading order for direction -1", () => {
    const g1 = makeGroup("1", ["t1"], { rect: { left: 0, top: 0, width: 200, height: 200 } });
    const g2 = makeGroup("2", ["t2"], { rect: { left: 200, top: 0, width: 200, height: 200 } });
    const g3 = makeGroup("3", ["t3"], { rect: { left: 200, top: 200, width: 200, height: 200 } });
    const g4 = makeGroup("4", ["t4"], { rect: { left: 0, top: 200, width: 200, height: 200 } });

    // From TL, backwards wraps to BR.
    const api = makeApi([g1, g2, g3, g4], 0);
    cycleGridGroups(asApi(api), -1);
    expect(g3.panels[0].api.setActive).toHaveBeenCalledTimes(1);
  });

  it("cycles a 3-panel layout (top-left, top-right, bottom-full) in reading order", () => {
    const tl = makeGroup("tl", ["a"], { rect: { left: 0, top: 0, width: 200, height: 200 } });
    const tr = makeGroup("tr", ["b"], { rect: { left: 200, top: 0, width: 200, height: 200 } });
    const bot = makeGroup("bot", ["c"], { rect: { left: 0, top: 200, width: 400, height: 200 } });

    // From TR, forward = bottom.
    const api = makeApi([tl, tr, bot], 1);
    cycleGridGroups(asApi(api), 1);
    expect(bot.panels[0].api.setActive).toHaveBeenCalledTimes(1);
    expect(tl.panels[0].api.setActive).not.toHaveBeenCalled();
  });

  it("cycles a horizontal row left→right", () => {
    const a = makeGroup("a", ["x"], { rect: { left: 0, top: 0, width: 200, height: 200 } });
    const b = makeGroup("b", ["y"], { rect: { left: 200, top: 0, width: 200, height: 200 } });
    const c = makeGroup("c", ["z"], { rect: { left: 400, top: 0, width: 200, height: 200 } });

    const api = makeApi([a, b, c], 0);
    cycleGridGroups(asApi(api), 1);
    expect(b.panels[0].api.setActive).toHaveBeenCalledTimes(1);
  });

  it("cycles a vertical column top→bottom", () => {
    const top = makeGroup("t", ["x"], { rect: { left: 0, top: 0, width: 200, height: 200 } });
    const mid = makeGroup("m", ["y"], { rect: { left: 0, top: 200, width: 200, height: 200 } });
    const bot = makeGroup("b", ["z"], { rect: { left: 0, top: 400, width: 200, height: 200 } });

    const api = makeApi([top, mid, bot], 0);
    cycleGridGroups(asApi(api), 1);
    expect(mid.panels[0].api.setActive).toHaveBeenCalledTimes(1);
  });

  it("skips groups whose element has zero size (detached / display:none)", () => {
    const visible0 = makeGroup("v0", ["a"], { rect: { left: 0, top: 0, width: 200, height: 200 } });
    const ghost = makeGroup("ghost", ["g"], { rect: { left: 0, top: 0, width: 0, height: 0 } });
    const visible1 = makeGroup("v1", ["b"], {
      rect: { left: 200, top: 0, width: 200, height: 200 },
    });

    const api = makeApi([visible0, ghost, visible1], 0);
    cycleGridGroups(asApi(api), 1);
    expect(visible1.panels[0].api.setActive).toHaveBeenCalledTimes(1);
    expect(ghost.panels[0].api.setActive).not.toHaveBeenCalled();
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

  it("is a no-op when the group has only one panel and no other groups exist", () => {
    const g = makeGroup("g0", ["solo"]);
    selectNeighbourBeforeRemove(asApi(makeApi([g])), "solo");
    expect(g.panels[0].api.setActive).not.toHaveBeenCalled();
  });

  // --- Multi-tab group: in-group neighbour ---

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

  // --- Single-tab group: cross-group fallback ---

  it("activates the previous group in reading order when closing the last tab in a group", () => {
    // 2x2 layout, each group holds a single tab. Closing the panel in
    // the top-right group should move focus to the top-left (previous
    // in reading order TL→TR→BL→BR).
    const tl = makeGroup("tl", ["t-tl"], { rect: { left: 0, top: 0, width: 200, height: 200 } });
    const tr = makeGroup("tr", ["t-tr"], { rect: { left: 200, top: 0, width: 200, height: 200 } });
    const bl = makeGroup("bl", ["t-bl"], { rect: { left: 0, top: 200, width: 200, height: 200 } });
    const br = makeGroup("br", ["t-br"], {
      rect: { left: 200, top: 200, width: 200, height: 200 },
    });

    // From TR (single-tab group), closing t-tr should pre-activate TL.
    selectNeighbourBeforeRemove(asApi(makeApi([tl, tr, bl, br], 1)), "t-tr");
    expect(tl.panels[0].api.setActive).toHaveBeenCalledTimes(1);
    expect(bl.panels[0].api.setActive).not.toHaveBeenCalled();
    expect(br.panels[0].api.setActive).not.toHaveBeenCalled();
  });

  it("wraps to the last group when closing the last tab in the first group", () => {
    // Same 2x2. Closing the panel in TL (first in reading order) wraps
    // to BR (last in reading order).
    const tl = makeGroup("tl", ["t-tl"], { rect: { left: 0, top: 0, width: 200, height: 200 } });
    const tr = makeGroup("tr", ["t-tr"], { rect: { left: 200, top: 0, width: 200, height: 200 } });
    const bl = makeGroup("bl", ["t-bl"], { rect: { left: 0, top: 200, width: 200, height: 200 } });
    const br = makeGroup("br", ["t-br"], {
      rect: { left: 200, top: 200, width: 200, height: 200 },
    });

    selectNeighbourBeforeRemove(asApi(makeApi([tl, tr, bl, br], 0)), "t-tl");
    expect(br.panels[0].api.setActive).toHaveBeenCalledTimes(1);
    expect(tr.panels[0].api.setActive).not.toHaveBeenCalled();
    expect(bl.panels[0].api.setActive).not.toHaveBeenCalled();
  });

  it("uses reading order for the cross-group fallback regardless of api.groups order", () => {
    // Same 2x2 with api.groups deliberately scrambled. Without the
    // positional sort the implementation would land on whichever group
    // happened to come first in `api.groups`.
    const tl = makeGroup("tl", ["t-tl"], { rect: { left: 0, top: 0, width: 200, height: 200 } });
    const tr = makeGroup("tr", ["t-tr"], { rect: { left: 200, top: 0, width: 200, height: 200 } });
    const bl = makeGroup("bl", ["t-bl"], { rect: { left: 0, top: 200, width: 200, height: 200 } });
    const br = makeGroup("br", ["t-br"], {
      rect: { left: 200, top: 200, width: 200, height: 200 },
    });

    // Scrambled order: BR, TL, BL, TR. Active = BL (idx 2).
    // Reading order is still TL → TR → BL → BR; previous of BL is TR.
    selectNeighbourBeforeRemove(asApi(makeApi([br, tl, bl, tr], 2)), "t-bl");
    expect(tr.panels[0].api.setActive).toHaveBeenCalledTimes(1);
    expect(tl.panels[0].api.setActive).not.toHaveBeenCalled();
    expect(br.panels[0].api.setActive).not.toHaveBeenCalled();
  });
});
