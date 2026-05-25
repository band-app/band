/**
 * End-to-end coverage for issue #490 — per-workspace maximize state
 * persists across workspace switches and dashboard reloads.
 *
 * Architecture (per `docs/frontend-testing.md` + the
 * `write-integration-test` skill):
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

import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import {
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
  rmSync(tmpHome, { recursive: true, force: true });
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

test.describe("Workspace maximize state (issue #490)", () => {
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
    // This guards the second bug the reviewer surfaced on this PR
    // (`SharedDockviewLayout.tsx:1473`): an earlier fix attempt
    // skipped `setActive` on hidden groups to avoid exiting maximize
    // as a side effect, which then silently dropped the saved
    // active-view for those hidden groups. When the user later exited
    // maximize, the hidden group would show whatever tab the PREVIOUS
    // workspace last left there.
    //
    // Setup:
    //   - A has max on the first group, and a non-default active view
    //     ("terminal") on the second group.
    //   - B has a different active view ("changes") on the second
    //     group, no max.
    //   - Visit A → visit B (which sets g2's active to "changes" in
    //     the live dockview) → return to A → exit max.
    //
    // Expectation: in A after exit-max, the second group's active
    // view is "terminal" again (A's saved value), not "changes" (B's
    // last-active leakage).

    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    // First trip to A: take the default layout, then maximize so the
    // saved state has a `maximizedGroup`. Wait for it to persist.
    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();
    await workspacePage.maximizePanel(0);
    await expect(workspacePage.restoreButton).toBeVisible();

    // Pull the actual group ids out of the persisted layout. We can't
    // hard-code "1" / "2" because dockview assigns ids when the layout
    // is built, and the order can shift if the default panel set
    // changes. The first group's id is the maximizedGroup; the other
    // is whichever group's id appears in `groups` and ISN'T the max.
    const aStateAfterMax = await workspacePage.readActiveState(WORKSPACE_A);
    expect(aStateAfterMax).toBeDefined();
    expect(aStateAfterMax?.maximizedGroup).toBeDefined();
    const groupIds = Object.keys(aStateAfterMax?.groups ?? {});
    const maxedGroupId = aStateAfterMax?.maximizedGroup as string;
    const hiddenGroupId = groupIds.find((id) => id !== maxedGroupId);
    expect(hiddenGroupId).toBeDefined();

    // Seed A with a specific active view on the HIDDEN group so we
    // have something distinctive to assert on later. Use a panel id
    // that we know is part of the default layout but ISN'T the
    // default active view of its group (so the assertion is
    // observable). "terminal" sits in g2's tab group alongside
    // "changes" / "files" / "browser" but isn't the activeView by
    // default.
    await workspacePage.writeActiveState(WORKSPACE_A, {
      ...aStateAfterMax!,
      groups: {
        ...aStateAfterMax!.groups,
        [hiddenGroupId as string]: "terminal",
      },
    });

    // Visit B with a DIFFERENT activeView on the same hidden group,
    // then come back to A.
    await workspacePage.goto(WORKSPACE_B);
    await workspacePage.waitForReady();
    await workspacePage.writeActiveState(WORKSPACE_B, {
      groups: { [hiddenGroupId as string]: "changes" },
      activeGroup: hiddenGroupId as string,
    });
    // Re-navigate to B so the workspace-switch effect applies the
    // newly-written state to the live dockview.
    await workspacePage.goto(WORKSPACE_B);
    await workspacePage.waitForReady();

    // Back to A — the workspace-switch effect must restore terminal as
    // the active view in the hidden group, even though the user can't
    // see it yet (it's behind the maximize).
    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();
    await expect(workspacePage.restoreButton).toBeVisible(); // maxed

    // Exit max — the hidden group becomes visible. The active view
    // should be "terminal" (A's saved value), not "changes" (B's last
    // active that the live dockview was previously showing).
    await workspacePage.restorePanel();
    await expect(workspacePage.maximizeButtons.first()).toBeVisible();

    // The Terminal panel exposes a Terminal input textbox when it's
    // the active tab in its group; the Changes panel exposes a
    // "Files changed" heading. Asserting on the live DOM is the
    // cleanest end-to-end proof that the right tab is showing.
    await expect(workspacePage.terminalInput).toBeVisible();
  });
});
