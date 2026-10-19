/**
 * `trackActivePanelTitle` is the glue that forwards a terminal pane's title to
 * its outer tab. It runs over the pure layout model with no DOM, so these tests
 * drive it directly. The lone-pane case is the regression: the first pane is
 * activated before any listener exists, so no event fires for it.
 */

import { describe, expect, it } from "vitest";
import { trackActivePanelTitle } from "../src/components/layout/active-panel-title";
import { LayoutApi } from "../src/components/layout/model";

function recorder(api: LayoutApi) {
  const seen: string[] = [];
  const push = () => seen.push(api.activePanel?.title ?? "Terminal");
  return { seen, push };
}

describe("trackActivePanelTitle", () => {
  it("forwards title changes of a lone pane added before tracking started", () => {
    const api = new LayoutApi();
    const pane = api.addPanel({ id: "t1", component: "term", title: "Terminal" });
    pane.api.setActive();
    const { seen, push } = recorder(api);
    trackActivePanelTitle(api, push);
    expect(seen).toEqual(["Terminal"]);
    pane.api.setTitle("hello");
    expect(seen).toEqual(["Terminal", "hello"]);
  });

  it("follows the focused pane in a split and stops listening to the previous one", () => {
    const api = new LayoutApi();
    const a = api.addPanel({ id: "a", component: "term", title: "zsh" });
    const b = api.addPanel({
      id: "b",
      component: "term",
      title: "claude",
      position: { referencePanel: "a", direction: "right" },
    });
    a.api.setActive();
    const { seen, push } = recorder(api);
    trackActivePanelTitle(api, push);
    b.api.setActive();
    expect(seen.at(-1)).toBe("claude");
    const before = seen.length;
    a.api.setTitle("ignored");
    expect(seen.length).toBe(before);
    b.api.setTitle("claude 2");
    expect(seen.at(-1)).toBe("claude 2");
  });

  it("stops forwarding after dispose", () => {
    const api = new LayoutApi();
    const pane = api.addPanel({ id: "t1", component: "term", title: "x" });
    pane.api.setActive();
    const { seen, push } = recorder(api);
    trackActivePanelTitle(api, push).dispose();
    const n = seen.length;
    pane.api.setTitle("y");
    expect(seen.length).toBe(n);
  });
});
