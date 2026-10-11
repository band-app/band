/**
 * Regression coverage for issue #508 —
 * `MultiWorktreePanelHost` unmounts a worktree as soon as that
 * worktree disappears from the repos query. Deletion is the only way a
 * visited worktree leaves the mounted set.
 *
 * Test architecture:
 *
 *   - The same production binary the user ships runs inside the test
 *     against a fresh tmp `~/.band/`. Migrations apply to the throwaway
 *     SQLite DB on boot.
 *   - The deletion is driven through the dashboard sidebar's
 *     `WorktreeCard` context menu — the same flow the user takes — so
 *     the real `useRemoveWorktree` mutation runs, the real repos
 *     query invalidates, and the real reconcile-against-repos effect
 *     inside `MultiWorktreePanelHost` fires.
 *   - No tRPC mocking, no `page.route()` on our own routes, no MSW.
 *
 * The cache itself is internal React state — the test asserts on its
 * SHAPE through a public DOM surface: `MultiWorktreePanelHost` renders
 * one `<div data-testid="worktree-panel-host__cached-entry--<id>">`
 * per worktree it currently caches (multiple, one per panel host,
 * because the layout mounts five hosts: chat / changes / files /
 * terminal / browser). The test counts entries with `count() === 0`
 * to confirm the deleted worktree was fully evicted across every
 * panel host.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-worktree-cache-eviction-token";

const REPO = "cache-eviction-repo";
const DEFAULT_BRANCH = "main";
// Two non-default branches so both are deletable via the context menu
// (the "Delete worktree" item is hidden when `branch === defaultBranch`,
// see `WorktreeCard.tsx`).
const BRANCH_A = "feature-cache-a";
const BRANCH_B = "feature-cache-b";

const WORKTREE_A = toWorktreeId(REPO, BRANCH_A, "local");
const WORKTREE_B = toWorktreeId(REPO, BRANCH_B, "local");

// Wide viewport so `useIsDesktop()` reports true and the shared dockview
// renders (matches >= 1024px in `apps/web/src/hooks/useIsDesktop.ts`).
// Without the dockview the repo-list sidebar — and therefore the
// per-worktree context menu — is not visible.
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

// Definite-assignment shorthand — matches `resources.spec.ts`, the
// canonical pattern for specs that need to guard `server` in
// `afterAll`. The `if (server)` check below covers the only path
// that could leave it unassigned: `startServer` throwing before
// resolving in `beforeAll`. Without the guard, an unrelated
// `TypeError: Cannot read properties of undefined (reading 'close')`
// would mask the real boot failure.
let server!: ServerHandle;
let tmpHome: string;
let repoPath: string;
let worktreeAPath: string;
let worktreeBPath: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  // Real git repo on disk — required because the server's
  // `worktrees.remove` mutation calls `git worktree list --porcelain`
  // against the repo path. Without a real repo the mutation throws
  // and the deletion never propagates back to the repos query.
  repoPath = join(tmpHome, REPO);
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
  worktreeAPath = join(tmpHome, `${REPO}-${BRANCH_A}`);
  worktreeBPath = join(tmpHome, `${REPO}-${BRANCH_B}`);
  git(repoPath, ["worktree", "add", "-b", BRANCH_A, worktreeAPath], tmpHome);
  git(repoPath, ["worktree", "add", "-b", BRANCH_B, worktreeBPath], tmpHome);

  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
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
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (server) await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("MultiWorktreePanelHost cache eviction (issue #508)", () => {
  test("unmounts a deleted worktree after deletion via the sidebar", async ({ page }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);

    // Land on worktree A via a real navigation, then switch to B via a
    // CLIENT-SIDE click on B's sidebar card. The distinction matters:
    // `goto()` triggers a full browser navigation that wipes React
    // state, including `MultiWorktreePanelHost`'s mounted set. The
    // bug we're guarding is "deleted worktree stays cached", which
    // only manifests when the cache survives a worktree switch — so
    // the test must use the SAME in-app switch path the user takes
    // (TanStack Router via the worktree card's onClick), not a full
    // page navigation. Visited worktrees are never evicted by age or
    // count, so any later unmount is unambiguously attributable to the
    // reconcile-against-repos effect being tested.
    await worktreePage.goto(WORKTREE_A);
    await worktreePage.waitForReady();
    // Wait for the repos-query to land so the worktree cards exist
    // before we try to click one. Without this the click resolves
    // against the still-empty repo list and silently no-ops.
    await expect(worktreePage.worktreeCard(WORKTREE_B)).toBeVisible();
    await expect(worktreePage.cachedPanelEntries(WORKTREE_A).first()).toBeVisible();

    await worktreePage.switchWorktree(WORKTREE_B);
    await expect(worktreePage.cachedPanelEntries(WORKTREE_B).first()).toBeVisible();

    // Positive anchor: BOTH worktrees are cached at this point.
    // `MultiWorktreePanelHost` is mounted once per outer dockview panel
    // (chat, changes, files, terminal, browser = 5 hosts), so every
    // cached worktreeId produces multiple matching elements — assert
    // ">= 1" to stay robust to layout-config changes.
    expect(await worktreePage.cachedPanelEntries(WORKTREE_A).count()).toBeGreaterThan(0);
    expect(await worktreePage.cachedPanelEntries(WORKTREE_B).count()).toBeGreaterThan(0);

    // Drive the deletion via the same path the user takes: right-click
    // the worktree card in the dashboard sidebar (visible while B is
    // active), then click "Delete worktree". This fires the real
    // `useRemoveWorktree` mutation, which invalidates the repos
    // query, which triggers `useRepos()` to refetch, which produces
    // a new `repos` reference, which fires the reconcile effect in
    // `MultiWorktreePanelHost`.
    await worktreePage.deleteWorktreeFromSidebar(WORKTREE_A);

    // The reconcile effect must drop A's cache entries from every panel
    // host. `expect(...).toHaveCount(0)` auto-retries up to the
    // expect-timeout, so we don't need to predict how long the
    // mutation → invalidate → refetch → effect chain takes.
    await expect(worktreePage.cachedPanelEntries(WORKTREE_A)).toHaveCount(0);

    // Worktree B (the still-active one) must remain cached — eviction
    // is for *disappeared* worktrees only. Without this counter-anchor
    // a buggy implementation that wipes the entire cache would also
    // pass the negative assertion above. Uses `toBeVisible()` (which
    // auto-retries) rather than a synchronous `.count()` snapshot so
    // it doesn't race the asynchronous reconcile effect; the test
    // only needs to prove *some* cached entry for B survives, not a
    // particular count.
    await expect(worktreePage.cachedPanelEntries(WORKTREE_B).first()).toBeVisible();
  });
});
