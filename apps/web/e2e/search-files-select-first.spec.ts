/**
 * Regression coverage for the Search-in-Files dialog selection reset — the
 * sibling of the Quick Open fix in `quick-open-select-first.spec.ts`.
 *
 * SearchFilesDialog is a cmdk `Command` with `shouldFilter={false}` (manual
 * filtering via the real content-search endpoint), so it carries the same
 * stale-selection contract as Quick Open: every time the query changes and a
 * new result set arrives, the highlighted row must snap back to the first
 * result and the list must scroll to the top. Pre-fix it only reset the
 * selection when the highlighted match *unmounted*; a match that survived a
 * query refinement (still present, just not first) stayed selected and the
 * list never scrolled back up, so pressing Enter opened the wrong match — and,
 * unlike Quick Open, the scroll position was never reset at all.
 *
 * Test architecture:
 *   - Boots the real production server (via `startServer`) against a fresh tmp
 *     home — no in-process React mounting, no mocking.
 *   - A real git worktree seeded with ONE file of 40 matching lines. ripgrep
 *     returns matches within a single file in line-number order, so the row
 *     order is deterministic (cross-file order is not — hence a single file).
 *     Odd lines contain only "alpha"; even lines contain "alpha beta". The
 *     query "alpha" matches all 40; refining to "alpha beta" drops the odd
 *     lines (20 survive) — a genuine result-set change — while the last row
 *     (an even line) survives without unmounting: the exact stale-selection
 *     trap.
 *   - All interactions go through the WorkspacePage page object.
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

const TOKEN = "e2e-search-files-select-first-token";

const PROJECT = "search-files-repo";
const DEFAULT_BRANCH = "main";
const BRANCH = "feature";
const WORKSPACE = toWorkspaceId(PROJECT, BRANCH);

const HAYSTACK = "haystack.txt";
const LINE_COUNT = 40;

// Desktop viewport so `SharedDockviewLayout` (which mounts SearchFilesDialog
// and listens for `band:open-search-files`) renders.
test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome: string | undefined;

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  const repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", DEFAULT_BRANCH], tmpHome);

  // One file, 40 lines. Odd lines match only "alpha"; even lines also match
  // "alpha beta". Within a single file ripgrep emits matches in line order, so
  // row 1..40 order is deterministic regardless of directory-walk order.
  let content = "";
  for (let i = 1; i <= LINE_COUNT; i++) {
    content += i % 2 === 0 ? `alpha beta marker row ${i}\n` : `alpha marker row ${i}\n`;
  }
  writeFileSync(join(repoPath, HAYSTACK), content);

  git(repoPath, ["add", "."], tmpHome);
  git(repoPath, ["commit", "-m", "seed search-files corpus"], tmpHome);

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

test.describe("Search in Files selection reset on query change", () => {
  test("changing the query snaps selection to the first result and scrolls the list to the top", async ({
    page,
  }) => {
    // Navigating to the last of 40 rows is ~40 sequential ArrowDown round-trips
    // plus an up-to-8s stability poll; give slow CI headroom over the 30s default.
    test.setTimeout(90_000);
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForReady();

    await workspacePage.openSearchFiles();

    // Query 1: "alpha" — matches every line (40 rows).
    await workspacePage.typeSearchFiles("alpha");
    await expect.poll(() => workspacePage.searchFilesItems.count()).toBe(LINE_COUNT);

    // The deepest row (the last even line) is a survivor of the "alpha beta"
    // refinement. Grab it dynamically and drive the selection down to it, so a
    // non-first row is selected with the list scrolled off the top.
    const itemsBefore = await workspacePage.searchFilesItemValues();
    const target = itemsBefore[itemsBefore.length - 1];
    expect(target).toContain("beta"); // survives the refinement (still mounts)
    expect(target).not.toBe(itemsBefore[0]); // not already the first row

    await workspacePage.navigateSearchFilesTo(target);
    await expect.poll(() => workspacePage.selectedSearchFilesValue()).toBe(target);
    await expect.poll(() => workspacePage.searchFilesListScrollTop()).toBeGreaterThan(0);

    // Query 2: refine to "alpha beta" by APPENDING " beta" so `target` stays
    // continuously mounted — the 20 odd-line matches drop out (20 survive), but
    // `target` survives and is no longer first. Pre-fix, the highlight would
    // stay on `target` (it never unmounted) and the list stay scrolled down.
    await workspacePage.appendSearchFiles(" beta");
    await expect.poll(() => workspacePage.searchFilesItems.count()).toBe(LINE_COUNT / 2);

    // Post-fix: once the new result set settles, the selection is on the FIRST
    // row and the list is scrolled to the top. We wait for the *settled*
    // selection rather than a transient one — the pre-fix dialog briefly
    // highlights the first row while React re-renders, then snaps the highlight
    // back to the stale surviving row (`target`), so a plain `expect.poll` for
    // "selection is first" would pass on that transient and miss the bug.
    const settled = await workspacePage.settledSelectedSearchFilesValue();
    const items = await workspacePage.searchFilesItemValues();
    expect(settled).toBe(items[0]);
    expect(settled).not.toBe(target);
    await expect.poll(() => workspacePage.searchFilesListScrollTop()).toBe(0);
  });

  test("arrow keys move the selection and Enter opens the highlighted (first) result", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForReady();

    await workspacePage.openSearchFiles();
    await workspacePage.typeSearchFiles("alpha beta");
    await expect.poll(() => workspacePage.searchFilesItems.count()).toBe(LINE_COUNT / 2);

    // Fresh results → first row selected.
    const items = await workspacePage.searchFilesItemValues();
    const firstValue = items[0];
    await expect.poll(() => workspacePage.selectedSearchFilesValue()).toBe(firstValue);

    // Down then up returns to the first row — keyboard navigation still works.
    await workspacePage.pressSearchFilesKey("ArrowDown");
    await expect.poll(() => workspacePage.selectedSearchFilesValue()).toBe(items[1]);
    await workspacePage.pressSearchFilesKey("ArrowUp");
    await expect.poll(() => workspacePage.selectedSearchFilesValue()).toBe(firstValue);

    // Enter opens the highlighted (first) match. The value is `file:line:content`;
    // the open is observable through the persisted open-tabs state, whose active
    // entry carries the opened file path (a `path:line` location).
    // Assert the positive new state (the tab opened) first, then that the
    // dialog closed.
    const firstFile = firstValue.split(":")[0];
    await workspacePage.pressSearchFilesKey("Enter");
    await expect
      .poll(async () => (await workspacePage.readOpenTabsState(WORKSPACE))?.active, {
        timeout: 15_000,
      })
      .toContain(firstFile);
    await expect(workspacePage.searchFilesDialog()).toBeHidden();
  });
});
