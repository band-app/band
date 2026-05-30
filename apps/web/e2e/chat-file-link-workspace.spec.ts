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

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

function makeGitEnv(home: string): NodeJS.ProcessEnv {
  // Hermetic git environment — mirrors `workspace-cache-eviction.spec.ts`.
  // `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` pointed at /dev/null block
  // host config from leaking into commits, which is what makes the
  // initial-commit hash reproducible across runs.
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@test.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

function git(cwd: string, args: string[], home: string): void {
  execFileSync("git", args, { cwd, env: makeGitEnv(home) });
}

let server!: ServerHandle;
let tmpHome: string;

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
  cleanupTmpHome(tmpHome);
});

test.describe("chat file-link workspace scoping (issue #539)", () => {
  test("event addressed to an inactive workspace is ignored — no Quick Open dialog leaks into the active workspace", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    // Land on workspace A first, then switch to B via the sidebar so
    // both workspaces stay in `MultiWorkspacePanelHost`'s LRU cache.
    // The bug only manifests with two cached workspaces — a full
    // navigation to B would wipe A's panel state and there'd be no
    // chat-pane to "leak from" in the original repro.
    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();
    await expect(workspacePage.workspaceCard(WORKSPACE_B)).toBeVisible();
    await expect(workspacePage.cachedPanelEntries(WORKSPACE_A).first()).toBeVisible();

    await workspacePage.switchWorkspace(WORKSPACE_B);
    await expect(workspacePage.cachedPanelEntries(WORKSPACE_B).first()).toBeVisible();
    // Sanity: both workspaces are alive at this point. If a future
    // change to the LRU cache evicts A here, the test loses its
    // ability to model the cross-workspace dispatch and silently
    // passes — pin both as alive before going further.
    expect(await workspacePage.cachedPanelEntries(WORKSPACE_A).count()).toBeGreaterThan(0);
    expect(await workspacePage.cachedPanelEntries(WORKSPACE_B).count()).toBeGreaterThan(0);

    // Active workspace is B. Dispatch a `band:open-file` event
    // addressed to A — pre-fix, the SharedDockviewLayout listener
    // would catch it (no workspace filter) and pop the Quick Open
    // dialog against B. Post-fix, the listener filters by
    // `detail.workspaceId` and the event is silently ignored.
    //
    // We bracket the cross-workspace dispatch with a probe addressed
    // to the ACTIVE workspace (B). Window CustomEvent dispatches are
    // synchronous and listeners run in registration order, so by the
    // time the probe's `toBeVisible()` resolves we know the
    // cross-workspace event has already been processed — no
    // `waitForTimeout` needed. This converts the "no side effect"
    // assertion into a deterministic ordering check: if the
    // cross-workspace event had wrongly opened the dialog, the
    // dialog would already be visible BEFORE we dispatch the probe,
    // and the post-close `toBeHidden` assertion below would have
    // nothing to wait on (because the cross-workspace open would
    // race with the probe close).
    await workspacePage.dispatchOpenFileEvent({
      filename: "only-in-a.ts",
      workspaceId: WORKSPACE_A,
    });

    // Probe addressed to B with a deliberately-missing filename.
    // The 0-result auto-open branch reveals the dialog (the shortcut
    // only hides it on a single match), giving us a deterministic
    // positive event to await. Once the probe resolves, every
    // previous event has been processed.
    await workspacePage.dispatchOpenFileEvent({
      filename: "does-not-resolve-anywhere-12345.ts",
      workspaceId: WORKSPACE_B,
    });
    await expect(workspacePage.quickOpenDialog()).toBeVisible();

    // Close the probe dialog so the next assertion observes a clean
    // baseline. Escape is the user-facing close path the Dialog wires
    // up by default.
    await page.keyboard.press("Escape");
    await expect(workspacePage.quickOpenDialog()).toBeHidden();

    // Tighten the second negative check with an inline positive
    // companion: dispatch the cross-workspace event FIRST (which must
    // be silently dropped), then a probe event addressed to the
    // active workspace. Because window CustomEvent dispatches and
    // their listeners run synchronously in registration order, the
    // probe's `toBeVisible()` is the deterministic anchor: by the
    // time it resolves, the cross-workspace event has already been
    // through its listener. A regression where the listener no
    // longer filtered would have opened the dialog from the
    // cross-workspace event itself, and the probe's visibility
    // assertion would then be unable to distinguish "probe opened
    // it" from "cross-workspace leaked it". The
    // `quickOpenDialog().isVisible() === false` snapshot taken
    // immediately AFTER the cross-workspace dispatch (before the
    // probe) is the assertion that pins the listener-filter
    // contract.
    await workspacePage.dispatchOpenFileEvent({
      filename: "only-in-a.ts",
      workspaceId: WORKSPACE_A,
    });
    expect(await workspacePage.quickOpenDialog().isVisible()).toBe(false);

    await workspacePage.dispatchOpenFileEvent({
      filename: "another-missing-file-anchor-99999.ts",
      workspaceId: WORKSPACE_B,
    });
    await expect(workspacePage.quickOpenDialog()).toBeVisible();
  });

  test("event with no workspaceId in its detail falls through to the active workspace (backwards-compat)", async ({
    page: _page,
  }) => {
    const workspacePage = new WorkspacePage(_page, server.url, TOKEN);

    // Land directly on B — we don't need A alive for this assertion;
    // we only need the active workspace's listener to honour a
    // detail-less event (the legacy / non-chat dispatcher shape that
    // pre-dates the workspace-scoping fix).
    await workspacePage.goto(WORKSPACE_B);
    await workspacePage.waitForReady();
    await expect(workspacePage.cachedPanelEntries(WORKSPACE_B).first()).toBeVisible();

    // Dispatch without `workspaceId`. The listener must fall through
    // to the active workspace (B) so any future non-chat caller —
    // command palette item, CLI bridge, etc. — keeps working without
    // needing to know the workspace id. The 0-result auto-open path
    // again reveals the dialog as proof.
    await workspacePage.dispatchOpenFileEvent({
      filename: "does-not-resolve-anywhere-67890.ts",
    });

    await expect(workspacePage.quickOpenDialog()).toBeVisible();
  });

  test("persisted active tab pointing at a non-existent path self-heals on mount (ENOENT defensive)", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    // Two-step seeding: navigate once so localStorage is accessible on
    // the same origin, write the stale tab, then navigate again so the
    // workspace remounts and CodeBrowserView reads the just-seeded
    // state on its initial render. The stale path mimics what older
    // builds (pre-#539 fix) could leak into `band-open-tabs:<ws>` —
    // a workspace-relative path from a DIFFERENT workspace that
    // doesn't exist on disk in this one. The third fix in #539 is
    // defensive: even with the dispatcher + listener-filter fixes,
    // anything already persisted from older builds self-heals on the
    // next mount rather than leaving a broken tab pinned forever.
    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();

    const STALE_PATH = "path/from/another/workspace/that-does-not-exist.ts";
    await workspacePage.writeOpenTabsState(WORKSPACE_A, {
      tabs: [STALE_PATH],
      active: STALE_PATH,
    });

    // Reload so CodeBrowserView re-mounts with the seeded localStorage
    // entry as its initial state. `viewFilePath` is derived from
    // `fileTabs.activeTabPath ?? ""` at mount time (see
    // `apps/web/src/components/CodeBrowserView.tsx` line 457-462),
    // which immediately drives the FileViewer to attempt loading the
    // stale path against workspace A's worktree root.
    await workspacePage.reload();
    await workspacePage.waitForReady();
    // Click into the Files tab so the FileViewer panel actually mounts
    // and the load effect fires. The dockview keeps panel content
    // cached but a panel that's never been activated may defer its
    // first mount. Using the system-controlled `data-testid` set in
    // `SharedDockviewLayout`'s DefaultTab — see WorkspacePage.tab().
    await workspacePage.tab("files").click();

    // The self-heal should drop the stale tab from the persisted state.
    // `expect.poll` retries until the FileViewer's catch branch fires,
    // CodeBrowserView's `handleFileLoadError` calls `handleTabClose`,
    // the openTabs state updates, and the persist effect in
    // `useFileTabs` writes the new state to localStorage. 5 s is well
    // beyond the actual round-trip (load failure surfaces in tens of
    // ms on a tiny worktree) but bounded so a regression that fails
    // to self-heal trips deterministically.
    await expect
      .poll(
        async () => {
          const state = await workspacePage.readOpenTabsState(WORKSPACE_A);
          return state?.tabs ?? null;
        },
        { timeout: 5000 },
      )
      .not.toContain(STALE_PATH);

    // Counter-anchor: a freshly-explicit user-driven tab (one the user
    // navigated to themselves, not restored from persistence) is not
    // covered by the `initialRestoredTabRef` guard, so any future
    // load failure on it must NOT auto-close. We don't drive that
    // scenario here (it'd require simulating a transient server
    // failure, out of scope), but the negative claim is anchored in
    // the code comment at `CodeBrowserView.tsx` ~line 1108-1133.
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
  // mid-flight `workspaceId` changes) is documented in
  // `QuickOpenDialog.tsx` and was verified by code review on PR #545.
});
