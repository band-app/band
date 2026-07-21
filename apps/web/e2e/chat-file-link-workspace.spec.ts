/**
 * Regression coverage for issue #539 —
 * `band:open-file` events dispatched from a chat-message file link must
 * be scoped to the workspace whose chat fired the click, so a click in
 * workspace A's chat cannot open a file against the (different) active
 * workspace B.
 *
 * Pre-fix, `dispatchOpenFile` in `file-link-components.tsx` carried only
 * `{ filename }`. The single window-event listener in
 * `SharedDockviewLayout.tsx` was bound to the currently-active workspace,
 * so any chat-link click anywhere in the tree (A's chat or B's chat or
 * any LRU-cached workspace's chat) opened the file against whichever
 * workspace happened to be focused — typically NOT the intended one —
 * and the QuickOpenDialog's auto-open path persisted a bogus tab into
 * `band-open-tabs:<active-workspace>`. The fix:
 *
 *   1. `FileLinkWorkspaceProvider` wraps every ChatView's message tree
 *      so `dispatchOpenFile` reads the *owning* workspace id at click
 *      time and attaches it to the event detail.
 *   2. The two `band:open-file` listeners
 *      (`SharedDockviewLayout`, `workspace.$workspaceId.tsx`) filter on
 *      `detail.workspaceId`: ignore the event unless it's addressed to
 *      this listener's workspace.
 *   3. `QuickOpenDialog`'s auto-open captures the workspace id at
 *      open-time and bails if the prop has flipped by the time the
 *      search resolves — belt-and-braces for the in-flight workspace
 *      switch race.
 *
 * Test architecture:
 *
 *   - Boots the real production server against a fresh tmp home.
 *   - Two real git worktrees so the file-search procedure has
 *     something to walk for the QuickOpenDialog's auto-open path.
 *   - No tRPC mocking, no MSW, no page.route() interception of own
 *     routes — external services would be stubbed via Express on a
 *     random port, but this spec drives DOM events directly via
 *     `workspacePage.dispatchOpenFileEvent(...)` so no stub is needed.
 *
 * The dispatcher half of the fix (the React context + useContext read
 * in `FileLinkedAnchor`) is intentionally not driven from this spec —
 * there is currently no unit-test surface for the React click→dispatch
 * chain. A follow-up could render a real chat message containing a
 * `band-file:` link, click it, and assert the dispatched event's
 * `detail.workspaceId` matches the chat's owning workspace; that would
 * close the dispatcher-side coverage gap.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { gitInHome as git } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-chat-file-link-workspace-token";

const PROJECT = "chat-file-link-repo";
const DEFAULT_BRANCH = "main";
const BRANCH_A = "feature-a";
const BRANCH_B = "feature-b";

const WORKSPACE_A = toWorkspaceId(PROJECT, BRANCH_A);
const WORKSPACE_B = toWorkspaceId(PROJECT, BRANCH_B);

// Wide viewport so `useIsDesktop()` reports true and the shared dockview
// renders. The bug only manifests in the desktop layout where multiple
// workspaces can be alive at once under `MultiWorkspacePanelHost`'s LRU
// cache. The mobile layout mounts one workspace at a time, so there's no
// cross-workspace event leak to guard against there in the same way.
test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome: string | undefined;

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  // Real git repo with two worktrees. Each worktree has a distinctly
  // named file so a `searchWorkspaceFiles("only-in-a.ts")` invocation
  // returns exactly one match in A and zero in B — and vice versa.
  // Without the fix, dispatching `band:open-file` for
  // "only-in-a.ts" while B is active would land the file as a tab in
  // B (where it doesn't exist) and the FileViewer would surface ENOENT.
  const repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", DEFAULT_BRANCH], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# Chat file link test\n");
  git(repoPath, ["add", "."], tmpHome);
  git(repoPath, ["commit", "-m", "initial commit"], tmpHome);

  const worktreeAPath = join(tmpHome, `${PROJECT}-${BRANCH_A}`);
  const worktreeBPath = join(tmpHome, `${PROJECT}-${BRANCH_B}`);
  git(repoPath, ["worktree", "add", "-b", BRANCH_A, worktreeAPath], tmpHome);
  git(repoPath, ["worktree", "add", "-b", BRANCH_B, worktreeBPath], tmpHome);

  // Workspace-distinct files. The names are chosen so a file in A's
  // search index never matches a file in B's, so the auto-open
  // single-match shortcut cleanly routes through the new
  // workspace-scoped event detail.
  writeFileSync(join(worktreeAPath, "only-in-a.ts"), "// only in workspace A\n");
  writeFileSync(join(worktreeBPath, "only-in-b.ts"), "// only in workspace B\n");
  // Same path in BOTH workspaces — used by the in-flight workspace
  // switch race test. The single-match auto-open shortcut resolves
  // in both A and B, so the test can rely on "switching workspaces
  // mid-search would land the file in the WRONG workspace" as the
  // baseline bug behaviour the openedWorkspaceIdRef bail guards
  // against.
  writeFileSync(join(worktreeAPath, "shared.ts"), "// shared name, different file in A\n");
  writeFileSync(join(worktreeBPath, "shared.ts"), "// shared name, different file in B\n");

  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: repoPath,
        defaultBranch: DEFAULT_BRANCH,
        worktrees: [
          { branch: DEFAULT_BRANCH, path: repoPath },
          { branch: BRANCH_A, path: worktreeAPath },
          { branch: BRANCH_B, path: worktreeBPath },
        ],
      },
    ],
  });
  // Pin `maxCachedWorkspaces` to 3 — same as the cache-eviction spec —
  // so neither A nor B is LRU-evicted at the assertion point. The bug
  // only manifests when BOTH workspace trees are alive simultaneously
  // and the event listener has to decide which one to route to.
  seedSettings(tmpHome, { tokenSecret: TOKEN, maxCachedWorkspaces: 3 });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (server) await server.close();
  // `tmpHome` may be `undefined` if `beforeAll` threw before
  // `createTmpHome()` resolved — guard so the cleanup path is a
  // no-op rather than calling `rmSync(undefined)`.
  if (tmpHome) cleanupTmpHome(tmpHome);
});

// TODO(#643 Phase 5): file explorer moved to right sidepanel — this spec
// asserts the old `useFileTabs` / per-workspace `openTabs` self-heal that the
// desktop CodeBrowserView flow owned. That flow was removed in Phase 2 (files
// now open as bare per-path leaves with no `openTabs` persistence), so the
// behaviour under test no longer exists. Re-enable when the file-tab model is
// reworked.
test.describe("chat file-link workspace scoping (issue #539)", () => {
  // NOTE: the original "event addressed to an inactive workspace is
  // ignored" test (which dispatched `{ filename: "only-in-a.ts",
  // workspaceId: A }` while B was active and asserted dialog
  // visibility) was deleted as redundant — the cross-workspace
  // tab-leak test below covers the same listener-filter contract
  // with a stronger, persistent-state assertion that actually
  // distinguishes bug code from fix code. The visibility-snapshot
  // approach happened to pass on bug code because `only-in-a.ts`
  // doesn't exist in B's index, so B's auto-open shortcut took the
  // 0-result branch and never leaked anything observable through the
  // dialog's `open` state.

  test("event with no workspaceId in its detail falls through to the active workspace (backwards-compat)", async ({
    page: _page,
  }) => {
    const workspacePage = new WorkspacePage(_page, server.url, TOKEN);

    await workspacePage.goto(WORKSPACE_B);
    await workspacePage.waitForReady();
    await expect(workspacePage.cachedPanelEntries(WORKSPACE_B).first()).toBeVisible();

    // Contract: dispatching without `workspaceId` must open the
    // dialog. The 0-result filename forces the auto-open shortcut
    // into its reveal branch so the assertion has something to wait
    // on.
    await workspacePage.dispatchOpenFileEvent({
      filename: "does-not-resolve-anywhere-67890.ts",
    });

    await expect(workspacePage.quickOpenDialog()).toBeVisible();
  });

  test("persisted active tab pointing at a non-existent path self-heals on mount (ENOENT defensive)", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    // Seed a restored center layout that holds a REAL file leaf (only-in-a.ts,
    // which exists in A's worktree) plus a STALE one whose path doesn't exist
    // on disk — mimicking a path persisted by an older build or left behind by
    // a file that was since deleted/relocated. Seeding happens before the
    // first mount (addInitScript), so the file leaves restore on the initial
    // render and each FileViewer immediately tries to load its path.
    const STALE_PATH = "path/from/another/workspace/that-does-not-exist.ts";
    const REAL_PATH = "only-in-a.ts";
    await workspacePage.seedFileLeaves(WORKSPACE_A, [REAL_PATH, STALE_PATH], STALE_PATH);

    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();

    // Positive anchor: the seed took and restored — the real file leaf is
    // present. Without this, the negative self-heal assertion could pass
    // trivially on a build where the layout never restored at all.
    await expect
      .poll(async () => (await workspacePage.readOpenTabsState(WORKSPACE_A))?.tabs ?? [], {
        timeout: 15_000,
      })
      .toContain(REAL_PATH);

    // The stale leaf self-heals: its FileViewer hits ENOENT, the leaf's
    // `onLoadError` drops the tab, and the layout persists without it. 5 s is
    // well beyond the actual round-trip (a load failure surfaces in tens of ms
    // on a tiny worktree) but bounded so a regression trips deterministically.
    await expect
      .poll(async () => (await workspacePage.readOpenTabsState(WORKSPACE_A))?.tabs ?? [], {
        timeout: 5000,
      })
      .not.toContain(STALE_PATH);
  });

  // The `QuickOpenDialog.openedWorkspaceIdRef` bail (defence layer 3
  // in the issue #539 fix) has an exercise path that resists
  // black-box integration testing: it only fires when the workspace
  // flips BEFORE the dialog's first `searchWorkspaceFiles` resolves,
  // which on a tiny test fixture happens within the first few
  // milliseconds — faster than Playwright's await granularity can
  // reliably interleave. A test that dispatches the event then
  // immediately clicks the workspace card passes both with and
  // without the bail because by the time the click commits, the
  // search has already resolved and `autoOpened.current` is true, so
  // the bail check is never reached. The correctness of the ref
  // isolation (only capture on `open: false → true`, never on
  // mid-flight `workspaceId` changes) is documented inline at the
  // capture-effect site and exercised by the `shouldBailAutoOpen`
  // pure-helper unit suite.

  test("cross-workspace event with a matching filename does NOT leak the file into the wrong workspace's persisted tab list", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    // Both worktrees have a file at `shared.ts`. Without the fix, the
    // SharedDockviewLayout listener would catch a workspace-agnostic
    // `band:open-file` event addressed to A while B is active, route
    // it through QuickOpenDialog.autoOpen, find `shared.ts` in B's
    // index, and write the path into `band-open-tabs:<B>` — the
    // exact symptom in the issue #539 description ("workspace B's
    // Files panel tries to open the same workspace-relative path
    // against B's root"). With the fix, the listener filters on
    // `detail.workspaceId` and silently drops the cross-workspace
    // event before the dialog can open.
    //
    // Verified against origin/main (the bug code): without the fix,
    // after dispatching `{ filename: "shared.ts", workspaceId: A }`
    // while B is active and waiting ~2 s for the full debounce +
    // search + autoOpen + persist effect, B's tab list reads
    // `{"tabs":["shared.ts"],"active":"shared.ts"}`. The fix code
    // leaves B's tab list empty.
    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();
    await expect(workspacePage.workspaceCard(WORKSPACE_B)).toBeVisible();
    await workspacePage.switchWorkspace(WORKSPACE_B);
    await expect(workspacePage.cachedPanelEntries(WORKSPACE_B).first()).toBeVisible();
    expect(await workspacePage.cachedPanelEntries(WORKSPACE_A).count()).toBeGreaterThan(0);
    expect(await workspacePage.cachedPanelEntries(WORKSPACE_B).count()).toBeGreaterThan(0);

    await workspacePage.writeOpenTabsState(WORKSPACE_B, { tabs: [], active: null });

    await workspacePage.dispatchOpenFileEvent({
      filename: "shared.ts",
      workspaceId: WORKSPACE_A,
    });

    // Positive-shaped poll for the leak's APPEARANCE within a
    // bounded window, then assert the poll exhausted its budget
    // without finding it. `expect.poll(state).not.toContain(...)`
    // would succeed trivially at t=0 because the seed above leaves
    // B's tab list empty — the poll returns success before the
    // bug's full lifecycle (150 ms debounce + search + autoOpen +
    // per-workspace-state propagation + CodeBrowserView
    // openTabPinned + useFileTabs persist) has had time to write
    // the leak (~200-300 ms post-dispatch). The
    // poll-for-appearance shape catches the regression by FAILING
    // fast when the leak arrives; the try/catch converts
    // "timed out without finding the leak" into "test passed".
    let leaked = false;
    try {
      await expect
        .poll(
          async () => {
            const state = await workspacePage.readOpenTabsState(WORKSPACE_B);
            return state?.tabs ?? [];
          },
          { timeout: 2000 },
        )
        .toContain("shared.ts");
      leaked = true;
    } catch {
      // poll exhausted budget without observing shared.ts land in
      // B's tab list — exactly the contract we want to confirm.
    }
    expect(leaked).toBe(false);
  });
});
