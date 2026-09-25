import { afterEach, describe, expect, it } from "vitest";
import {
  activateBrowserGuestWorkspace,
  registerBrowserGuest,
} from "../src/lib/browser-guest-retention.ts";

// Drives the hidden-workspace browser guest budget through its public surface
// (`registerBrowserGuest` + `activateBrowserGuestWorkspace`) — no mocks. The
// only consumer, `BrowserPaneComponent`, runs its native-view lifecycle only on
// the desktop build, and the e2e harness boots the web build, so a real-server
// Playwright test cannot reach it. That carve-out is recorded in CLAUDE.md →
// "## Testing Strategy → ### Exceptions".
//
// The registry is module state shared by every test in this file, so each test
// uses its own workspace ids and unregisters its guests afterwards.

const unregisters: (() => void)[] = [];

afterEach(() => {
  for (const unregister of unregisters.splice(0)) unregister();
});

/** Register a guest that records its own eviction into `evicted`. */
function registerGuest(workspaceId: string, browserId: string, evicted: string[]): void {
  const unregister = registerBrowserGuest(workspaceId, browserId, () => {
    evicted.push(browserId);
    unregister();
  });
  unregisters.push(unregister);
}

/** Register one guest per workspace; returns the ids whose guest was evicted. */
function registerGuests(workspaceIds: string[]): string[] {
  const evicted: string[] = [];
  for (const id of workspaceIds) registerGuest(id, id, evicted);
  return evicted;
}

/** Visit workspaces in order, the way `MultiWorkspacePanelHost` reports them. */
function visit(workspaceIds: string[]): void {
  for (const id of workspaceIds) activateBrowserGuestWorkspace(id);
}

describe("browser guest retention", () => {
  it("keeps live guests for the 4 most recently active hidden workspaces", () => {
    const ids = ["a1", "a2", "a3", "a4", "a5", "a6"];
    visit(ids.slice(0, 5));
    const evicted = registerGuests(ids.slice(0, 5));

    // a6 becomes active: a1 is the fifth most recent hidden workspace.
    activateBrowserGuestWorkspace("a6");

    expect(evicted).toEqual(["a1"]);
  });

  it("never evicts the active workspace, even far over budget", () => {
    const ids = ["b1", "b2", "b3", "b4", "b5", "b6"];
    visit(ids);
    const evicted = registerGuests(ids);

    // b1 is the least recently active but is now on screen.
    activateBrowserGuestWorkspace("b1");

    expect(evicted).toEqual(["b2"]);
  });

  it("does not count hidden workspaces that hold no live guest", () => {
    const ids = ["c1", "c2", "c3", "c4", "c5", "c6", "c7"];
    visit(ids.slice(0, 6));
    // c3 was visited but never opened a browser.
    const evicted = registerGuests(["c1", "c2", "c4", "c5", "c6"]);

    activateBrowserGuestWorkspace("c7");

    expect(evicted).toEqual(["c1"]);
  });

  it("evicts every guest of an over-budget workspace", () => {
    visit(["d1", "d2", "d3", "d4", "d5"]);
    const evicted: string[] = [];
    registerGuest("d1", "d1-tab-a", evicted);
    registerGuest("d1", "d1-tab-b", evicted);
    registerGuests(["d2", "d3", "d4", "d5"]);

    activateBrowserGuestWorkspace("d6");

    expect(evicted).toEqual(["d1-tab-a", "d1-tab-b"]);
  });

  it("stops counting a workspace once its last guest unregisters", () => {
    visit(["e1", "e2", "e3", "e4", "e5"]);
    const evicted = registerGuests(["e1", "e2", "e3", "e4"]);
    // e5 closes its only browser pane before the next switch, so e1 is back
    // within the budget of 4.
    registerBrowserGuest("e5", "e5", () => evicted.push("e5"))();

    activateBrowserGuestWorkspace("e6");

    expect(evicted).toEqual([]);
  });
});
