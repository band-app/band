import { describe, expect, it } from "vitest";
import { PaneActivations } from "../src/lib/agent-pane-events";

function fakeDock() {
  const panels = new Map<string, { api: { setActive(): void } }>();
  const activated: string[] = [];
  return {
    activated,
    add: (id: string) => panels.set(id, { api: { setActive: () => activated.push(id) } }),
    getPanel: (id: string) => panels.get(id),
  };
}

describe("PaneActivations", () => {
  it("activates a pane added after the launch announced it", () => {
    const dock = fakeDock();
    const activations = new PaneActivations();
    activations.expect("chat-1");
    dock.add("chat-1");
    expect(activations.activate("chat-1", dock.getPanel)).toBe(true);
    expect(dock.activated).toEqual(["chat-1"]);
  });

  it("activates a pane that already exists when the launch answer arrives", () => {
    const dock = fakeDock();
    const activations = new PaneActivations();
    activations.expect("chat-1");
    // The creation event came first: the pane exists but the event handler
    // ran before anyone asked for it, so it was not activated.
    dock.add("chat-1");
    expect(activations.activate("chat-1", dock.getPanel)).toBe(true);
    expect(dock.activated).toEqual(["chat-1"]);
  });

  it("keeps waiting while the pane is missing and activates once it exists", () => {
    const dock = fakeDock();
    const activations = new PaneActivations();
    activations.expect("term-1");
    expect(activations.activate("term-1", dock.getPanel)).toBe(false);
    dock.add("term-1");
    expect(activations.activate("term-1", dock.getPanel)).toBe(true);
    expect(activations.activate("term-1", dock.getPanel)).toBe(false);
  });

  it("ignores panes it was not told to expect", () => {
    const dock = fakeDock();
    dock.add("other");
    expect(new PaneActivations().activate("other", dock.getPanel)).toBe(false);
    expect(dock.activated).toEqual([]);
  });
});
