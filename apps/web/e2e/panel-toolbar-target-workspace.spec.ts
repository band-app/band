/**
 * Regression coverage: the inner-dockview header toolbar buttons ("+" /
 * split) in the Chat panel must create the new panel in the VISIBLE
 * workspace — never in a different, cached-but-hidden one.
 *
 * The bug
 * -------
 * `MultiWorkspacePanelHost` keeps up to `DEFAULT_MAX_CACHED_WORKSPACES`
 * (3) workspaces mounted at once; inactive ones are only
 * `visibility: hidden`, so several `DockviewChatContainer` instances are
 * live simultaneously and all keep re-rendering. The add/split handlers
 * used to live in a MODULE-LEVEL singleton ref that every instance
 * overwrote on render — last-writer-wins. Whichever (possibly hidden)
 * instance rendered most recently left ITS `workspaceId` + dockview api
 * baked into the global, so clicking "+" / split in the visible workspace
 * could create the chat in the wrong workspace's dockview.
 *
 * Keyboard shortcuts were unaffected (each instance handles its own
 * focus-scoped keydown and calls its own closures), so only the toolbar
 * buttons misfired — and only intermittently, depending on render order.
 *
 * The fix keys the handlers by the owning dockview's `api.id` (dockview
 * passes the owning `containerApi` into the header-action component), so a
 * click always routes to the workspace that owns the clicked group.
 *
 * Reproduction setup
 * ------------------
 * `MultiWorkspacePanelHost` renders its cached entries in Map INSERTION
 * order (`Array.from(cache.values())`). A full `goto(A)` resets the cache
 * to `{A}`; an in-app `switchWorkspace(B)` makes it `{A, B}`; switching
 * back in-app to A leaves the order `[A, B]` — so A is VISIBLE but B (now
 * hidden) is the LAST entry rendered each commit, i.e. the last writer the
 * buggy module-level singleton would capture. Clicking "+" in A then
 * created the panel in B on the broken code.
 *
 * Each test uses its OWN workspace pair (visible + cached). The toolbar
 * "+"/split path creates a chat panel with no server-side chat record, so
 * sharing a pair across tests would let one test's added panel be
 * orphan-pruned on the next test's restore — separate pairs keep each
 * test's baseline clean and the assertions deterministic.
 *
 * Architecture (same doctrine as the sibling specs)
 * -------------------------------------------------
 *   - Real production binary booted against a fresh tmp `~/.band/`.
 *   - No tRPC mocking; the dashboard renders against real procedures.
 *   - All UI driven through `WorkspacePage` (no raw `getByRole` / `goto`
 *     in the test body).
 *   - Assertions read the server-persisted inner layout via
 *     `chatLayout.get` / `terminalLayout.get` (`countChatPanels` /
 *     `countTerminalPanels`) so they observe WHICH workspace's dockview
 *     the click actually mutated — the exact bug surface — rather than
 *     something cosmetic.
 *
 * Chat vs terminal coverage
 * -------------------------
 * The terminal tests are the DETERMINISTIC regression catch: the buggy
 * terminal `RightHeaderActions` reads the module-level `addTabRef.current`
 * at CLICK time, so after the switch dance above it resolves the trailing
 * (hidden) workspace's handler every time — clicking the visible
 * workspace's "+"/split creates the terminal in the hidden workspace, and
 * these tests fail on the broken code. The chat `RightHeaderActions`
 * instead captured `addTabRef.current` at RENDER time, so the visible
 * workspace's chat header — mounted when its own workspace was the most
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
 * e2e harness to exercise at runtime; the `WorkspacePage` helpers already
 * accept `"browser"` (`countInnerPanels`) so that future harness can wire
 * it up without re-deriving the path.
 */

import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-panel-toolbar-target-token";

// One dedicated workspace pair per test (visible + cached), so no test's
// toolbar-added panel can leak into another's restore/prune path.
const ADD_VISIBLE = toWorkspaceId("alpha-add", "main");
const ADD_CACHED = toWorkspaceId("bravo-add", "main");
const SPLIT_VISIBLE = toWorkspaceId("alpha-split", "main");
const SPLIT_CACHED = toWorkspaceId("bravo-split", "main");
const TERM_ADD_VISIBLE = toWorkspaceId("alpha-term-add", "main");
const TERM_ADD_CACHED = toWorkspaceId("bravo-term-add", "main");
const TERM_SPLIT_VISIBLE = toWorkspaceId("alpha-term-split", "main");
const TERM_SPLIT_CACHED = toWorkspaceId("bravo-term-split", "main");

function project(name: string) {
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
    projects: [
      project("alpha-add"),
      project("bravo-add"),
      project("alpha-split"),
      project("bravo-split"),
      project("alpha-term-add"),
      project("bravo-term-add"),
      project("alpha-term-split"),
      project("bravo-term-split"),
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

/**
 * Mount BOTH workspaces (so both chat containers are live) with `visible`
 * shown and `cached` the trailing cache entry, then return a settled
 * baseline of each workspace's persisted chat panel count.
 *
 *   1. `goto(visible)` — full navigation, cache resets to `{visible}`.
 *   2. `switchWorkspace(cached)` — in-app nav, cache `{visible, cached}`,
 *      `cached` shown, `visible` hidden but still mounted.
 *   3. `switchWorkspace(visible)` — in-app nav, `visible` shown again;
 *      cache order stays `[visible, cached]`, so `cached` is the trailing
 *      (last-rendered) entry — the writer the buggy singleton would
 *      capture.
 *
 * Both chat containers seed a default tab on cold mount and debounce-save
 * it, so we poll until each side reports its baseline before acting.
 */
async function mountBothAndSettle(
  workspacePage: WorkspacePage,
  visible: string,
  cached: string,
): Promise<{ baseVisible: number; baseCached: number }> {
  await workspacePage.goto(visible);
  await workspacePage.waitForReady();
  // The default chat tab is visible — proves the chat container's onReady
  // ran (its layout will persist) before we move on.
  await expect(workspacePage.chatTabVisibilityMarker(visible, true)).toBeVisible();

  await workspacePage.switchWorkspace(cached);
  await workspacePage.waitForReady();
  // The cached workspace's chat container is now mounted and visible — its
  // onReady ran too, so it has a persisted baseline.
  await expect(workspacePage.chatTabVisibilityMarker(cached, true)).toBeVisible();

  await workspacePage.switchWorkspace(visible);
  await workspacePage.waitForReady();
  // `visible` is shown again; its chat "+" button is actionable. Positive
  // anchor that the visible toolbar we're about to click is the right one.
  await expect(workspacePage.chatAddTabButton(visible).first()).toBeVisible();

  // Settle both persisted baselines (each defaults to a single chat tab).
  // Two sequential polls so the actual counts surface in the Playwright
  // reporter on failure, then read the stabilised values once.
  await expect
    .poll(() => workspacePage.countChatPanels(visible), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(() => workspacePage.countChatPanels(cached), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1);

  const baseVisible = await workspacePage.countChatPanels(visible);
  const baseCached = await workspacePage.countChatPanels(cached);
  return { baseVisible, baseCached };
}

/**
 * Terminal counterpart of `mountBothAndSettle`. The inner terminal
 * container only mounts when the outer Terminal tab is active, so we
 * activate it on each workspace while it's shown — that also mounts the
 * cached workspace's terminal container (the last-writer the buggy
 * read-at-click handler resolves). On the final return to `visible` the
 * per-workspace active-view restore re-activates Terminal automatically
 * (it was the saved active view), so we don't re-click the tab — clicking
 * it again would re-render `visible`'s terminal container and reset the
 * module-level ref, masking the bug.
 */
async function mountBothTerminalsAndSettle(
  workspacePage: WorkspacePage,
  visible: string,
  cached: string,
): Promise<{ baseVisible: number; baseCached: number }> {
  await workspacePage.goto(visible);
  await workspacePage.waitForReady();
  await workspacePage.openTerminalTab();
  await expect(workspacePage.terminalTabVisibilityMarker(visible, true)).toBeVisible();

  await workspacePage.switchWorkspace(cached);
  await workspacePage.waitForReady();
  await workspacePage.openTerminalTab();
  await expect(workspacePage.terminalTabVisibilityMarker(cached, true)).toBeVisible();

  await workspacePage.switchWorkspace(visible);
  await workspacePage.waitForReady();
  // Terminal is restored as the visible workspace's active view; its "+"
  // button is actionable. Positive anchor for the click target.
  await expect(workspacePage.terminalAddTabButton(visible).first()).toBeVisible();

  // Two sequential polls so the actual counts surface in the Playwright
  // reporter on failure, then read the stabilised values once.
  await expect
    .poll(() => workspacePage.countTerminalPanels(visible), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(() => workspacePage.countTerminalPanels(cached), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1);

  const baseVisible = await workspacePage.countTerminalPanels(visible);
  const baseCached = await workspacePage.countTerminalPanels(cached);
  return { baseVisible, baseCached };
}

// TODO(#643 Phase 5): re-point to Cmd+D split / new toolbar. The whole premise
// (per-container inner-dockview add/split toolbars + a module-level singleton
// bug + server-side per-container layout counts) is gone: the unified center
// dockview has one `+` menu and split is keyboard-only, and layout persists to
// localStorage (band:dockview-layout-v8:<id>), not chatLayout/terminalLayout.
test.describe
  .skip("Inner-dockview toolbar targets the visible workspace", () => {
    test("clicking the chat '+' creates the tab in the VISIBLE workspace, not the cached one", async ({
      page,
    }) => {
      const workspacePage = new WorkspacePage(page, server.url, TOKEN);
      const { baseVisible, baseCached } = await mountBothAndSettle(
        workspacePage,
        ADD_VISIBLE,
        ADD_CACHED,
      );

      await workspacePage.clickChatAddTab(ADD_VISIBLE);

      // The visible workspace gained a chat panel...
      await expect
        .poll(() => workspacePage.countChatPanels(ADD_VISIBLE), { timeout: 10_000 })
        .toBe(baseVisible + 1);

      // ...and the hidden, cached workspace was NOT touched. On the buggy
      // module-level-singleton code the panel landed in the cached workspace
      // instead. Poll (not a bare read) so a debounce-delayed wrong-workspace
      // persist can't slip in after a stale baseline read and pass falsely.
      await expect
        .poll(() => workspacePage.countChatPanels(ADD_CACHED), { timeout: 3_000 })
        .toBe(baseCached);
    });

    test("clicking the chat 'Split right' splits in the VISIBLE workspace, not the cached one", async ({
      page,
    }) => {
      const workspacePage = new WorkspacePage(page, server.url, TOKEN);
      const { baseVisible, baseCached } = await mountBothAndSettle(
        workspacePage,
        SPLIT_VISIBLE,
        SPLIT_CACHED,
      );

      await workspacePage.clickChatSplitRight(SPLIT_VISIBLE);

      // Split adds a panel (in a new group) to the VISIBLE workspace...
      await expect
        .poll(() => workspacePage.countChatPanels(SPLIT_VISIBLE), { timeout: 10_000 })
        .toBe(baseVisible + 1);

      // ...and leaves the cached workspace untouched (poll to absorb a
      // debounce-delayed wrong-workspace persist — see the add-tab test).
      await expect
        .poll(() => workspacePage.countChatPanels(SPLIT_CACHED), { timeout: 3_000 })
        .toBe(baseCached);
    });

    test("clicking the terminal '+' creates the tab in the VISIBLE workspace, not the cached one", async ({
      page,
    }) => {
      const workspacePage = new WorkspacePage(page, server.url, TOKEN);
      const { baseVisible, baseCached } = await mountBothTerminalsAndSettle(
        workspacePage,
        TERM_ADD_VISIBLE,
        TERM_ADD_CACHED,
      );

      await workspacePage.clickTerminalAddTab(TERM_ADD_VISIBLE);

      // The visible workspace gained a terminal panel...
      await expect
        .poll(() => workspacePage.countTerminalPanels(TERM_ADD_VISIBLE), { timeout: 10_000 })
        .toBe(baseVisible + 1);

      // ...and the hidden, cached workspace was NOT touched. The buggy
      // module-level singleton resolved the cached workspace's handler at
      // click time, creating the terminal there — this assertion fails on
      // the broken code. Poll to absorb a debounce-delayed persist.
      await expect
        .poll(() => workspacePage.countTerminalPanels(TERM_ADD_CACHED), { timeout: 3_000 })
        .toBe(baseCached);
    });

    test("clicking the terminal 'Split right' splits in the VISIBLE workspace, not the cached one", async ({
      page,
    }) => {
      const workspacePage = new WorkspacePage(page, server.url, TOKEN);
      const { baseVisible, baseCached } = await mountBothTerminalsAndSettle(
        workspacePage,
        TERM_SPLIT_VISIBLE,
        TERM_SPLIT_CACHED,
      );

      await workspacePage.clickTerminalSplitRight(TERM_SPLIT_VISIBLE);

      // Split adds a panel (in a new group) to the VISIBLE workspace...
      await expect
        .poll(() => workspacePage.countTerminalPanels(TERM_SPLIT_VISIBLE), { timeout: 10_000 })
        .toBe(baseVisible + 1);

      // ...and leaves the cached workspace untouched (poll to absorb a
      // debounce-delayed wrong-workspace persist — see the add-tab test).
      await expect
        .poll(() => workspacePage.countTerminalPanels(TERM_SPLIT_CACHED), { timeout: 3_000 })
        .toBe(baseCached);
    });
  });
