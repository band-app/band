/**
 * Regression coverage for the Quick Open (Cmd+P file finder) selection reset.
 *
 * Expected behaviour (matching VS Code): every time the search query changes
 * and a new result set arrives, the highlighted item snaps back to the first
 * result and the list scrolls to the top. Pre-fix, the dialog let cmdk keep a
 * stale selection — when the previously highlighted file was still present in
 * the new results (just not first), it stayed selected and the list never
 * scrolled back up, so pressing Enter opened the wrong file.
 *
 * The dialog is a cmdk `Command` with `shouldFilter={false}`; cmdk only
 * re-selects the first item when the currently selected item unmounts, so a
 * file that survives a query refinement keeps the highlight. `QuickOpenDialog`
 * now controls cmdk's selection and, whenever the result *contents* change,
 * forces the selection back to the first row and scrolls the list to the top.
 *
 * Test architecture:
 *   - Boots the real production server (via `startServer`) against a fresh tmp
 *     home — no in-process React mounting.
 *   - A real git worktree seeded with a deterministic corpus so the real
 *     `searchWorkspaceFiles` fuzzy ranking is predictable: the two queries
 *     under test return different result *sets*, and a distinctly long-named
 *     "target" file is deterministically LAST (worst length tiebreaker) in
 *     both — so it is never the first row, which is exactly the stale-
 *     selection trap.
 *   - No tRPC mocking, no MSW, no page.route() on own routes — the dialog is
 *     driven through real keyboard input and the real search endpoint.
 *   - All locators/actions go through the WorkspacePage page object.
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

const TOKEN = "e2e-quick-open-select-first-token";

const PROJECT = "quick-open-repo";
const DEFAULT_BRANCH = "main";
const BRANCH = "feature";
const WORKSPACE = toWorkspaceId(PROJECT, BRANCH);

// Distinctly long name → worst length tiebreaker → deterministically LAST in
// both `report` and `reports` rankings, regardless of the on-disk file order
// that `rg --files` happens to return. It matches both queries, so it survives
// the "report" → "reports" refinement without unmounting — the precise
// condition under which cmdk would otherwise keep it selected.
const TARGET = "reports-really-long-target-name-file.ts";

// Desktop viewport so `useIsDesktop()` is true and `SharedDockviewLayout`
// (which mounts QuickOpenDialog and listens for `band:open-quick-open`) renders.
test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome: string | undefined;

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  const repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", DEFAULT_BRANCH], tmpHome);

  // 20 files that match BOTH "report" and "reports" (literal substring).
  for (let i = 0; i < 20; i++) {
    const name = `reports-${String(i).padStart(2, "0")}.ts`;
    writeFileSync(join(repoPath, name), `// ${name}\n`);
  }
  // 6 decoy files that match "report" but NOT "reports": the ".md" extension
  // carries no trailing "s", so refining the query from "report" to "reports"
  // drops them — the two queries therefore return different result SETS, which
  // is what makes the selection-reset observable rather than a no-op.
  for (let i = 0; i < 6; i++) {
    const name = `report-decoy-${String(i).padStart(2, "0")}.md`;
    writeFileSync(join(repoPath, name), `<!-- ${name} -->\n`);
  }
  writeFileSync(join(repoPath, TARGET), `// ${TARGET}\n`);

  git(repoPath, ["add", "."], tmpHome);
  git(repoPath, ["commit", "-m", "seed quick-open corpus"], tmpHome);

  const worktreePath = join(tmpHome, `${PROJECT}-${BRANCH}`);
  git(repoPath, ["worktree", "add", "-b", BRANCH, worktreePath], tmpHome);

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

test.describe("Quick Open selection reset on query change", () => {
  test("changing the query snaps selection to the first result and scrolls the list to the top", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForReady();

    await workspacePage.openQuickOpen();

    // Query 1: "report" — matches all 27 seeded files
    // (20 reports-NN.ts + 6 report-decoy-NN.md + 1 TARGET). TARGET ranks last.
    await workspacePage.typeQuickOpen("report");
    await expect.poll(() => workspacePage.quickOpenItems.count()).toBe(27);

    // Drive the selection down to the LAST row (TARGET) with ArrowDown — the
    // stale-selection precondition: a non-first item selected, list scrolled
    // off the top. (ArrowDown, not End: with focus in the search input End is
    // ambiguous with a caret move and can't be relied on to move the list
    // selection — see `navigateQuickOpenTo`.)
    await workspacePage.navigateQuickOpenTo(TARGET);
    await expect.poll(() => workspacePage.selectedQuickOpenValue()).toBe(TARGET);

    const itemsBefore = await workspacePage.quickOpenItemValues();
    expect(itemsBefore[itemsBefore.length - 1]).toBe(TARGET);
    expect(itemsBefore[0]).not.toBe(TARGET);
    await expect.poll(() => workspacePage.quickOpenListScrollTop()).toBeGreaterThan(0);

    // Query 2: refine to "reports" by APPENDING "s" (not retyping) so TARGET
    // stays continuously mounted — the 6 ".md" decoys drop out (21 results),
    // but TARGET survives and is still ranked last. Pre-fix, cmdk would keep
    // TARGET highlighted (it never unmounted) and leave the list scrolled down.
    await workspacePage.appendQuickOpen("s");
    await expect.poll(() => workspacePage.quickOpenItems.count()).toBe(21);

    // Post-fix: once the new result set settles, the selection is on the FIRST
    // row and the list is scrolled to the top. We wait for the *settled*
    // selection rather than a transient one — the pre-fix dialog briefly
    // highlights the first row while React re-renders, then snaps the highlight
    // back to the stale surviving row (TARGET), so a plain `expect.poll` for
    // "selection is first" would pass on that transient and miss the bug.
    const settled = await workspacePage.settledSelectedQuickOpenValue();
    const items = await workspacePage.quickOpenItemValues();
    expect(settled).toBe(items[0]);
    expect(settled).not.toBe(TARGET);
    expect(await workspacePage.quickOpenListScrollTop()).toBe(0);
  });

  test("arrow keys move the selection and Enter opens the highlighted (first) result", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForReady();

    await workspacePage.openQuickOpen();
    await workspacePage.typeQuickOpen("reports");
    await expect.poll(() => workspacePage.quickOpenItems.count()).toBe(21);

    // Fresh results → first row selected.
    const items = await workspacePage.quickOpenItemValues();
    const firstFile = items[0];
    await expect.poll(() => workspacePage.selectedQuickOpenValue()).toBe(firstFile);

    // Down then up returns to the first row — keyboard navigation still works.
    await workspacePage.pressQuickOpenKey("ArrowDown");
    await expect.poll(() => workspacePage.selectedQuickOpenValue()).toBe(items[1]);
    await workspacePage.pressQuickOpenKey("ArrowUp");
    await expect.poll(() => workspacePage.selectedQuickOpenValue()).toBe(firstFile);

    // Enter opens the highlighted (first) file. The open is observable through
    // the persisted open-tabs state the Files panel writes for this workspace.
    // Assert the positive new state (the tab opened) first, then that the
    // dialog closed.
    await workspacePage.pressQuickOpenKey("Enter");
    await expect
      .poll(async () => (await workspacePage.readOpenTabsState(WORKSPACE))?.active, {
        timeout: 15_000,
      })
      .toBe(firstFile);
    await expect(workspacePage.quickOpenDialog()).toBeHidden();
  });

  test("empty-query recent-files view selects its first item", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForReady();

    // Open a file so it is tracked as a recent file.
    await workspacePage.openQuickOpen();
    await workspacePage.typeQuickOpen("reports");
    await expect.poll(() => workspacePage.quickOpenItems.count()).toBe(21);
    const openedFile = (await workspacePage.quickOpenItemValues())[0];
    await workspacePage.pressQuickOpenKey("Enter");
    await expect(workspacePage.quickOpenDialog()).toBeHidden();
    await expect
      .poll(async () => (await workspacePage.readOpenTabsState(WORKSPACE))?.active, {
        timeout: 15_000,
      })
      .toBe(openedFile);

    // Reopen and clear the query so the recent-files view shows. Its first
    // entry — the file just opened — must be selected.
    await workspacePage.openQuickOpen();
    await workspacePage.clearQuickOpenQuery();
    await expect
      .poll(async () => {
        const items = await workspacePage.quickOpenItemValues();
        return items[0];
      })
      .toBe(openedFile);
    await expect.poll(() => workspacePage.selectedQuickOpenValue()).toBe(openedFile);
  });
});
