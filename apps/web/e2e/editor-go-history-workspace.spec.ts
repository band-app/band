/**
 * Regression coverage for the cross-workspace editor-history leak —
 * `band:editor-go-back` / `band:editor-go-forward` events (dispatched by the
 * command palette's "Go Back" / "Go Forward" commands) must be scoped to the
 * workspace whose editor owns the history, so a Go Back invoked for workspace
 * A cannot also step the (different) active workspace B's independent history
 * stack.
 *
 * This is the milder sibling of the `band:lsp-navigate` leak covered by
 * `lsp-navigate-workspace.spec.ts`: pre-fix, both editor-history events were
 * dispatched on `window` with NO workspace id, and every mounted
 * `CodeBrowserView` (the LRU cache in `MultiWorkspacePanelHost` keeps up to
 * `maxCachedWorkspaces` subtrees alive, hidden with `visibility:hidden`)
 * handled them with no guard. So a Go Back in A also ran the handler in hidden
 * workspace B, walking B's own history stack behind the user's back. Unlike
 * the LSP leak there's no ENOENT (each workspace's stack only holds its own
 * files), but the active workspace's viewer still silently jumps to a
 * different file.
 *
 * The fix mirrors issue #539: the command palette stamps the active
 * `workspaceId` onto the event detail, and each `CodeBrowserView` listener
 * early-returns unless the event is addressed to its own workspace (a missing
 * id falls through to the active workspace for forward-compat).
 *
 * Test architecture:
 *
 *   - Boots the real production server against a fresh tmp home.
 *   - Two real git worktrees. Workspace B gets two files so it has a real
 *     back-navigable history stack; the bug would surface as B's viewer
 *     stepping back when a Go Back addressed to A is dispatched.
 *   - No tRPC mocking, no MSW, no `page.route()` on own routes. The spec
 *     drives the DOM events directly via `dispatchEditorHistoryEvent(...)`
 *     (the palette's real dispatch is a synchronous `window.dispatchEvent`).
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
import { FileTreesPage } from "./pages/FileTreesPage";
import { FileViewerPage } from "./pages/FileViewerPage";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-editor-go-history-workspace-token";

const PROJECT = "editor-history-repo";
const DEFAULT_BRANCH = "main";
const BRANCH_A = "feature-a";
const BRANCH_B = "feature-b";

const WORKSPACE_A = toWorkspaceId(PROJECT, BRANCH_A);
const WORKSPACE_B = toWorkspaceId(PROJECT, BRANCH_B);

// A file unique to A (so A is a real, mounted sibling workspace). Its name
// can't collide with B's file-tree rows.
const ONLY_IN_A = "only-in-a.ts";
// Two files unique to B, opened in order to build B's back-navigable history
// stack. Distinct content so the viewer assertions can tell them apart.
const B_ONE = "b-one.ts";
const B_TWO = "b-two.ts";
const B_ONE_TEXT = "workspace B file one";
const B_TWO_TEXT = "workspace B file two";

// Wide viewport so `useIsDesktop()` reports true and the shared dockview
// renders. The bug only manifests in the desktop layout, where multiple
// workspaces are alive at once under `MultiWorkspacePanelHost`'s LRU cache.
test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome: string | undefined;

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  const repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", DEFAULT_BRANCH], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# Editor history test\n");
  git(repoPath, ["add", "."], tmpHome);
  git(repoPath, ["commit", "-m", "initial commit"], tmpHome);

  const worktreeAPath = join(tmpHome, `${PROJECT}-${BRANCH_A}`);
  const worktreeBPath = join(tmpHome, `${PROJECT}-${BRANCH_B}`);
  git(repoPath, ["worktree", "add", "-b", BRANCH_A, worktreeAPath], tmpHome);
  git(repoPath, ["worktree", "add", "-b", BRANCH_B, worktreeBPath], tmpHome);

  writeFileSync(join(worktreeAPath, ONLY_IN_A), "// only in workspace A\n");
  writeFileSync(join(worktreeBPath, B_ONE), `// ${B_ONE_TEXT}\n`);
  writeFileSync(join(worktreeBPath, B_TWO), `// ${B_TWO_TEXT}\n`);

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
  // Pin `maxCachedWorkspaces` to 3 so neither A nor B is LRU-evicted — the
  // bug only manifests when BOTH workspace trees are alive at once.
  seedSettings(tmpHome, { tokenSecret: TOKEN, maxCachedWorkspaces: 3 });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
});

// TODO(#643 Phase 5): file explorer moved to right sidepanel — the bare
// per-path `file` leaf that replaced the desktop CodeBrowserView has NO editor
// back/forward history wired in, so this cross-workspace Go-Back scoping
// scenario has no affordance to drive. Re-enable when editor history is wired
// into the new file leaf.
test.describe
  .skip("Editor-history workspace scoping (cross-workspace history leak)", () => {
    test("a Go Back addressed to workspace A does NOT step active workspace B's history", async ({
      page,
    }) => {
      const workspacePage = new WorkspacePage(page, server.url, TOKEN);
      const fileTrees = new FileTreesPage(page, workspacePage);
      // Scope the viewer to B's subtree: A stays mounted (hidden) in the LRU
      // cache, so an unscoped `file-viewer__root` could resolve to more than one.
      const fileViewer = new FileViewerPage(page, workspacePage.cachedPanelEntries(WORKSPACE_B));

      // Land on A and activate its Files tab so A's CodeBrowserView mounts and
      // its editor-history listener is live — a genuine cross-workspace sibling.
      await workspacePage.goto(WORKSPACE_A);
      await workspacePage.waitForReady();
      await fileTrees.openFilesTab(ONLY_IN_A);

      // Switch to B via the sidebar (client-side nav) so A stays mounted +
      // cached while B becomes active.
      await expect(workspacePage.workspaceCard(WORKSPACE_B)).toBeVisible();
      await workspacePage.switchWorkspace(WORKSPACE_B);
      await expect(workspacePage.cachedPanelEntries(WORKSPACE_B).first()).toBeVisible();
      await expect
        .poll(async () => workspacePage.cachedPanelEntries(WORKSPACE_A).count(), { timeout: 5000 })
        .toBeGreaterThan(0);

      // NOTE(#643 Phase 5): this used to activate B's Files tab so B's
      // CodeBrowserView mounted (registering its editor-history + lsp-navigate
      // listeners). That desktop view — and its editor history — were removed in
      // Phase 2, which is why this whole describe is skipped. The sidepanel reveal
      // is the closest surviving surface; the body is never reached at runtime.
      await workspacePage.revealRightPanel();

      // Build B's back-navigable history by driving two cross-file navigations
      // into B — the same `band:lsp-navigate` path go-to-definition uses, which
      // opens the file AND pushes a departure+arrival onto B's editor-history
      // stack. Using the event (rather than two file-tree clicks) keeps the
      // setup deterministic: the second tree click is unreliable because opening
      // the first file re-lays B's file tree. After both, B shows b-two and a
      // Go Back lands on b-one.
      await workspacePage.dispatchLspNavigateEvent({ filePath: B_ONE, workspaceId: WORKSPACE_B });
      await fileViewer.expectContent(B_ONE_TEXT);
      await workspacePage.dispatchLspNavigateEvent({ filePath: B_TWO, workspaceId: WORKSPACE_B });
      await fileViewer.expectContent(B_TWO_TEXT);

      // Guard under test: a Go Back addressed to A must be ignored by B — B's
      // viewer stays on b-two. Poll for b-one's ARRIVAL within a bounded window
      // (a plain `expectNotContent` would pass trivially at t=0) and assert it
      // never came. On bug code B's unguarded handler steps its own stack back
      // to b-one, which this poll catches.
      await workspacePage.dispatchEditorHistoryEvent({
        direction: "back",
        workspaceId: WORKSPACE_A,
      });
      let leaked = false;
      try {
        await expect
          .poll(async () => fileViewer.readText(), { timeout: 2000 })
          .toContain(B_ONE_TEXT);
        leaked = true;
      } catch {
        // Poll exhausted its budget without B stepping back — the contract.
      }
      expect(leaked).toBe(false);
      // B is still showing b-two (positive anchor that nothing moved).
      await fileViewer.expectContent(B_TWO_TEXT);

      // Positive control: a Go Back addressed to B itself DOES step B's history
      // — proving the event mechanism is live, so the negative above is
      // meaningful rather than a dead event.
      await workspacePage.dispatchEditorHistoryEvent({
        direction: "back",
        workspaceId: WORKSPACE_B,
      });
      await fileViewer.expectContent(B_ONE_TEXT);
    });
  });
