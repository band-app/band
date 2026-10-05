import { afterEach, describe, expect, it } from "vitest";
import {
  activateBrowserGuestWorktree,
  registerBrowserGuest,
} from "../src/lib/browser-guest-retention.ts";

// Drives the hidden-worktree browser guest budget through its public surface
// (`registerBrowserGuest` + `activateBrowserGuestWorktree`) — no mocks. The
// only consumer, `BrowserPaneComponent`, runs its native-view lifecycle only on
// the desktop build, and the e2e harness boots the web build, so a real-server
// Playwright test cannot reach it.
//
// The registry is module state shared by every test in this file, so each test
// uses its own worktree ids and unregisters its guests afterwards.

const unregisters: (() => void)[] = [];

afterEach(() => {
  for (const unregister of unregisters.splice(0)) unregister();
});

/** Register a guest that records its own eviction into `evicted`. */
function registerGuest(worktreeId: string, browserId: string, evicted: string[]): void {
  const unregister = registerBrowserGuest(worktreeId, browserId, () => {
    evicted.push(browserId);
    unregister();
  });
  unregisters.push(unregister);
}

/** Visit worktrees in order, opening one browser in each, the way
 *  `BrowserPaneComponent` registers its view while its worktree is active.
 *  Returns the ids whose guest was evicted. */
function visitWithBrowser(worktreeIds: string[], evicted: string[] = []): string[] {
  for (const id of worktreeIds) {
    activateBrowserGuestWorktree(id);
    registerGuest(id, id, evicted);
  }
  return evicted;
}

describe("browser guest retention", () => {
  it("keeps live guests for the 4 most recently active hidden worktrees", () => {
    const evicted = visitWithBrowser(["a1", "a2", "a3", "a4", "a5"]);

    // a6 becomes active: a1 is the fifth most recent hidden worktree.
    activateBrowserGuestWorktree("a6");

    expect(evicted).toEqual(["a1"]);
  });

  it("does not count the active worktree against the budget", () => {
    const evicted = visitWithBrowser(["b1", "b2", "b3", "b4", "b5"]);

    // Back on b1, the least recently active: five worktrees hold guests, but
    // only the four hidden ones count, so nothing is over budget.
    activateBrowserGuestWorktree("b1");

    expect(evicted).toEqual([]);
  });

  it("does not count hidden worktrees that hold no live guest", () => {
    const evicted = visitWithBrowser(["c1", "c2"]);
    // c3 is visited but never opens a browser.
    activateBrowserGuestWorktree("c3");
    visitWithBrowser(["c4", "c5", "c6"], evicted);

    activateBrowserGuestWorktree("c7");

    expect(evicted).toEqual(["c1"]);
  });

  it("counts a guest whose view finished creating after its worktree was left", () => {
    const evicted: string[] = [];
    activateBrowserGuestWorktree("f1");
    // The user moves on before f1's view is created.
    activateBrowserGuestWorktree("f2");
    registerGuest("f1", "f1", evicted);
    visitWithBrowser(["f2", "f3", "f4", "f5"], evicted);

    activateBrowserGuestWorktree("f6");

    expect(evicted).toEqual(["f1"]);
  });

  it("evicts every guest of an over-budget worktree", () => {
    const evicted: string[] = [];
    activateBrowserGuestWorktree("d1");
    registerGuest("d1", "d1-tab-a", evicted);
    registerGuest("d1", "d1-tab-b", evicted);
    visitWithBrowser(["d2", "d3", "d4", "d5"]);

    activateBrowserGuestWorktree("d6");

    expect(evicted).toEqual(["d1-tab-a", "d1-tab-b"]);
  });

  it("stops counting a worktree once its last guest unregisters", () => {
    const evicted = visitWithBrowser(["e1", "e2", "e3", "e4"]);
    // e5 opens a browser and closes it again before the next switch, so e1 is
    // still within the budget of 4.
    activateBrowserGuestWorktree("e5");
    registerBrowserGuest("e5", "e5", () => evicted.push("e5"))();

    activateBrowserGuestWorktree("e6");

    expect(evicted).toEqual([]);
  });
});
