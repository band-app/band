/**
 * Regression coverage for issue #508 —
 * `MultiWorkspacePanelHost`'s LRU cache evicts a workspace as soon as
 * that workspace disappears from the projects query, not only when a
 * NEW workspace overflows the capacity-bound.
 *
 * Doctrine (`CLAUDE.md` "Testing Strategy" + the `write-integration-test`
 * skill at `.claude/skills/write-integration-test/SKILL.md`):
 *
 *   - The same production binary the user ships runs inside the test
 *     against a fresh tmp `~/.band/`. Migrations apply to the throwaway
 *     SQLite DB on boot.
 *   - The deletion is driven through the dashboard sidebar's
 *     `WorkspaceCard` context menu — the same flow the user takes — so
 *     the real `useRemoveWorkspace` mutation runs, the real projects
 *     query invalidates, and the real reconcile-against-projects effect
 *     inside `MultiWorkspacePanelHost` fires.
 *   - No tRPC mocking, no `page.route()` on our own routes, no MSW.
 *
 * The cache itself is internal React state — the test asserts on its
 * SHAPE through a public DOM surface: `MultiWorkspacePanelHost` renders
 * one `<div data-testid="workspace-panel-host__cached-entry--<id>">`
 * per workspace it currently caches (multiple, one per panel host,
 * because the layout mounts five hosts: chat / changes / files /
 * terminal / browser). The test counts entries with `count() === 0`
 * to confirm the deleted workspace was fully evicted across every
 * panel host.
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

const TOKEN = "e2e-workspace-cache-eviction-token";

const PROJECT = "cache-eviction-repo";
const DEFAULT_BRANCH = "main";
// Two non-default branches so both are deletable via the context menu
// (the "Delete workspace" item is hidden when `branch === defaultBranch`,
// see `WorkspaceCard.tsx`).
const BRANCH_A = "feature-cache-a";
const BRANCH_B = "feature-cache-b";

const WORKSPACE_A = toWorkspaceId(PROJECT, BRANCH_A);
const WORKSPACE_B = toWorkspaceId(PROJECT, BRANCH_B);

// Wide viewport so `useIsDesktop()` reports true and the shared dockview
// renders (matches >= 1024px in `apps/web/src/hooks/useIsDesktop.ts`).
// Without the dockview the project-list sidebar — and therefore the
// per-workspace context menu — is not visible.
test.use({ viewport: { width: 1280, height: 800 } });

// Hermetic git environment: explicit allowlist, no `process.env` spread.
// A contributor with `GIT_TEMPLATE_DIR`, `GIT_CONFIG_GLOBAL`, or a
// signing-key config that runs a prompt would otherwise have their host
// settings leaked into the `git init` / `commit` calls below and
// potentially hang the test or fail it in confusing ways. Pointing both
// `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` at /dev/null guarantees
// `git` ignores any host config and reads only what we provide here.
function makeGitEnv(home: string): NodeJS.ProcessEnv {
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

function git(cwd: string, args: string[], home: string): string {
  return execFileSync("git", args, { cwd, env: makeGitEnv(home), encoding: "utf-8" });
}

// `ServerHandle | undefined` (rather than the definite-assignment `!`
// shorthand) so TypeScript forces the `if (typeof server !== "undefined")`
// guard in `afterAll`. Same shape as `resources.spec.ts`. Without it, a
// `startServer` failure in `beforeAll` would surface as a confusing
// `TypeError: Cannot read properties of undefined (reading 'close')` in
// the teardown and mask the real boot error.
let server: ServerHandle | undefined;
let tmpHome: string;
let repoPath: string;
let worktreeAPath: string;
let worktreeBPath: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  // Real git repo on disk — required because the server's
  // `workspaces.remove` mutation calls `git worktree list --porcelain`
  // against the project path. Without a real repo the mutation throws
  // and the deletion never propagates back to the projects query.
  repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", DEFAULT_BRANCH], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# Cache eviction test\n");
  git(repoPath, ["add", "."], tmpHome);
  git(repoPath, ["commit", "-m", "initial commit"], tmpHome);

  // Worktrees live ALONGSIDE the bare repo, both inside `tmpHome` so the
  // recursive `rmSync(tmpHome, …)` in `afterAll` is sufficient cleanup:
  // git's bookkeeping (under `repoPath/.git/worktrees/`) is reaped along
  // with the worktrees themselves, so no explicit `git worktree remove`
  // is needed. If a future refactor moves worktrees outside `tmpHome`
  // this teardown will leak.
  worktreeAPath = join(tmpHome, `${PROJECT}-${BRANCH_A}`);
  worktreeBPath = join(tmpHome, `${PROJECT}-${BRANCH_B}`);
  git(repoPath, ["worktree", "add", "-b", BRANCH_A, worktreeAPath], tmpHome);
  git(repoPath, ["worktree", "add", "-b", BRANCH_B, worktreeBPath], tmpHome);

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
  // Pin `maxCachedWorkspaces` explicitly so the test's "neither workspace
  // is LRU-evicted by capacity" assumption can't be invalidated by a
  // future PR lowering `DEFAULT_MAX_CACHED_WORKSPACES`. The test needs
  // capacity >= 2 (one cached + one active) to keep both alive at the
  // assertion point.
  seedSettings(tmpHome, { tokenSecret: TOKEN, maxCachedWorkspaces: 3 });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (typeof server !== "undefined") await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("MultiWorkspacePanelHost cache eviction (issue #508)", () => {
  test("evicts a deleted workspace from the LRU cache after deletion via the sidebar", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    // Land on workspace A via a real navigation, then switch to B via a
    // CLIENT-SIDE click on B's sidebar card. The distinction matters:
    // `goto()` triggers a full browser navigation that wipes React
    // state, including `MultiWorkspacePanelHost`'s LRU cache. The
    // bug we're guarding is "deleted workspace stays cached", which
    // only manifests when the cache survives a workspace switch — so
    // the test must use the SAME in-app switch path the user takes
    // (TanStack Router via the workspace card's onClick), not a full
    // page navigation. With the default `maxCachedWorkspaces = 3`,
    // neither workspace is LRU-evicted by capacity, so any later
    // eviction is unambiguously attributable to the reconcile-against-
    // projects effect being tested.
    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();
    // Wait for the projects-query to land so the workspace cards exist
    // before we try to click one. Without this the click resolves
    // against the still-empty project list and silently no-ops.
    await expect(workspacePage.workspaceCard(WORKSPACE_B)).toBeVisible();
    await expect(workspacePage.cachedPanelEntries(WORKSPACE_A).first()).toBeVisible();

    await workspacePage.switchWorkspace(WORKSPACE_B);
    await expect(workspacePage.cachedPanelEntries(WORKSPACE_B).first()).toBeVisible();

    // Positive anchor: BOTH workspaces are cached at this point.
    // `MultiWorkspacePanelHost` is mounted once per outer dockview panel
    // (chat, changes, files, terminal, browser = 5 hosts), so every
    // cached workspaceId produces multiple matching elements — assert
    // ">= 1" to stay robust to layout-config changes.
    expect(await workspacePage.cachedPanelEntries(WORKSPACE_A).count()).toBeGreaterThan(0);
    expect(await workspacePage.cachedPanelEntries(WORKSPACE_B).count()).toBeGreaterThan(0);

    // Drive the deletion via the same path the user takes: right-click
    // the workspace card in the dashboard sidebar (visible while B is
    // active), then click "Delete workspace". This fires the real
    // `useRemoveWorkspace` mutation, which invalidates the projects
    // query, which triggers `useProjects()` to refetch, which produces
    // a new `projects` reference, which fires the reconcile effect in
    // `MultiWorkspacePanelHost`.
    await workspacePage.deleteWorkspaceFromSidebar(WORKSPACE_A);

    // The reconcile effect must drop A's cache entries from every panel
    // host. `expect(...).toHaveCount(0)` auto-retries up to the
    // expect-timeout, so we don't need to predict how long the
    // mutation → invalidate → refetch → effect chain takes.
    await expect(workspacePage.cachedPanelEntries(WORKSPACE_A)).toHaveCount(0);

    // Workspace B (the still-active one) must remain cached — eviction
    // is for *disappeared* workspaces only. Without this counter-anchor
    // a buggy implementation that wipes the entire cache would also
    // pass the negative assertion above.
    expect(await workspacePage.cachedPanelEntries(WORKSPACE_B).count()).toBeGreaterThan(0);
  });
});
