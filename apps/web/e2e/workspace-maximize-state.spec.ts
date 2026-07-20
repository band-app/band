/**
 * End-to-end coverage for issue #490 — per-workspace maximize state
 * persists across workspace switches and dashboard reloads.
 *
 * Architecture:
 *
 *   - The real production binary runs against a fresh tmp `~/.band/`,
 *     not the user's home. Migrations apply against the throwaway
 *     SQLite DB on boot.
 *   - No tRPC mocking. The dashboard renders against the real backend
 *     serving real procedures. Two projects (with no real worktrees on
 *     disk) are seeded directly into the SQLite DB; background git
 *     calls fail gracefully but the dockview header still mounts and
 *     the maximize feature — which is purely client-side state in
 *     `localStorage` — works regardless.
 *   - All UI is driven through `WorkspacePage` (no raw `getByRole`,
 *     `getByTestId`, or `page.goto` in the test body).
 *
 * The five scenarios below map 1:1 to the issue's acceptance criteria
 * plus a regression test for the bug we surfaced during review (max
 * state preserved + non-maximized group's saved active view is
 * restored when the user later exits maximize).
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

const TOKEN = "e2e-workspace-maximize-state-token";

const PROJECT_A = "alpha-max";
const PROJECT_B = "bravo-max";
const WORKSPACE_A = toWorkspaceId(PROJECT_A, "main");
const WORKSPACE_B = toWorkspaceId(PROJECT_B, "main");

// Wide viewport so `useIsDesktop()` reports true and the shared
// dockview renders (matches >= 1024px in apps/web/src/hooks/useIsDesktop.ts).
// The dockview layout — and therefore the maximize button — only exists
// in the desktop layout.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT_A,
        path: `/tmp/fake/${PROJECT_A}`,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: `/tmp/fake/${PROJECT_A}` }],
      },
      {
        name: PROJECT_B,
        path: `/tmp/fake/${PROJECT_B}`,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: `/tmp/fake/${PROJECT_B}` }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

// Each test starts on a clean slate so it doesn't observe state another
// test wrote. `beforeEach` clears the per-workspace localStorage entries
// — the shared layout key is left alone so the default dockview
// structure (which the maximize feature reads on first load) is still
// seeded by the previous test's onReady. This matches the doctrine's
// "test independence" rule from §7 of the doctrine: each test gets a
// fresh page (Playwright default) and we clear the per-test surface we
// care about explicitly.
test.beforeEach(async ({ page }) => {
  // The page hasn't navigated yet so localStorage isn't accessible
  // until we go to ANY page in the origin. Land on the workspace URL
  // first, then clear and reload so the dockview reads the cleared
  // state on its onReady.
  await page.goto(`${server.url}/workspace/${encodeURIComponent(WORKSPACE_A)}?token=${TOKEN}`);
  await page.evaluate(
    ([keys]) => {
      for (const key of keys) {
        localStorage.removeItem(key);
      }
    },
    [[`band:dockview-active:${WORKSPACE_A}`, `band:dockview-active:${WORKSPACE_B}`]],
  );
});

// TODO(#643 Phase 5): re-point to Cmd+D split / new toolbar. The maximize
// BUTTON still works, but this spec asserts the removed per-workspace
// active-state persistence model (band:dockview-active:<id> with
// activeGroup/groups/maximizedGroup via readActiveState/readMaximizedGroup).
// The unified center dockview folds active/maximized state into the serialized
// dockview blob (band:dockview-layout-v8:<id>) with no maximizedGroup field.
test.describe
  .skip("Workspace maximize state (issue #490)", () => {
    test("AC1 + regression — maximizing in A, switching to B, and switching back to A restores A's maximize without contaminating B", async ({
      page,
    }) => {
      const workspacePage = new WorkspacePage(page, server.url, TOKEN);

      // Land on A and maximize the first panel.
      await workspacePage.goto(WORKSPACE_A);
      await workspacePage.waitForReady();
      await workspacePage.maximizePanel(0);

      // Positive anchor: the alternate state actually rendered (Restore
      // button visible) before we assert on the persisted bytes.
      await expect(workspacePage.restoreButton).toBeVisible();

      // Capture the group id A chose (whichever was at index 0 in the
      // default layout). It must match the persisted `maximizedGroup`.
      const aMaxGroup = await workspacePage.readMaximizedGroup(WORKSPACE_A);
      expect(aMaxGroup).toBeDefined();

      // Switch to B. B has never been maximized.
      await workspacePage.goto(WORKSPACE_B);
      await workspacePage.waitForReady();

      // B must NOT inherit A's maximize. The reviewer flagged this
      // contamination path explicitly during review of the first
      // implementation — see thread on `apps/web/src/components/SharedDockviewLayout.tsx:1500`.
      await expect(workspacePage.maximizeButtons.first()).toBeVisible();
      await expect(workspacePage.restoreButton).not.toBeVisible();
      expect(await workspacePage.readMaximizedGroup(WORKSPACE_B)).toBeUndefined();

      // A's persisted state is untouched by the B visit.
      expect(await workspacePage.readMaximizedGroup(WORKSPACE_A)).toBe(aMaxGroup);

      // Switch back to A — the maximize must be re-applied to the UI.
      await workspacePage.goto(WORKSPACE_A);
      await workspacePage.waitForReady();
      await expect(workspacePage.restoreButton).toBeVisible();
      expect(await workspacePage.readMaximizedGroup(WORKSPACE_A)).toBe(aMaxGroup);
    });

    test("AC2 — a maximized panel survives a full page reload", async ({ page }) => {
      const workspacePage = new WorkspacePage(page, server.url, TOKEN);

      await workspacePage.goto(WORKSPACE_A);
      await workspacePage.waitForReady();
      await workspacePage.maximizePanel(0);
      await expect(workspacePage.restoreButton).toBeVisible();
      const before = await workspacePage.readMaximizedGroup(WORKSPACE_A);
      expect(before).toBeDefined();

      await workspacePage.reload();
      await workspacePage.waitForReady();

      // Same button visible, same persisted value.
      await expect(workspacePage.restoreButton).toBeVisible();
      expect(await workspacePage.readMaximizedGroup(WORKSPACE_A)).toBe(before);
    });

    test("AC3 — unmaximizing also persists; switching away and back does not re-apply stale maximize", async ({
      page,
    }) => {
      const workspacePage = new WorkspacePage(page, server.url, TOKEN);

      // First maximize so there's a non-trivial state to clear.
      await workspacePage.goto(WORKSPACE_A);
      await workspacePage.waitForReady();
      await workspacePage.maximizePanel(0);
      await expect(workspacePage.restoreButton).toBeVisible();

      // Click Restore — the maximize must be cleared from localStorage too.
      await workspacePage.restorePanel();
      await expect(workspacePage.maximizeButtons.first()).toBeVisible();
      await expect(workspacePage.restoreButton).not.toBeVisible();
      expect(await workspacePage.readMaximizedGroup(WORKSPACE_A)).toBeUndefined();

      // Round-trip through B and back; A must still NOT show maximize.
      await workspacePage.goto(WORKSPACE_B);
      await workspacePage.waitForReady();
      await workspacePage.goto(WORKSPACE_A);
      await workspacePage.waitForReady();
      await expect(workspacePage.maximizeButtons.first()).toBeVisible();
      await expect(workspacePage.restoreButton).not.toBeVisible();
      expect(await workspacePage.readMaximizedGroup(WORKSPACE_A)).toBeUndefined();
    });

    test("AC4 — two workspaces retain different maximize state independently", async ({ page }) => {
      const workspacePage = new WorkspacePage(page, server.url, TOKEN);

      // Maximize the first group in A.
      await workspacePage.goto(WORKSPACE_A);
      await workspacePage.waitForReady();
      await workspacePage.maximizePanel(0);
      const aMaxGroup = await workspacePage.readMaximizedGroup(WORKSPACE_A);
      expect(aMaxGroup).toBeDefined();

      // Switch to B and maximize the SECOND group (different from A's).
      await workspacePage.goto(WORKSPACE_B);
      await workspacePage.waitForReady();
      // The default layout has two grid groups; index 0 was maximized in
      // A, so picking index 1 here gives B a different maximizedGroup.
      await workspacePage.maximizePanel(1);
      const bMaxGroup = await workspacePage.readMaximizedGroup(WORKSPACE_B);
      expect(bMaxGroup).toBeDefined();
      expect(bMaxGroup).not.toBe(aMaxGroup);

      // Both persist independently — neither workspace's state was
      // overwritten by the other.
      expect(await workspacePage.readMaximizedGroup(WORKSPACE_A)).toBe(aMaxGroup);
      expect(await workspacePage.readMaximizedGroup(WORKSPACE_B)).toBe(bMaxGroup);

      // And both restore correctly on revisit.
      await workspacePage.goto(WORKSPACE_A);
      await workspacePage.waitForReady();
      expect(await workspacePage.readMaximizedGroup(WORKSPACE_A)).toBe(aMaxGroup);
      await workspacePage.goto(WORKSPACE_B);
      await workspacePage.waitForReady();
      expect(await workspacePage.readMaximizedGroup(WORKSPACE_B)).toBe(bMaxGroup);
    });

    test("regression — non-maximized group's saved active view is restored on workspace switch", async ({
      page,
    }) => {
      // History: this test went through three failure modes in CI before
      // landing on the current shape.
      //
      //   1. The original positive assertion waited on
      //      `workspacePage.terminalInput` being visible after un-maximize.
      //      That transitively required the entire terminal pipeline
      //      (panel activate → React render → xterm init → helper textbox
      //      emit) to settle and drifted past four successive timeout
      //      budgets (15 s → 25 s → 45 s → 75 s) under 2-worker CI
      //      contention.
      //   2. The next iteration switched the positive to dockview's own
      //      `.dv-active-tab` class on the outer Terminal tab — synchronous
      //      with `setActive` and free of xterm-boot timing — but the
      //      SETUP still wrote A's active state directly to `localStorage`
      //      between maximize and the next navigation. That write raced
      //      with a `saveLayout` triggered by a delayed `onDidLayoutChange`
      //      after the maximize click: roughly 1 in 10 CI runs, the
      //      `saveLayout` fired AFTER the test's write and clobbered
      //      `g2=terminal` back to `g2=changes` (the live activeView).
      //      Reproduced locally at `--workers=2 --repeat-each=10`.
      //   3. The current shape drives the setup through the UI: click the
      //      Terminal tab BEFORE maximizing so the live dockview state
      //      has `g2=terminal`. Now any `saveLayout` fires after the click
      //      capture the same value the test expects, so the race window
      //      collapses — there's no test write that could be overwritten.
      //
      // This test guards the second bug the reviewer surfaced on PR #491
      // (`SharedDockviewLayout.tsx:1473`): an earlier fix attempt skipped
      // `setActive` on hidden groups to avoid exiting maximize as a side
      // effect, which then silently dropped the saved active-view for
      // those hidden groups. When the user later exited maximize, the
      // hidden group would show whatever tab the PREVIOUS workspace last
      // left there.
      //
      // Setup:
      //   - A has terminal as the active view in the second group (set
      //     by clicking the outer Terminal tab), then maximize on the
      //     first group.
      //   - Visit B (default layout has changes in g2, so the live
      //     dockview's g2 active view is "changes" while B is mounted).
      //   - Return to A → exit max.
      //
      // Expectation: in A after exit-max, the second group's active view
      // is "terminal" again (A's saved value), not "changes" (B's last
      // active that the live dockview was previously showing).

      const workspacePage = new WorkspacePage(page, server.url, TOKEN);

      // First trip to A: take the default layout and click the outer
      // Terminal tab BEFORE maximizing. Doing it this order means the
      // live dockview's g2 active view is `terminal` when the maximize
      // fires, so the subsequent `saveLayout` captures `terminal` — no
      // direct localStorage write that could race with a delayed save.
      await workspacePage.goto(WORKSPACE_A);
      await workspacePage.waitForReady();
      await workspacePage.tab("terminal").click();
      await workspacePage.maximizePanel(0);
      await expect(workspacePage.restoreButton).toBeVisible();

      // Wait for the saveLayout that fires after maximize to settle on
      // the expected shape: groups populated, terminal as g2's active
      // view, and a maximizedGroup. `expect.poll` retries the read so a
      // late save doesn't race with our subsequent reads.
      await expect
        .poll(
          async () => {
            const state = await workspacePage.readActiveState(WORKSPACE_A);
            if (!state || !state.maximizedGroup) return null;
            const groupIds = Object.keys(state.groups);
            if (groupIds.length < 2) return null;
            const hiddenId = groupIds.find((id) => id !== state.maximizedGroup);
            if (!hiddenId) return null;
            return state.groups[hiddenId] === "terminal" ? hiddenId : null;
          },
          { timeout: 5000 },
        )
        .toBeTruthy();

      // Read the stable state and pull out group ids. We can't hard-code
      // "1" / "2" because dockview assigns ids when the layout is built
      // and the order can shift if the default panel set changes.
      const aStateAfterMax = await workspacePage.readActiveState(WORKSPACE_A);
      expect(aStateAfterMax).toBeDefined();
      const maxedGroupId = aStateAfterMax!.maximizedGroup as string;
      const hiddenGroupId = Object.keys(aStateAfterMax!.groups).find(
        (id) => id !== maxedGroupId,
      ) as string;
      expect(aStateAfterMax!.groups[hiddenGroupId]).toBe("terminal");

      // Visit B (with its own default layout where changes is active in
      // g2). The hard navigation pumps the dockview's live state to
      // "changes in g2", which is exactly the contaminated state we need
      // the return-to-A overlay to override.
      await workspacePage.goto(WORKSPACE_B);
      await workspacePage.waitForReady();

      // Back to A — the layout overlay must restore terminal as the
      // active view in the hidden group, even though the user can't see
      // it yet (it's behind the maximize).
      await workspacePage.goto(WORKSPACE_A);
      await workspacePage.waitForReady();
      await expect(workspacePage.restoreButton).toBeVisible(); // maxed

      // Exit max — the hidden group becomes visible. The active view
      // should be "terminal" (A's saved value), not "changes" (B's last
      // active that the live dockview was previously showing).
      await workspacePage.restorePanel();
      await expect(workspacePage.maximizeButtons.first()).toBeVisible();

      // Two-phase assertion. Phase 1 is the fast negative regression
      // check — if the wrong tab (Changes) leaked across the workspace
      // switch, its "Files changed" heading renders quickly and fails
      // the test deterministically. Phase 2 is the positive: the outer
      // Terminal tab carries dockview's `.dv-active-tab` class. That
      // class is added synchronously by dockview as soon as `setActive`
      // runs on the panel, so it's the cheapest reliable proof that A's
      // saved active view ("terminal") was restored on the hidden group
      // — without depending on xterm's downstream boot timing.
      await expect(workspacePage.changesHeading).not.toBeVisible();
      // Generous timeout (vs. the 5 s default): the `.dv-active-tab` class
      // is applied synchronously by dockview the moment the workspace-switch
      // effect's `setActive("terminal")` runs, but that effect can be
      // scheduler-starved under 2-worker CI contention — the B→A navigation,
      // its `setActive` pass, and the exit-maximize all queue behind other
      // workers' work. 15 s absorbs that variance without reintroducing a
      // dependency on xterm's (much slower) boot pipeline.
      await expect(workspacePage.tabContainer("terminal")).toHaveClass(/\bdv-active-tab\b/, {
        timeout: 15_000,
      });
    });
  });
