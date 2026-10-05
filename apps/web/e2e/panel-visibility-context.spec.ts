/**
 * Regression coverage for issue #469 — the three Dockview inner
 * containers (Chat / Terminal / Browser) share a single
 * `PanelVisibilityContext` instead of each declaring their own.
 *
 * Background
 * ----------
 * Before #469, `DockviewChatContainer`, `DockviewTerminalContainer` and
 * `DockviewBrowserContainer` each declared their own React Context with
 * an identical `{ visible, wsActive }` shape and wrapped their inner
 * `DockviewReact` in a per-container Provider. The refactor moved the
 * context out into `panel-visibility-context.tsx` and pointed all three
 * containers at the shared `PanelVisibilityContext` + `usePanelVisibility`.
 *
 * What this spec asserts
 * ----------------------
 * The visibility signal still reaches the tab panels — i.e. each
 * container's `<PanelVisibilityContext.Provider value={…}>` is correctly
 * wired AND the leaf tab panel still calls `usePanelVisibility()`
 * inside the Provider's subtree. We assert this directly by reading a
 * `data-testid` on the tab panel's wrapper div that encodes the
 * `visible` value the context plumbed in.
 *
 * If a future change removed the Provider on any one container (or
 * pointed the hook at the wrong context), the leaf would fall back to
 * the context's default value (`{ visible: true, wsActive: true }`) and
 * the marker for a worktree cached behind another active one would
 * report `visible-true` instead of `visible-false`. The test below
 * checks exactly that case for both the chat and terminal containers.
 *
 * Why we use the hidden mounted entry as the regression lever
 * -----------------------------------------------------------
 * The outer Shared Dockview's default `onlyWhenVisible` mode detaches a
 * panel's content from the DOM when its outer tab is inactive — so a
 * test that just clicks outer tabs back and forth couldn't distinguish
 * "context propagated visible=false" from "container unmounted". The
 * `MultiWorktreePanelHost` keeps the inactive worktree's
 * subtree MOUNTED but passes `wsActive=false` into its
 * `DockviewChatContainer` / `DockviewTerminalContainer`. The shared
 * context is the only channel that propagates that `wsActive=false`
 * down to the leaf — making it the exact regression lever this refactor
 * could break.
 *
 * Out of scope
 * ------------
 * The Browser container is only mounted in the Electron desktop build
 * (see `SharedDockviewLayout`'s `BrowserPanelComponent` web fallback).
 * The same `data-testid` marker is set on it for parity, but verifying
 * it requires desktop e2e coverage that this web-build spec can't
 * provide. The TypeScript + biome + lint pipeline catches the symbol-
 * level half of the refactor on that container; the structural half
 * (Provider wiring + hook usage) mirrors chat and terminal exactly, so
 * coverage on those two is a reasonable proxy.
 */

import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-panel-visibility-context-token";

const REPO_A = "alpha-visibility";
const REPO_B = "bravo-visibility";
const WORKTREE_A = toWorktreeId(REPO_A, "main");
const WORKTREE_B = toWorktreeId(REPO_B, "main");
// The terminal test gets its own pair. The chat test's chats are saved on
// the server, and a worktree with a saved chat no longer boots into the
// single-terminal default layout.
const REPO_C = "charlie-visibility";
const REPO_D = "delta-visibility";
const WORKTREE_C = toWorktreeId(REPO_C, "main");
const WORKTREE_D = toWorktreeId(REPO_D, "main");

// Wide viewport so `useIsDesktop()` reports true and the shared dockview
// renders (>= 1024px in `apps/web/src/hooks/useIsDesktop.ts`). The chat
// / terminal containers under test only mount in the desktop layout.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    repos: [REPO_A, REPO_B, REPO_C, REPO_D].map((name) => ({
      name,
      path: `/tmp/fake/${name}`,
      defaultBranch: "main",
      worktrees: [{ branch: "main", path: `/tmp/fake/${name}` }],
    })),
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

// UI state lives on the server now: start each test from none, like the
// fresh localStorage each test's browser context used to give it.
test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.beforeEach(async ({ page }) => {
  // Land on the worktree URL first so localStorage is accessible
  // (origin-scoped), clear the per-worktree dockview state for both
  // worktrees, and start tests from a default layout.
  await page.goto(`${server.url}/worktree/${encodeURIComponent(WORKTREE_A)}?token=${TOKEN}`);
  await page.evaluate(
    ([keys]) => {
      for (const key of keys) localStorage.removeItem(key);
    },
    [[WORKTREE_A, WORKTREE_B, WORKTREE_C, WORKTREE_D].map((id) => `band:dockview-active:${id}`)],
  );
});

test.describe("Panel visibility context (issue #469)", () => {
  test("Chat tab panel observes visible=true for the active worktree and visible=false for the cached one", async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);

    // Navigate to A and open a chat leaf (the default layout is a single
    // terminal now). Its ChatTabContent wrapper's `visible` = `parentVisible
    // (true) && tabActive(true)`, so the active chat gets `visible=true`.
    await worktreePage.goto(WORKTREE_A);
    await worktreePage.waitForReady();
    await worktreePage.openChat(WORKTREE_A);

    // Positive anchor: A's active chat tab has the visible-true marker.
    await expect(worktreePage.chatTabVisibilityMarker(WORKTREE_A, true)).toBeVisible();

    // Switch to B via the sidebar card. This uses TanStack Router's
    // in-app navigation, which keeps A's panels mounted
    // while flipping `wsActive` from true→false for A and
    // false→true for B. The full-page `goto()` would tear down the
    // React tree and defeat the regression lever.
    await worktreePage.switchWorktree(WORKTREE_B);
    await worktreePage.waitForReady();
    await worktreePage.openChat(WORKTREE_B);

    // Anchor on B's visible-true marker first — proves the new
    // worktree actually rendered before we assert on A's now-hidden
    // state.
    await expect(worktreePage.chatTabVisibilityMarker(WORKTREE_B, true)).toBeVisible();

    // A is cached → `wsActive=false` → context value becomes
    // `{ visible: false, wsActive: false }` → leaf marker flips to
    // `visible-false`. If the shared-context refactor regressed (e.g.
    // the Provider was removed from `DockviewChatContainer`), the
    // leaf would default to `{ visible: true, wsActive: true }` and
    // A's marker would still report `visible-true` even while cached.
    await expect(worktreePage.chatTabVisibilityMarker(WORKTREE_A, false)).toBeAttached();
    await expect(worktreePage.chatTabVisibilityMarker(WORKTREE_A, true)).toHaveCount(0);
  });

  test("Terminal tab panel observes visible=true for the active worktree and visible=false for the cached one", async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);

    await worktreePage.goto(WORKTREE_C);
    await worktreePage.waitForReady();

    // Activate the outer Terminal tab. The default layout starts with
    // Changes as the active tab in the right group; clicking Terminal
    // promotes its panel to active and mounts the
    // `DockviewTerminalContainer`. The Chat panel is in a separate
    // group on the left and stays mounted regardless.
    await worktreePage.tab("terminal").click();

    // Sanity-check C's terminal tab observed visible=true via the
    // shared context.
    await expect(worktreePage.terminalTabVisibilityMarker(WORKTREE_C, true)).toBeVisible();

    // Switch to D — C becomes cached, D is now active. The outer
    // Terminal tab stays selected (the outer dockview is shared across
    // worktrees), so both C's and D's terminal containers stay
    // mounted simultaneously.
    await worktreePage.switchWorktree(WORKTREE_D);

    // Positive anchor on D before asserting C is hidden.
    await expect(worktreePage.terminalTabVisibilityMarker(WORKTREE_D, true)).toBeVisible();

    // C's cached terminal tab must now report visible=false. The same
    // regression-lever logic as the chat test above: the only way for
    // `wsActive=false` to reach the leaf is via the shared context.
    await expect(worktreePage.terminalTabVisibilityMarker(WORKTREE_C, false)).toBeAttached();
    await expect(worktreePage.terminalTabVisibilityMarker(WORKTREE_C, true)).toHaveCount(0);

    // Round-trip back to C — C becomes active, D becomes cached. The
    // direction of the visibility flip reverses, proving the context
    // tracks `wsActive` symmetrically.
    await worktreePage.switchWorktree(WORKTREE_C);
    await expect(worktreePage.terminalTabVisibilityMarker(WORKTREE_C, true)).toBeVisible();
    await expect(worktreePage.terminalTabVisibilityMarker(WORKTREE_D, false)).toBeAttached();
    await expect(worktreePage.terminalTabVisibilityMarker(WORKTREE_D, true)).toHaveCount(0);
  });
});
