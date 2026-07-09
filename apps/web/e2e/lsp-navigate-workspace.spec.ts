/**
 * Regression coverage for the cross-workspace file leak in the Files panel —
 * `band:lsp-navigate` events (dispatched by the CodeMirror LSP client on
 * go-to-definition) must be scoped to the workspace whose editor fired them,
 * so a go-to-definition in workspace A cannot drive the (different) active
 * workspace B's Files panel to open A's relative path against B's root.
 *
 * Pre-fix, `BandWorkspace.displayFile` in `codemirror-lsp.ts` dispatched
 * `band:lsp-navigate` with only `{ filePath }`, and every mounted
 * `CodeBrowserView` (the LRU cache in `MultiWorkspacePanelHost` keeps up to
 * `maxCachedWorkspaces` workspace subtrees alive, hidden with
 * `visibility:hidden`) listened with NO workspace guard. So a
 * go-to-definition in A also ran the handler in hidden workspace B: B's
 * `FileViewer` stat'd `<B-root>/<A-relative-path>` → `ENOENT`, and
 * `fileTabs.openTabPinned` persisted the stale path into
 * `band-open-tabs:<B>` where it survived reloads. This is the same bug class
 * that issue #539 fixed for `band:open-file`; this spec covers the
 * sibling `band:lsp-navigate` event.
 *
 * The fix mirrors #539:
 *
 *   1. `BandWorkspace` threads the owning `workspaceId` through
 *      `createLspExtension` and stamps it onto the `band:lsp-navigate`
 *      event detail.
 *   2. The `CodeBrowserView` `band:lsp-navigate` listener filters on
 *      `detail.workspaceId`: it ignores the event unless it's addressed to
 *      this instance's workspace. A missing id falls through to the active
 *      workspace (forward-compat).
 *
 * Test architecture:
 *
 *   - Boots the real production server against a fresh tmp home.
 *   - Two real git worktrees; `only-in-a.ts` exists ONLY in A, so a stat of
 *     that path against B's root fails with ENOENT — the exact symptom.
 *   - No tRPC mocking, no MSW, no `page.route()` on own routes. The spec
 *     drives the DOM event directly via `dispatchLspNavigateEvent(...)`
 *     (the LSP client's real dispatch is a synchronous
 *     `window.dispatchEvent`, so no external stub is needed).
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
import { FileTreesPage } from "./pages/FileTreesPage";
import { FileViewerPage } from "./pages/FileViewerPage";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-lsp-navigate-workspace-token";

const PROJECT = "lsp-navigate-repo";
const DEFAULT_BRANCH = "main";
const BRANCH_A = "feature-a";
const BRANCH_B = "feature-b";

const WORKSPACE_A = toWorkspaceId(PROJECT, BRANCH_A);
const WORKSPACE_B = toWorkspaceId(PROJECT, BRANCH_B);

// A file that exists ONLY in workspace A. When a leaked navigate makes B's
// FileViewer stat `<B-root>/only-in-a.ts`, the read fails with ENOENT — the
// bug's observable symptom. Named so it can never collide with a B file.
const ONLY_IN_A = "only-in-a.ts";
// A file present in BOTH worktrees (different content) — the healthy file we
// open in B to establish a clean Files-panel baseline, and the fall-through
// target for the missing-workspaceId compatibility test.
const SHARED = "shared.ts";
const ONLY_IN_B = "only-in-b.ts";

// Wide viewport so `useIsDesktop()` reports true and the shared dockview
// renders. The bug only manifests in the desktop layout, where multiple
// workspaces are alive at once under `MultiWorkspacePanelHost`'s LRU cache.
// The mobile layout mounts one workspace at a time, so there's no
// cross-workspace event leak to guard against there in the same way.
test.use({ viewport: { width: 1280, height: 800 } });

function makeGitEnv(home: string): NodeJS.ProcessEnv {
  // Hermetic git environment — mirrors `chat-file-link-workspace.spec.ts`.
  // `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` pointed at /dev/null block host
  // config from leaking into commits.
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
let tmpHome: string | undefined;

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  // Real git repo with two worktrees. Each worktree has a distinctly named
  // file plus a `shared.ts` that exists in both (different content).
  const repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", DEFAULT_BRANCH], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# LSP navigate test\n");
  git(repoPath, ["add", "."], tmpHome);
  git(repoPath, ["commit", "-m", "initial commit"], tmpHome);

  const worktreeAPath = join(tmpHome, `${PROJECT}-${BRANCH_A}`);
  const worktreeBPath = join(tmpHome, `${PROJECT}-${BRANCH_B}`);
  git(repoPath, ["worktree", "add", "-b", BRANCH_A, worktreeAPath], tmpHome);
  git(repoPath, ["worktree", "add", "-b", BRANCH_B, worktreeBPath], tmpHome);

  // `only-in-a.ts` lives only in A: a leaked navigate for it hits B's root
  // and ENOENTs. `shared.ts` lives in both so B can open a healthy file.
  writeFileSync(join(worktreeAPath, ONLY_IN_A), "// only in workspace A\n");
  writeFileSync(join(worktreeAPath, SHARED), "// shared name, different file in A\n");
  writeFileSync(join(worktreeBPath, ONLY_IN_B), "// only in workspace B\n");
  writeFileSync(join(worktreeBPath, SHARED), "// shared name, different file in B\n");

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
  // Pin `maxCachedWorkspaces` to 3 — same as the #539 spec — so neither A
  // nor B is LRU-evicted at the assertion point. The bug only manifests
  // when BOTH workspace trees are alive simultaneously and the listener has
  // to decide which one to route to.
  seedSettings(tmpHome, { tokenSecret: TOKEN, maxCachedWorkspaces: 3 });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
});

test.describe("Files-panel LSP navigate workspace scoping (cross-workspace file leak)", () => {
  test("a go-to-definition addressed to workspace A does NOT leak the file into active workspace B (no ENOENT, no poisoned tabs)", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const fileTrees = new FileTreesPage(page, workspacePage);
    // Scope the viewer to B's subtree: A's FileViewer stays mounted (hidden)
    // in the LRU cache, so an unscoped `file-viewer__root` would also resolve
    // to A's — and after the dispatch A's viewer legitimately shows
    // `only-in-a.ts`, which would fool a `.first()` content assertion.
    const fileViewer = new FileViewerPage(page, workspacePage.cachedPanelEntries(WORKSPACE_B));

    // Land on A and activate its Files tab so A's CodeBrowserView mounts and
    // its `band:lsp-navigate` listener is live. Waiting for the (unclicked)
    // tree row confirms the tree loaded without opening the file — A's tab
    // list stays empty until the dispatch, which is what makes the positive
    // anchor below meaningful.
    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();
    await fileTrees.openFilesTab(ONLY_IN_A);

    // Switch to B via the sidebar (client-side nav) so A stays mounted +
    // cached (its listener still alive) while B becomes active.
    await expect(workspacePage.workspaceCard(WORKSPACE_B)).toBeVisible();
    await workspacePage.switchWorkspace(WORKSPACE_B);
    await expect(workspacePage.cachedPanelEntries(WORKSPACE_B).first()).toBeVisible();
    expect(await workspacePage.cachedPanelEntries(WORKSPACE_A).count()).toBeGreaterThan(0);

    // Open a healthy file in B so B's FileViewer is mounted and shows valid
    // content — the clean baseline the leak would corrupt. We open
    // `only-in-b.ts` (a name unique to B) rather than `shared.ts`, because A's
    // hidden-but-mounted file tree also carries a `shared.ts` row, and the
    // per-path `file-tree__row--*` testid isn't workspace-scoped — a shared
    // name would resolve to two rows (A's hidden + B's visible).
    await fileTrees.openFilesTab(ONLY_IN_B);
    await fileTrees.openFile(ONLY_IN_B);
    await fileViewer.expectContent("only in workspace B");
    await expect(fileViewer.errorBanner).not.toBeVisible();

    // Fire the go-to-definition as it belongs to workspace A while B is the
    // active workspace.
    await workspacePage.dispatchLspNavigateEvent({
      filePath: ONLY_IN_A,
      workspaceId: WORKSPACE_A,
    });

    // Positive anchor: the event was live and A's listener handled it — A's
    // persisted tab list gains `only-in-a.ts`. Without this, the negative
    // assertions on B could pass trivially on a broken build where the event
    // never reached any listener.
    await expect
      .poll(async () => (await workspacePage.readOpenTabsState(WORKSPACE_A))?.tabs ?? [], {
        timeout: 5000,
      })
      .toContain(ONLY_IN_A);

    // Negative — the leak, as a poll-for-appearance. `expect.poll(...).not
    // .toContain(...)` would pass trivially at t=0 (B's tab list has only
    // `shared.ts`), so instead poll for the leak's ARRIVAL within a bounded
    // window and assert it never came. The bug opens `only-in-a.ts` as a
    // fresh (non-restored) tab, which is NOT covered by the self-heal guard,
    // so the leak would be persistent — the poll catches it deterministically.
    let leaked = false;
    try {
      await expect
        .poll(async () => (await workspacePage.readOpenTabsState(WORKSPACE_B))?.tabs ?? [], {
          timeout: 2000,
        })
        .toContain(ONLY_IN_A);
      leaked = true;
    } catch {
      // Poll exhausted its budget without observing the leak — the contract.
    }
    expect(leaked).toBe(false);

    // B's Files panel must not have stat'd the A-only path against B's root:
    // the viewer still shows B's healthy file (positive anchor) and there's no
    // ENOENT banner. Content-first, then error-absence — same order as the
    // pre-dispatch baseline above.
    await fileViewer.expectContent("only in workspace B");
    await expect(fileViewer.errorBanner).not.toBeVisible();
  });

  test("a navigate with no workspaceId falls through to the active workspace (backwards-compat)", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const fileTrees = new FileTreesPage(page, workspacePage);
    // Unscoped viewer is fine here: this test only ever mounts workspace B
    // (a single `goto`, no switch), so there's no LRU sibling whose
    // `file-viewer__root` could also match — unlike the first test.
    const fileViewer = new FileViewerPage(page);

    // A single active workspace B with a healthy file open.
    await workspacePage.goto(WORKSPACE_B);
    await workspacePage.waitForReady();
    await fileTrees.openFilesTab(ONLY_IN_B);
    await fileTrees.openFile(ONLY_IN_B);
    await fileViewer.expectContent("only in workspace B");

    // Contract: a navigate with no `workspaceId` (older dispatcher / forward-
    // compat) must still drive the active workspace's CodeBrowserView. Fire
    // one for a file that exists in B — it should become a pinned tab there.
    await workspacePage.dispatchLspNavigateEvent({ filePath: SHARED });

    await expect
      .poll(async () => (await workspacePage.readOpenTabsState(WORKSPACE_B))?.tabs ?? [], {
        timeout: 5000,
      })
      .toContain(SHARED);
    // The fall-through opened B's OWN `shared.ts`, which resolves against B's
    // root — so no error banner.
    await expect(fileViewer.errorBanner).not.toBeVisible();
  });
});
