/**
 * Regression coverage: the inner-dockview header toolbar buttons ("+" /
 * split) in the Chat panel must create the new panel in the VISIBLE
 * worktree — never in a different, cached-but-hidden one.
 *
 * The bug
 * -------
 * `MultiWorktreePanelHost` keeps every visited worktree mounted at
 * once; inactive ones are only
 * `visibility: hidden`, so several `DockviewChatContainer` instances are
 * live simultaneously and all keep re-rendering. The add/split handlers
 * used to live in a MODULE-LEVEL singleton ref that every instance
 * overwrote on render — last-writer-wins. Whichever (possibly hidden)
 * instance rendered most recently left ITS `worktreeId` + dockview api
 * baked into the global, so clicking "+" / split in the visible worktree
 * could create the chat in the wrong worktree's dockview.
 *
 * Keyboard shortcuts were unaffected (each instance handles its own
 * focus-scoped keydown and calls its own closures), so only the toolbar
 * buttons misfired — and only intermittently, depending on render order.
 *
 * The fix keys the handlers by the owning dockview's `api.id` (dockview
 * passes the owning `containerApi` into the header-action component), so a
 * click always routes to the worktree that owns the clicked group.
 *
 * Reproduction setup
 * ------------------
 * `MultiWorktreePanelHost` renders its cached entries in Map INSERTION
 * order (`Array.from(cache.values())`). A full `goto(A)` resets the cache
 * to `{A}`; an in-app `switchWorktree(B)` makes it `{A, B}`; switching
 * back in-app to A leaves the order `[A, B]` — so A is VISIBLE but B (now
 * hidden) is the LAST entry rendered each commit, i.e. the last writer the
 * buggy module-level singleton would capture. Clicking "+" in A then
 * created the panel in B on the broken code.
 *
 * Each test uses its OWN worktree pair (visible + cached). The toolbar
 * "+"/split path creates a chat panel with no server-side chat record, so
 * sharing a pair across tests would let one test's added panel be
 * orphan-pruned on the next test's restore — separate pairs keep each
 * test's baseline clean and the assertions deterministic.
 *
 * Architecture (same doctrine as the sibling specs)
 * -------------------------------------------------
 *   - Real production binary booted against a fresh tmp `~/.band/`.
 *   - No tRPC mocking; the dashboard renders against real procedures.
 *   - All UI driven through `WorktreePage` (no raw `getByRole` / `goto`
 *     in the test body).
 *   - Assertions read the server-persisted inner layout via
 *     `chatLayout.get` / `terminalLayout.get` (`countChatPanels` /
 *     `countTerminalPanels`) so they observe WHICH worktree's dockview
 *     the click actually mutated — the exact bug surface — rather than
 *     something cosmetic.
 *
 * Chat vs terminal coverage
 * -------------------------
 * The terminal tests are the DETERMINISTIC regression catch: the buggy
 * terminal `RightHeaderActions` reads the module-level `addTabRef.current`
 * at CLICK time, so after the switch dance above it resolves the trailing
 * (hidden) worktree's handler every time — clicking the visible
 * worktree's "+"/split creates the terminal in the hidden worktree, and
 * these tests fail on the broken code. The chat `RightHeaderActions`
 * instead captured `addTabRef.current` at RENDER time, so the visible
 * worktree's chat header — mounted when its own worktree was the most
 * recent writer — held the correct handler and the bug only surfaced on a
 * later stale re-render. The chat tests therefore lock in the FIXED chat
 * routing (handlers keyed by `containerApi.id`) for the buttons named in
 * the bug report, while the terminal tests prove the regression itself is
 * caught. Both containers received the identical fix.
 *
 * Out of scope: browser container
 * -------------------------------
 * `DockviewBrowserContainer` got the SAME keyed-by-`api.id` fix (add /
 * split / close), but it is only mounted in the Electron DESKTOP build:
 * `BrowserPanelComponent` in `SharedDockviewLayout.tsx` renders a
 * "desktop only" web fallback under `if (!isDesktop)` and mounts
 * `DockviewBrowserContainer` solely on desktop. This Playwright suite
 * boots the WEB build (`dist/start-server.mjs` driven by Chromium), where
 * `isDesktop` is false, so the browser container never mounts and a
 * runtime browser test can't run here — identical reasoning and exemption
 * to `panel-default-position.spec.ts`'s browser carve-out. The browser
 * half of the fix is covered by TypeScript + structural review (it is the
 * same transformation applied to chat/terminal) and would need a desktop
 * e2e harness to exercise at runtime; the `WorktreePage` helpers already
 * accept `"browser"` (`countInnerPanels`) so that future harness can wire
 * it up without re-deriving the path.
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

const TOKEN = "e2e-panel-toolbar-target-token";

// One dedicated worktree pair per test (visible + cached), so no test's
// toolbar-added panel can leak into another's restore/prune path.
const ADD_VISIBLE = toWorktreeId("alpha-add", "main");
const ADD_CACHED = toWorktreeId("bravo-add", "main");
const SPLIT_VISIBLE = toWorktreeId("alpha-split", "main");
const SPLIT_CACHED = toWorktreeId("bravo-split", "main");
const TERM_ADD_VISIBLE = toWorktreeId("alpha-term-add", "main");
const TERM_ADD_CACHED = toWorktreeId("bravo-term-add", "main");
const TERM_SPLIT_VISIBLE = toWorktreeId("alpha-term-split", "main");
const TERM_SPLIT_CACHED = toWorktreeId("bravo-term-split", "main");

function repo(name: string) {
  return {
    name,
    path: `/tmp/fake/${name}`,
    defaultBranch: "main",
    worktrees: [{ branch: "main", path: `/tmp/fake/${name}` }],
  };
}

// Wide viewport so `useIsDesktop()` reports true and the shared dockview
// (which hosts the inner chat container under test) renders.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    repos: [
      repo("alpha-add"),
      repo("bravo-add"),
      repo("alpha-split"),
      repo("bravo-split"),
      repo("alpha-term-add"),
      repo("bravo-term-add"),
      repo("alpha-term-split"),
      repo("bravo-term-split"),
    ],
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

/**
 * Mount BOTH worktrees (so both chat containers are live) with `visible`
 * shown and `cached` the trailing cache entry, then return a settled
 * baseline of each worktree's persisted chat panel count.
 *
 *   1. `goto(visible)` — full navigation, cache resets to `{visible}`.
 *   2. `switchWorktree(cached)` — in-app nav, cache `{visible, cached}`,
 *      `cached` shown, `visible` hidden but still mounted.
 *   3. `switchWorktree(visible)` — in-app nav, `visible` shown again;
 *      cache order stays `[visible, cached]`, so `cached` is the trailing
 *      (last-rendered) entry — the writer the buggy singleton would
 *      capture.
 *
 * Both chat containers seed a default tab on cold mount and debounce-save
 * it, so we poll until each side reports its baseline before acting.
 */
async function mountBothAndSettle(
  worktreePage: WorktreePage,
  visible: string,
  cached: string,
): Promise<{ baseVisible: number; baseCached: number }> {
  await worktreePage.goto(visible);
  await worktreePage.waitForReady();
  // The default layout is a single terminal — open a chat leaf so this test has
  // one to target. Its visible-true marker proves the chat mounted (its layout
  // persists) before we move on.
  await worktreePage.openChat(visible);
  await expect(worktreePage.chatTabVisibilityMarker(visible, true)).toBeVisible();

  await worktreePage.switchWorktree(cached);
  await worktreePage.waitForReady();
  await worktreePage.openChat(cached);
  await expect(worktreePage.chatTabVisibilityMarker(cached, true)).toBeVisible();

  await worktreePage.switchWorktree(visible);
  await worktreePage.waitForReady();
  // `visible` is shown again; its chat "+" button is actionable. Positive
  // anchor that the visible toolbar we're about to click is the right one.
  await expect(worktreePage.chatAddTabButton(visible).first()).toBeVisible();

  // Settle both persisted baselines (each defaults to a single chat tab).
  // Two sequential polls so the actual counts surface in the Playwright
  // reporter on failure, then read the stabilised values once.
  await expect
    .poll(() => worktreePage.countChatPanels(visible), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(() => worktreePage.countChatPanels(cached), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1);

  const baseVisible = await worktreePage.countChatPanels(visible);
  const baseCached = await worktreePage.countChatPanels(cached);
  return { baseVisible, baseCached };
}

/**
 * Terminal counterpart of `mountBothAndSettle`. The inner terminal
 * container only mounts when the outer Terminal tab is active, so we
 * activate it on each worktree while it's shown — that also mounts the
 * cached worktree's terminal container (the last-writer the buggy
 * read-at-click handler resolves). On the final return to `visible` the
 * per-worktree active-view restore re-activates Terminal automatically
 * (it was the saved active view), so we don't re-click the tab — clicking
 * it again would re-render `visible`'s terminal container and reset the
 * module-level ref, masking the bug.
 */
async function mountBothTerminalsAndSettle(
  worktreePage: WorktreePage,
  visible: string,
  cached: string,
): Promise<{ baseVisible: number; baseCached: number }> {
  await worktreePage.goto(visible);
  await worktreePage.waitForReady();
  await worktreePage.openTerminalTab();
  await expect(worktreePage.terminalTabVisibilityMarker(visible, true)).toBeVisible();

  await worktreePage.switchWorktree(cached);
  await worktreePage.waitForReady();
  await worktreePage.openTerminalTab();
  await expect(worktreePage.terminalTabVisibilityMarker(cached, true)).toBeVisible();

  await worktreePage.switchWorktree(visible);
  await worktreePage.waitForReady();
  // Terminal is restored as the visible worktree's active view; its "+"
  // button is actionable. Positive anchor for the click target.
  await expect(worktreePage.terminalAddTabButton(visible).first()).toBeVisible();

  // Two sequential polls so the actual counts surface in the Playwright
  // reporter on failure, then read the stabilised values once.
  await expect
    .poll(() => worktreePage.countTerminalPanels(visible), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(() => worktreePage.countTerminalPanels(cached), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1);

  const baseVisible = await worktreePage.countTerminalPanels(visible);
  const baseCached = await worktreePage.countTerminalPanels(cached);
  return { baseVisible, baseCached };
}

// TODO(#643 Phase 5): re-point to Cmd+D split / new toolbar. The whole premise
// (per-container inner-dockview add/split toolbars + a module-level singleton
// bug + server-side per-container layout counts) is gone: the unified center
// dockview has one `+` menu and split is keyboard-only, and layout persists to
// localStorage (band:dockview-layout-v8:<id>), not chatLayout/terminalLayout.
test.describe("Inner-dockview toolbar targets the visible worktree", () => {
  test("clicking the chat '+' creates the tab in the VISIBLE worktree, not the cached one", async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const { baseVisible, baseCached } = await mountBothAndSettle(
      worktreePage,
      ADD_VISIBLE,
      ADD_CACHED,
    );

    await worktreePage.clickChatAddTab(ADD_VISIBLE);

    // The visible worktree gained a chat panel...
    await expect
      .poll(() => worktreePage.countChatPanels(ADD_VISIBLE), { timeout: 10_000 })
      .toBe(baseVisible + 1);

    // ...and the hidden, cached worktree was NOT touched. On the buggy
    // module-level-singleton code the panel landed in the cached worktree
    // instead. Poll (not a bare read) so a debounce-delayed wrong-worktree
    // persist can't slip in after a stale baseline read and pass falsely.
    await expect
      .poll(() => worktreePage.countChatPanels(ADD_CACHED), { timeout: 3_000 })
      .toBe(baseCached);
  });

  test("clicking the chat 'Split right' splits in the VISIBLE worktree, not the cached one", async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const { baseVisible, baseCached } = await mountBothAndSettle(
      worktreePage,
      SPLIT_VISIBLE,
      SPLIT_CACHED,
    );

    await worktreePage.clickChatSplitRight(SPLIT_VISIBLE);

    // Split adds a panel (in a new group) to the VISIBLE worktree...
    await expect
      .poll(() => worktreePage.countChatPanels(SPLIT_VISIBLE), { timeout: 10_000 })
      .toBe(baseVisible + 1);

    // ...and leaves the cached worktree untouched (poll to absorb a
    // debounce-delayed wrong-worktree persist — see the add-tab test).
    await expect
      .poll(() => worktreePage.countChatPanels(SPLIT_CACHED), { timeout: 3_000 })
      .toBe(baseCached);
  });

  test("clicking the terminal '+' creates the tab in the VISIBLE worktree, not the cached one", async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const { baseVisible, baseCached } = await mountBothTerminalsAndSettle(
      worktreePage,
      TERM_ADD_VISIBLE,
      TERM_ADD_CACHED,
    );

    await worktreePage.clickTerminalAddTab(TERM_ADD_VISIBLE);

    // The visible worktree gained a terminal panel...
    await expect
      .poll(() => worktreePage.countTerminalPanels(TERM_ADD_VISIBLE), { timeout: 10_000 })
      .toBe(baseVisible + 1);

    // ...and the hidden, cached worktree was NOT touched. The buggy
    // module-level singleton resolved the cached worktree's handler at
    // click time, creating the terminal there — this assertion fails on
    // the broken code. Poll to absorb a debounce-delayed persist.
    await expect
      .poll(() => worktreePage.countTerminalPanels(TERM_ADD_CACHED), { timeout: 3_000 })
      .toBe(baseCached);
  });

  test("clicking the terminal 'Split right' splits in the VISIBLE worktree, not the cached one", async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const { baseVisible } = await mountBothTerminalsAndSettle(
      worktreePage,
      TERM_SPLIT_VISIBLE,
      TERM_SPLIT_CACHED,
    );
    const wrappersVisibleBefore = await worktreePage.terminalWrapperCount(TERM_SPLIT_VISIBLE);
    const wrappersCachedBefore = await worktreePage.terminalWrapperCount(TERM_SPLIT_CACHED);

    await worktreePage.clickTerminalSplitRight(TERM_SPLIT_VISIBLE);

    // A terminal split is now a nested PANE: the VISIBLE worktree gains a new
    // xterm wrapper (pane)...
    await expect
      .poll(() => worktreePage.terminalWrapperCount(TERM_SPLIT_VISIBLE), { timeout: 10_000 })
      .toBe(wrappersVisibleBefore + 1);
    // ...while its terminal TAB count is unchanged (a split is a pane, not a
    // new terminal tab).
    await expect
      .poll(() => worktreePage.countTerminalPanels(TERM_SPLIT_VISIBLE), { timeout: 3_000 })
      .toBe(baseVisible);
    // ...and the cached worktree is untouched (poll to absorb a debounce-delayed
    // wrong-worktree persist — see the add-tab test).
    await expect
      .poll(() => worktreePage.terminalWrapperCount(TERM_SPLIT_CACHED), { timeout: 3_000 })
      .toBe(wrappersCachedBefore);
  });
});
