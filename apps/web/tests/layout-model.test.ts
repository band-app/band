/**
 * The layout model (`components/layout/model.ts`) is a pure TypeScript module,
 * so these tests drive it directly: it has no DOM, no mocks and no state to
 * fake. The fixtures in `fixtures/layouts/` are `toJSON()` output captured from
 * dockview 6.0.6, the library the layout replaced, and
 * `legacy-edge-groups.json` is the shape from
 * `e2e/worktree-legacy-edge-layout.spec.ts`. Every saved layout a user has was
 * written in this shape, so reading it back unchanged is the compatibility
 * requirement.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { LayoutApi, type LayoutPanel } from "../src/components/layout/model";
import { sanitizeSavedLayout, stripParams } from "../src/components/layout/saved-layout";
import { parseSerializedLayout } from "../src/components/layout/serialized";

const KNOWN = new Set(["chat", "term", "browser", "file", "diff"]);

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures/layouts", `${name}.json`), "utf8"),
  );
}

// oxlint-disable-next-line typescript/no-explicit-any -- fixtures are edited as loose JSON
type JsonObject = Record<string, any>;

interface Shape {
  type: string;
  size?: number;
  id?: string;
  views?: string[];
  activeView?: string;
  children?: Shape[];
}

/** The tree of a serialized layout without fields the model drops. */
function shape(node: unknown): Shape {
  const n = node as { type: string; size?: number; data: unknown };
  if (n.type === "leaf") {
    const d = n.data as { id: string; views: string[]; activeView?: string };
    return { type: "leaf", size: n.size, id: d.id, views: d.views, activeView: d.activeView };
  }
  return { type: "branch", size: n.size, children: (n.data as unknown[]).map(shape) };
}

/** Same tree, with sizes compared within a pixel. */
function expectSameShape(actual: Shape, expected: Shape) {
  expect(actual.type).toBe(expected.type);
  expect(Math.abs((actual.size ?? 0) - (expected.size ?? 0))).toBeLessThanOrEqual(1);
  expect(actual.id).toBe(expected.id);
  expect(actual.views).toEqual(expected.views);
  expect(actual.activeView).toBe(expected.activeView);
  expect(actual.children?.length).toBe(expected.children?.length);
  actual.children?.forEach((c, i) => {
    expectSameShape(c, (expected.children as Shape[])[i]);
  });
}

function roundTrip(name: string) {
  const saved = fixture(name);
  const api = new LayoutApi();
  api.fromJSON(saved);
  const out = JSON.parse(JSON.stringify(api.toJSON())) as Record<string, unknown>;
  return { saved, api, out };
}

function layoutOf(...ids: string[]): LayoutApi {
  const api = new LayoutApi();
  api.layout(1200, 800);
  for (const id of ids) api.addPanel({ id, component: "chat" });
  return api;
}

function tabs(api: LayoutApi): string[][] {
  return api.groups.map((g) => g.panels.map((p) => p.id));
}

describe("saved layouts from dockview", () => {
  for (const name of [
    "one-group",
    "three-groups-nested",
    "maximized",
    "terminal-split-three-panes",
  ]) {
    it(`${name}: reads and writes the same groups, tabs, order, active tab and sizes`, () => {
      const { saved, api, out } = roundTrip(name);
      const grid = saved.grid as {
        root: unknown;
        width: number;
        height: number;
        orientation: string;
      };
      const outGrid = out.grid as typeof grid;
      expect(outGrid.orientation).toBe(grid.orientation);
      expect(outGrid.width).toBe(grid.width);
      expect(outGrid.height).toBe(grid.height);
      expectSameShape(shape(outGrid.root), shape(grid.root));
      expect(out.activeGroup).toBe(saved.activeGroup);
      expect(api.activeGroup?.id).toBe(saved.activeGroup);
      // Panels: kind, tab component, title and params survive.
      expect(out.panels).toEqual(saved.panels);
    });
  }

  it("keeps the active tab of every group", () => {
    const { api } = roundTrip("three-groups-nested");
    expect(api.getGroup("1")?.activePanel?.id).toBe("file:a.ts");
    expect(api.getGroup("2")?.activePanel?.id).toBe("diff:c.ts");
    expect(api.activePanel?.id).toBe("file:a.ts");
  });

  it("reads nested sizes: 700 / (550 over 250)", () => {
    const { out } = roundTrip("three-groups-nested");
    const root = (out.grid as { root: { data: { size: number; data: { size: number }[] }[] } })
      .root;
    expect(root.data[0].size).toBe(700);
    expect(root.data[1].size).toBe(500);
    expect(root.data[1].data.map((n) => n.size)).toEqual([550, 250]);
  });

  it("reads the maximized group id from Band's own key and ignores dockview's maximizedNode", () => {
    const saved = fixture("maximized");
    expect(saved.maximizedGroup).toBe("2");
    const parsed = parseSerializedLayout(saved);
    expect(parsed?.maximizedGroup).toBe("2");
    const { out } = roundTrip("maximized");
    expect((out.grid as Record<string, unknown>).maximizedNode).toBeUndefined();
  });

  it("scales the saved pixel sizes to a different container, as proportions", () => {
    const api = new LayoutApi();
    api.fromJSON(fixture("three-groups-nested"));
    api.layout(600, 400, true);
    const out = JSON.parse(JSON.stringify(api.toJSON()));
    expect(out.grid.root.data[0].size).toBe(350);
    expect(out.grid.root.data[1].size).toBe(250);
    expect(out.grid.root.data[1].data.map((n: { size: number }) => n.size)).toEqual([275, 125]);
  });

  it("writes what it reads: a second round trip is identical", () => {
    const { out } = roundTrip("three-groups-nested");
    const again = new LayoutApi();
    again.fromJSON(out);
    expect(JSON.parse(JSON.stringify(again.toJSON()))).toEqual(out);
  });

  it("opens a layout with stripped params, as Band stores it", () => {
    const stripped = stripParams(fixture("one-group"));
    const api = new LayoutApi();
    api.fromJSON(stripped);
    expect(api.panels.map((p) => p.params)).toEqual([{}, {}, {}]);
    expect(api.activePanel?.id).toBe("chat-1");
  });

  it("opens a legacy layout with edge groups: their panels join the first grid group", () => {
    const legacy = fixture("legacy-edge-groups");
    const clean = sanitizeSavedLayout(structuredClone(legacy), KNOWN);
    expect(clean.edgeGroups).toBeUndefined();
    const api = new LayoutApi();
    api.fromJSON(clean);
    expect(tabs(api)).toEqual([["file:README.md", "file:guide.md", "file:notes.md"]]);
    // The `terminal` singleton and the view with no panel entry are gone.
    expect(api.getPanel("terminal")).toBeUndefined();
    expect(api.getPanel("file:missing-panel-entry.md")).toBeUndefined();
    expect(api.activePanel?.id).toBe("file:README.md");
  });

  it("opens a legacy layout whose grid is empty: edge panels get a group of their own", () => {
    const legacy = fixture("legacy-edge-groups");
    (legacy.grid as { root: { data: unknown[] } }).root.data = [];
    (legacy as { activeGroup: string }).activeGroup = "edge-bottom";
    const clean = sanitizeSavedLayout(structuredClone(legacy), KNOWN);
    const api = new LayoutApi();
    api.fromJSON(clean);
    expect(api.groups).toHaveLength(1);
    expect(api.groups[0].panels.map((p) => p.id).sort()).toEqual([
      "file:guide.md",
      "file:notes.md",
    ]);
    // The saved active group no longer exists: the first group takes over.
    expect(api.activeGroup).toBe(api.groups[0]);
  });
});

describe("reading a saved layout", () => {
  it("ignores fields it does not know", () => {
    const saved = fixture("one-group") as JsonObject;
    saved.floatingGroups = [{ data: { views: [], id: "9" }, position: { left: 1 } }];
    saved.popoutGroups = [];
    saved.grid.root.data[0].data.locked = true;
    saved.grid.root.data[0].data.tabGroups = [{ id: "t" }];
    saved.panels["term-1"].minimumWidth = 300;
    const api = new LayoutApi();
    api.fromJSON(saved);
    expect(tabs(api)).toEqual([["term-1", "chat-1", "file:README.md"]]);
  });

  it("drops a view with no panel entry and a group left without views", () => {
    const saved = fixture("three-groups-nested") as JsonObject;
    saved.grid.root.data[0].data.views.push("ghost");
    delete saved.panels["file:b.ts"];
    const api = new LayoutApi();
    api.fromJSON(saved);
    expect(api.getPanel("ghost")).toBeUndefined();
    expect(api.getGroup("3")).toBeUndefined();
    expect(tabs(api)).toEqual([
      ["term-1", "file:a.ts"],
      ["chat-1", "diff:c.ts"],
    ]);
  });

  it("selects the last tab of a group that names no active view", () => {
    const saved = fixture("one-group") as JsonObject;
    saved.grid.root.data[0].data.activeView = undefined;
    const api = new LayoutApi();
    api.fromJSON(saved);
    expect(api.activePanel?.id).toBe("file:README.md");
  });

  it("falls back to equal sizes when a saved size is missing", () => {
    const saved = fixture("three-groups-nested") as JsonObject;
    saved.grid.root.data[0].size = undefined;
    saved.grid.root.data[1].size = undefined;
    const api = new LayoutApi();
    api.fromJSON(saved);
    const out = JSON.parse(JSON.stringify(api.toJSON()));
    expect(out.grid.root.data.map((n: { size: number }) => n.size)).toEqual([600, 600]);
  });

  it("rejects a value that is not a layout", () => {
    const api = new LayoutApi();
    expect(() => api.fromJSON(null)).toThrow();
    expect(() => api.fromJSON({ grid: {}, panels: {} })).toThrow();
    expect(() => api.fromJSON({ grid: { root: { type: "leaf" } }, panels: {} })).toThrow();
  });

  it("does not fire panel events while loading", () => {
    const api = new LayoutApi();
    const seen: string[] = [];
    api.onDidAddPanel((p) => seen.push(p.id));
    api.onDidActivePanelChange(() => seen.push("active"));
    api.fromJSON(fixture("three-groups-nested"));
    expect(seen).toEqual([]);
  });
});

describe("adding panels", () => {
  it("adds to the active group, selecting the new tab", () => {
    const api = layoutOf("a", "b", "c");
    expect(tabs(api)).toEqual([["a", "b", "c"]]);
    expect(api.activePanel?.id).toBe("c");
  });

  it("splits a group to the right, halving its size", () => {
    const api = layoutOf("a");
    const g = api.groups[0];
    api.addPanel({
      id: "b",
      component: "chat",
      position: { referenceGroup: g, direction: "right" },
    });
    expect(tabs(api)).toEqual([["a"], ["b"]]);
    const sizes = api.toJSON().grid.root.data.map((n) => n.size);
    expect(sizes).toEqual([600, 600]);
    expect(api.activeGroup?.id).toBe(api.getPanel("b")?.group.id);
  });

  it("splits below by nesting a vertical branch, and splits that branch again", () => {
    const api = layoutOf("a");
    const g = api.groups[0];
    api.addPanel({
      id: "b",
      component: "chat",
      position: { referenceGroup: g, direction: "right" },
    });
    const gb = api.getPanel("b")?.group as NonNullable<LayoutPanel["group"]>;
    api.addPanel({
      id: "c",
      component: "chat",
      position: { referenceGroup: gb, direction: "below" },
    });
    const out = api.toJSON();
    expect(out.grid.orientation).toBe("HORIZONTAL");
    const [left, right] = out.grid.root.data;
    expect(left.type).toBe("leaf");
    expect(right.type).toBe("branch");
    expect((right as { data: { size: number }[] }).data.map((n) => n.size)).toEqual([400, 400]);
    expect(right.size).toBe(600);
  });

  it("puts a tab at an index, and after a reference panel", () => {
    const api = layoutOf("a", "b", "c");
    const g = api.groups[0];
    api.addPanel({ id: "x", component: "chat", position: { referenceGroup: g, index: 1 } });
    api.addPanel({ id: "y", component: "chat", position: { referencePanel: "a", index: 1 } });
    expect(tabs(api)).toEqual([["a", "y", "x", "b", "c"]]);
  });

  it("adds a panel without selecting it when inactive", () => {
    const api = layoutOf("a");
    api.addPanel({ id: "b", component: "chat", inactive: true });
    expect(api.activePanel?.id).toBe("a");
    expect(tabs(api)).toEqual([["a", "b"]]);
  });

  it("selects the first tab of a new group even when added inactive", () => {
    const api = layoutOf("a");
    api.addPanel({
      id: "b",
      component: "chat",
      inactive: true,
      position: { referenceGroup: api.groups[0], direction: "right" },
    });
    expect(api.getPanel("b")?.group.activePanel?.id).toBe("b");
    expect(api.activePanel?.id).toBe("a");
  });

  it("refuses a duplicate id and an unknown reference", () => {
    const api = layoutOf("a");
    expect(() => api.addPanel({ id: "a", component: "chat" })).toThrow();
    expect(() =>
      api.addPanel({ id: "z", component: "chat", position: { referenceGroup: "nope" } }),
    ).toThrow();
  });

  it("names new groups with the next free number", () => {
    const api = new LayoutApi();
    api.fromJSON(fixture("three-groups-nested"));
    api.addPanel({
      id: "n",
      component: "chat",
      position: { referenceGroup: "1", direction: "below" },
    });
    expect(api.getPanel("n")?.group.id).toBe("4");
  });

  it("keeps a panel's params and merges updates", () => {
    const api = layoutOf();
    const p = api.addPanel({ id: "a", component: "file", params: { path: "x", preview: true } });
    p.api.updateParameters({ preview: false, extra: 1 });
    expect(p.params).toEqual({ path: "x", preview: false, extra: 1 });
    p.api.updateParameters({ extra: undefined });
    expect(p.params).toEqual({ path: "x", preview: false });
  });
});

describe("closing", () => {
  it("selects the most recently used tab when the selected one closes", () => {
    const api = layoutOf("a", "b", "c");
    api.getPanel("a")?.api.setActive();
    api.getPanel("c")?.api.setActive();
    api.removePanel("c");
    expect(api.activePanel?.id).toBe("a");
  });

  it("removes a group with its last tab and gives the space to its sibling", () => {
    const api = layoutOf("a");
    api.addPanel({
      id: "b",
      component: "chat",
      position: { referenceGroup: api.groups[0], direction: "right" },
    });
    api.removePanel("b");
    expect(tabs(api)).toEqual([["a"]]);
    const out = api.toJSON();
    expect(out.grid.root.data).toHaveLength(1);
    expect(out.grid.root.data[0].size).toBe(1200);
    expect(api.activeGroup?.id).toBe("1");
  });

  it("collapses a nested split into its parent", () => {
    const api = new LayoutApi();
    api.fromJSON(fixture("three-groups-nested"));
    api.removePanel("file:b.ts");
    const root = api.toJSON().grid.root;
    expect(root.data.map((n) => n.type)).toEqual(["leaf", "leaf"]);
    expect(root.data.map((n) => n.size)).toEqual([700, 500]);
  });

  it("makes the inner split the root when the other side closes", () => {
    const api = new LayoutApi();
    api.fromJSON(fixture("three-groups-nested"));
    api.removePanel("term-1");
    api.removePanel("file:a.ts");
    const out = api.toJSON();
    expect(out.grid.orientation).toBe("VERTICAL");
    expect(tabs(api)).toEqual([["chat-1", "diff:c.ts"], ["file:b.ts"]]);
  });

  it("leaves an empty layout empty", () => {
    const api = layoutOf("a");
    api.removePanel("a");
    expect(api.panels).toHaveLength(0);
    expect(api.groups).toHaveLength(0);
    expect(api.activePanel).toBeUndefined();
    expect(api.toJSON().grid.root.data).toEqual([]);
  });

  it("activates the first remaining group when the active group goes", () => {
    const api = new LayoutApi();
    api.fromJSON(fixture("three-groups-nested"));
    api.getPanel("file:b.ts")?.api.setActive();
    expect(api.activeGroup?.id).toBe("3");
    api.removePanel("file:b.ts");
    expect(api.activeGroup?.id).toBe("1");
  });
});

describe("moving tabs", () => {
  it("reorders within a group, keeping the selection", () => {
    const api = layoutOf("a", "b", "c");
    const c = api.getPanel("c") as LayoutPanel;
    c.api.moveTo({ group: c.group, index: 0 });
    expect(tabs(api)).toEqual([["c", "a", "b"]]);
    expect(api.activePanel?.id).toBe("c");
  });

  it("moves a tab later in the same group, counting the gap it leaves", () => {
    const api = layoutOf("a", "b", "c");
    const a = api.getPanel("a") as LayoutPanel;
    a.api.moveTo({ group: a.group, index: 2 });
    expect(tabs(api)).toEqual([["b", "a", "c"]]);
  });

  it("moves a tab to another group and selects it there", () => {
    const api = layoutOf("a", "b");
    api.addPanel({
      id: "c",
      component: "chat",
      position: { referenceGroup: api.groups[0], direction: "right" },
    });
    const b = api.getPanel("b") as LayoutPanel;
    b.api.moveTo({ group: api.getPanel("c")?.group as never });
    expect(tabs(api)).toEqual([["a"], ["c", "b"]]);
    expect(api.activePanel?.id).toBe("b");
    expect(api.getPanel("a")?.group.activePanel?.id).toBe("a");
  });

  it("removes the group a tab leaves empty", () => {
    const api = layoutOf("a");
    api.addPanel({
      id: "b",
      component: "chat",
      position: { referenceGroup: api.groups[0], direction: "right" },
    });
    const removed: string[] = [];
    api.onDidRemoveGroup((g) => removed.push(g.id));
    const b = api.getPanel("b") as LayoutPanel;
    b.api.moveTo({ group: api.getPanel("a")?.group as never });
    expect(tabs(api)).toEqual([["a", "b"]]);
    expect(removed).toEqual(["2"]);
    expect(api.toJSON().grid.root.data).toHaveLength(1);
  });

  it("splits a group when a tab is dropped on its edge", () => {
    const api = layoutOf("a", "b");
    const b = api.getPanel("b") as LayoutPanel;
    api.movePanel(b, { group: b.group, position: "right" });
    expect(tabs(api)).toEqual([["a"], ["b"]]);
    const sizes = api.toJSON().grid.root.data.map((n) => n.size);
    expect(sizes).toEqual([600, 600]);
  });

  for (const [position, orientation, firstId] of [
    ["left", "HORIZONTAL", "b"],
    ["top", "VERTICAL", "b"],
    ["bottom", "VERTICAL", "a"],
  ] as const) {
    it(`drops on the ${position} edge of another group`, () => {
      const api = layoutOf("a");
      api.addPanel({
        id: "b",
        component: "chat",
        position: { referenceGroup: api.groups[0], direction: "right" },
      });
      api.addPanel({
        id: "c",
        component: "chat",
        position: { referenceGroup: api.getPanel("b")?.group, direction: "right" },
      });
      const c = api.getPanel("c") as LayoutPanel;
      const target = api.getPanel("a")?.group as never;
      api.movePanel(c, { group: target, position });
      const out = api.toJSON();
      if (orientation === "HORIZONTAL") {
        expect(out.grid.root.data.map((n) => n.type)).toEqual(["leaf", "leaf", "leaf"]);
      } else {
        expect(out.grid.root.data[0].type).toBe("branch");
      }
      expect(api.getPanel(firstId === "b" ? "c" : "a")).toBeDefined();
      expect(api.getPanel("c")?.group.id).not.toBe(api.getPanel("a")?.group.id);
    });
  }

  it("does nothing when a group's only tab is dropped on its own edge", () => {
    const api = layoutOf("a");
    const a = api.getPanel("a") as LayoutPanel;
    api.movePanel(a, { group: a.group, position: "left" });
    expect(tabs(api)).toEqual([["a"]]);
    expect(api.groups).toHaveLength(1);
  });

  it("fires one move event with the group the tab left", () => {
    const api = layoutOf("a");
    api.addPanel({
      id: "b",
      component: "chat",
      position: { referenceGroup: api.groups[0], direction: "right" },
    });
    const moves: [string, string][] = [];
    api.onDidMovePanel((e) => moves.push([e.panel.id, e.from.id]));
    (api.getPanel("b") as LayoutPanel).api.moveTo({ group: api.getPanel("a")?.group as never });
    expect(moves).toEqual([["b", "2"]]);
  });
});

describe("resizing", () => {
  it("writes the new split in pixels", () => {
    const api = layoutOf("a");
    api.addPanel({
      id: "b",
      component: "chat",
      position: { referenceGroup: api.groups[0], direction: "right" },
    });
    api.setWeights(api.root, [3, 1]);
    const sizes = api.toJSON().grid.root.data.map((n) => n.size);
    expect(sizes).toEqual([900, 300]);
  });

  it("fires a layout change for a resize and for a container size change", () => {
    const api = layoutOf("a");
    let n = 0;
    api.onDidLayoutChange(() => n++);
    api.layout(1000, 700);
    api.layout(1000, 700);
    expect(n).toBe(1);
    api.addPanel({ id: "b", component: "chat" });
    expect(n).toBe(2);
  });
});

describe("maximize", () => {
  it("shows only the maximized group", () => {
    const api = layoutOf("a");
    api.addPanel({
      id: "b",
      component: "chat",
      position: { referenceGroup: api.groups[0], direction: "right" },
    });
    const events: boolean[] = [];
    api.onDidMaximizedGroupChange((e) => events.push(e.isMaximized));
    const b = api.getPanel("b") as LayoutPanel;
    b.group.api.maximize();
    expect(b.group.api.isMaximized()).toBe(true);
    expect(b.isVisible).toBe(true);
    expect(api.getPanel("a")?.isVisible).toBe(false);
    b.group.api.exitMaximized();
    expect(api.getPanel("a")?.isVisible).toBe(true);
    expect(events).toEqual([true, false]);
  });

  it("keeps the sizes of the other groups while one is maximized", () => {
    const api = layoutOf("a");
    api.addPanel({
      id: "b",
      component: "chat",
      position: { referenceGroup: api.groups[0], direction: "right" },
    });
    api.setWeights(api.root, [3, 1]);
    (api.getPanel("b") as LayoutPanel).group.api.maximize();
    expect(api.toJSON().grid.root.data.map((n) => n.size)).toEqual([900, 300]);
  });

  it("leaves maximized when a structural change happens", () => {
    const api = layoutOf("a");
    api.addPanel({
      id: "b",
      component: "chat",
      position: { referenceGroup: api.groups[0], direction: "right" },
    });
    (api.getPanel("a") as LayoutPanel).group.api.maximize();
    api.addPanel({
      id: "c",
      component: "chat",
      position: { referenceGroup: api.groups[1], direction: "below" },
    });
    expect(api.maximizedGroup).toBeUndefined();
  });
});

describe("events", () => {
  it("tells a panel when it is selected, active and visible", () => {
    const api = layoutOf("a", "b");
    const a = api.getPanel("a") as LayoutPanel;
    const active: boolean[] = [];
    const visible: boolean[] = [];
    a.api.onDidActiveChange((e) => active.push(e.isActive));
    a.api.onDidVisibilityChange((e) => visible.push(e.isVisible));
    a.api.setActive();
    api.getPanel("b")?.api.setActive();
    expect(active).toEqual([true, false]);
    expect(visible).toEqual([true, false]);
  });

  it("separates a panel selected in an inactive group from an active one", () => {
    const api = layoutOf("a");
    api.addPanel({
      id: "b",
      component: "chat",
      position: { referenceGroup: api.groups[0], direction: "right" },
    });
    const a = api.getPanel("a") as LayoutPanel;
    expect(a.isVisible).toBe(true);
    expect(a.isActive).toBe(false);
    a.api.setActive();
    expect(a.isActive).toBe(true);
  });

  it("reports the active panel once per change", () => {
    const api = layoutOf("a", "b");
    const seen: (string | undefined)[] = [];
    api.onDidActivePanelChange((p) => seen.push(p?.id));
    api.getPanel("a")?.api.setActive();
    api.getPanel("a")?.api.setActive();
    api.removePanel("a");
    expect(seen).toEqual(["a", "b"]);
  });

  it("fires add and remove events with the state already updated", () => {
    const api = layoutOf();
    const seen: string[] = [];
    api.onDidAddPanel((p) => seen.push(`add ${p.id} ${api.panels.length}`));
    api.onDidRemovePanel((p) => seen.push(`remove ${p.id} ${api.panels.length}`));
    api.addPanel({ id: "a", component: "chat" });
    api.removePanel("a");
    expect(seen).toEqual(["add a 1", "remove a 0"]);
  });

  it("lets a listener that throws fail alone", () => {
    const api = layoutOf();
    const seen: string[] = [];
    const quiet = console.error;
    console.error = () => {};
    try {
      api.onDidAddPanel(() => {
        throw new Error("boom");
      });
      api.onDidAddPanel((p) => seen.push(p.id));
      api.addPanel({ id: "a", component: "chat" });
    } finally {
      console.error = quiet;
    }
    expect(seen).toEqual(["a"]);
  });

  it("fires title changes", () => {
    const api = layoutOf("a");
    const titles: string[] = [];
    api.getPanel("a")?.api.onDidTitleChange((e) => titles.push(e.title));
    api.getPanel("a")?.api.setTitle("New");
    api.getPanel("a")?.api.setTitle("New");
    expect(titles).toEqual(["New"]);
    expect(api.getPanel("a")?.title).toBe("New");
  });
});

describe("cycling tabs in a group", () => {
  it("wraps around", () => {
    const api = layoutOf("a", "b", "c");
    const g = api.groups[0];
    g.model.moveToNext();
    expect(api.activePanel?.id).toBe("a");
    g.model.moveToPrevious();
    expect(api.activePanel?.id).toBe("c");
  });
});

describe("clear", () => {
  it("empties the layout and starts group ids over on the next load", () => {
    const api = new LayoutApi();
    api.fromJSON(fixture("three-groups-nested"));
    api.clear();
    expect(api.panels).toHaveLength(0);
    expect(api.groups).toHaveLength(0);
    api.addPanel({ id: "x", component: "chat" });
    expect(api.groups).toHaveLength(1);
  });
});
