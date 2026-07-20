/**
 * End-to-end coverage for opening a file that lives OUTSIDE the workspace
 * worktree from Quick Open (Cmd+P).
 *
 * Feature: when the Quick Open query is an absolute path to a file that
 * exists — e.g. `/tmp/notes.md` pasted in, or the absolute path a terminal /
 * chat link dispatches via `band:open-file` — the dialog resolves it against
 * the workspace (`workspace.resolvePath`) and offers to open it. A path
 * INSIDE the worktree opens as a normal workspace-relative tab; a path
 * OUTSIDE opens as an *external* tab (contents read via `host.readFile`,
 * same pipeline the CLI's `band open <abs>` uses). See `QuickOpenDialog.tsx`,
 * `workspace.resolvePath` / `editorService.resolvePath`, and
 * `SharedDockviewLayout.handleOpenExternalFile`.
 *
 * Test architecture (per the repo's integration-test doctrine):
 *   - Boots the real production server against a fresh tmp home — no
 *     in-process React mounting, no tRPC mocking, no `page.route()`.
 *   - A real git worktree is the workspace; the "external" files are written
 *     OUTSIDE the worktree root so they can only be reached by absolute path.
 *   - A `.ts` external file gives a deterministic CodeMirror content read;
 *     the user's literal `/tmp/…​.md` example is covered separately (markdown
 *     opens as a rendered preview, so that case asserts the tab opens rather
 *     than editor text).
 *   - The link-driven cases use `dispatchOpenFileEvent` — the exact
 *     `band:open-file` window event the xterm link provider
 *     (`terminal-file-links.ts`) and chat file links
 *     (`ai-elements/file-link-components.tsx`) both fire. The real
 *     terminal-click variant lives in `terminal-external-file-link.spec.ts`.
 *   - All locators/actions go through the WorkspacePage / FileViewerPage
 *     page objects.
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
import { FileViewerPage } from "./pages/FileViewerPage";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-quick-open-external-file-token";
const PROJECT = "quick-open-external-repo";
const DEFAULT_BRANCH = "main";
const BRANCH = "feature";
const WORKSPACE = toWorkspaceId(PROJECT, BRANCH);

// Distinctive marker so the CodeMirror render of the `.ts` external file is
// unambiguous.
const TS_MARKER = "band-external-note-marker";

// Desktop viewport so `useIsDesktop()` is true and `SharedDockviewLayout`
// (which mounts QuickOpenDialog + owns the external-open wiring) renders.
test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome: string | undefined;
let worktreePath!: string;
// Absolute paths to files OUTSIDE the worktree — the only way to reach them
// is by absolute path, which is exactly the external-open case under test.
let externalTsPath!: string;
let externalMdPath!: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  const repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", DEFAULT_BRANCH], tmpHome);
  // A single in-worktree file so the workspace is non-empty and Quick Open's
  // worktree search has a corpus (the external paths must NOT match it).
  writeFileSync(join(repoPath, "inside.ts"), "export const inside = 1;\n");
  git(repoPath, ["add", "."], tmpHome);
  git(repoPath, ["commit", "-m", "seed"], tmpHome);

  worktreePath = join(tmpHome, `${PROJECT}-${BRANCH}`);
  git(repoPath, ["worktree", "add", "-b", BRANCH, worktreePath], tmpHome);

  // Both sit at the tmp-home root — outside the repo and the worktree, so
  // they can only be opened by absolute path.
  externalTsPath = join(tmpHome, "band-external-note.ts");
  writeFileSync(externalTsPath, `export const marker = "${TS_MARKER}";\n`);
  externalMdPath = join(tmpHome, "band-terminal-repair-task.md");
  writeFileSync(externalMdPath, "# task\n\nrepair the terminal\n");

  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: repoPath,
        defaultBranch: DEFAULT_BRANCH,
        worktrees: [
          { branch: DEFAULT_BRANCH, path: repoPath },
          { branch: BRANCH, path: worktreePath },
        ],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
});

test.describe("Quick Open — open a file outside the worktree by absolute path", () => {
  test("typing an existing absolute path offers to open it and lands an external tab", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForReady();

    // Nothing open before we begin — poll for settled state.
    await expect
      .poll(async () => await workspacePage.readOpenTabPaths(WORKSPACE), { timeout: 5_000 })
      .not.toContain(externalTsPath);

    await workspacePage.openQuickOpen();
    await workspacePage.fillQuickOpen(externalTsPath);

    // The offer appears once the probe resolves, and shows the path.
    await expect(workspacePage.quickOpenPathItem).toBeVisible({ timeout: 15_000 });
    await expect(workspacePage.quickOpenPathItem).toContainText(externalTsPath);

    // Positive anchor: the dialog is open before we accept + assert dismissal.
    await expect(workspacePage.quickOpenDialog()).toBeVisible();

    // Accept the offer.
    await workspacePage.openQuickOpenPathItem();

    // Observable outcome: the absolute path is now the active external tab,
    // the Files panel is active, and the editor shows the file's contents.
    await expect
      .poll(async () => (await workspacePage.readOpenTabsState(WORKSPACE))?.active, {
        timeout: 15_000,
      })
      .toBe(externalTsPath);
    await expect(workspacePage.tabContainer("files")).toHaveClass(/\bdv-active-tab\b/, {
      timeout: 15_000,
    });
    await expect(workspacePage.quickOpenDialog()).toBeHidden();

    const fileViewer = new FileViewerPage(page);
    await fileViewer.expectContent(TS_MARKER);
  });

  test("a band:open-file event with an absolute .md path auto-opens it as an external tab (link path)", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForReady();

    // The same event a terminal or chat file link dispatches — here the
    // user's literal example: an absolute path to a `.md` file, with a
    // `:line` suffix that `parseFileLocation` strips off the tab path.
    await workspacePage.dispatchOpenFileEvent({
      filename: `${externalMdPath}:2`,
      workspaceId: WORKSPACE,
    });

    // Single external match → opened directly, the dialog never shows. The
    // absolute path (suffix stripped) is the active tab. Markdown renders as
    // a preview rather than a CodeMirror buffer, so we assert the tab opened
    // and the viewer mounted rather than editor text.
    await expect
      .poll(async () => (await workspacePage.readOpenTabsState(WORKSPACE))?.active, {
        timeout: 15_000,
      })
      .toBe(externalMdPath);
    // Positive DOM anchor (viewer mounted) before the negative dismissal check.
    await new FileViewerPage(page).expectVisible();
    await expect(workspacePage.quickOpenDialog()).toBeHidden();
  });

  test("a band:open-file event for a non-existent absolute path reveals the dialog with no match", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForReady();

    const missing = join(tmpHome!, "does-not-exist.md");
    await workspacePage.dispatchOpenFileEvent({ filename: missing, workspaceId: WORKSPACE });

    // Positive anchor: the dialog is revealed AND settled with the query set
    // (the missing path is seeded into the input) — so the subsequent
    // "no offer" assertion proves the resolver found nothing, not that the
    // query never arrived.
    await expect(workspacePage.quickOpenDialog()).toBeVisible({ timeout: 15_000 });
    await expect(workspacePage.quickOpenInput).toHaveValue(missing);
    // No file to auto-open → no external-open row (the path isn't a real file).
    await expect(workspacePage.quickOpenPathItem).toBeHidden();
    expect(await workspacePage.readOpenTabPaths(WORKSPACE)).not.toContain(missing);
  });

  test("typing an absolute path INSIDE the worktree opens it as a normal (relative) tab", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForReady();

    // An absolute path that happens to point inside the current worktree.
    const insideAbs = join(worktreePath, "inside.ts");
    await workspacePage.openQuickOpen();
    await workspacePage.fillQuickOpen(insideAbs);

    // The offer resolves the path back to its workspace-relative form —
    // NOT the absolute path — because the file lives inside the worktree.
    await expect(workspacePage.quickOpenPathItem).toBeVisible({ timeout: 15_000 });
    await expect(workspacePage.quickOpenPathItem).toContainText("inside.ts");
    await workspacePage.openQuickOpenPathItem();

    // Observable outcome: it opens as a NORMAL workspace tab keyed by the
    // relative path (not an external tab keyed by the absolute path).
    await expect
      .poll(async () => (await workspacePage.readOpenTabsState(WORKSPACE))?.active, {
        timeout: 15_000,
      })
      .toBe("inside.ts");
    expect(await workspacePage.readOpenTabPaths(WORKSPACE)).not.toContain(insideAbs);
    await expect(workspacePage.tabContainer("files")).toHaveClass(/\bdv-active-tab\b/, {
      timeout: 15_000,
    });

    const fileViewer = new FileViewerPage(page);
    await fileViewer.expectContent("export const inside");
  });
});
