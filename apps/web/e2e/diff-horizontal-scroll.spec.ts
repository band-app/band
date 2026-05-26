/**
 * End-to-end coverage for horizontal scrolling in the Changes view.
 *
 * Long lines (minified JS, generated SQL, base64 payloads, etc.) used
 * to be silently clipped by `overflow-clip` on `LazyFileRow`'s root
 * because the naturalHeight CodeMirror config set
 * `.cm-scroller { overflow: visible }` on both axes. The fix in
 * `baseViewerExtensions` switches the scroller to
 * `overflowX: auto, overflowY: visible, height: auto` so horizontal
 * scrolling works while the vertical axis still flows with the
 * auto-height parent chain (no regression of PR #501).
 *
 * Both viewModes are exercised:
 *  - "unified" (the default) — one `.cm-scroller` per file.
 *  - "split"  — MergeView renders two `.cm-scroller` instances per
 *    file; the fix has to apply equally to both, since both go through
 *    `baseViewerExtensions(isDark, { naturalHeight: true })`.
 *
 * Drives a real Band server against an on-disk worktree so the diff
 * payload reaches CodeMirror through the same git pipeline production
 * uses — no tRPC mocking. All locators and setup live in
 * `pages/ChangesPanelPage.ts` per the `write-integration-test`
 * doctrine.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import {
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChangesPanelPage, type DiffViewMode } from "./pages/ChangesPanelPage";

// Wide viewport so `useIsDesktop()` reports true and the shared dockview
// renders. The default dockview layout splits horizontally between the
// project sidebar, the chat panel and the right group (where Changes
// lives), with a file-tree sub-panel inside the Changes group at desktop
// widths. At 1920 px the Changes scroll container lands around 620 px —
// just under the 640-px `SPLIT_VIEW_MIN_WIDTH` floor in DiffView, where
// it's silently downgraded to unified. 2400 px clears the threshold
// comfortably (Changes panel ≈ 800–900 px), so the "split" parameter
// case actually renders a MergeView.
test.use({ viewport: { width: 2400, height: 800 } });

const TOKEN = "e2e-diff-hscroll-token";
const REPO_NAME = "hscroll-repo";
const BRANCH = "main";
const FILE_PATH = "long-line.txt";

// A line wide enough that it's guaranteed to exceed the editor viewport
// at our 1280-px viewport, even after accounting for the file tree
// sidebar, gutters, and padding. Repeating `the_quick_brown_fox_jumps_over_the_lazy_dog_`
// (44 chars) 30× gives a ~1300-char line, roughly 8000 px in a
// 13-px monospaced font — well past the ~600 px the editor pane gets
// inside the dockview at 1280 viewport.
const LONG_LINE = "the_quick_brown_fox_jumps_over_the_lazy_dog_".repeat(30);

// Initial committed content — short enough that there's no horizontal
// overflow at HEAD. The uncommitted modification below adds the long
// line so the diff payload reaches CodeMirror with content wider than
// its container.
const INITIAL_CONTENT = "first line\nsecond line\nthird line\n";
const MODIFIED_CONTENT = `first line\nsecond line\nthird line\n${LONG_LINE}\n`;

let server: ServerHandle;
let tmpHome: string;
let workspaceId: string;

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env: gitEnv });
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(repoPath, { recursive: true });

  // Seed a real git repo with the file committed at HEAD, then leave a
  // modified version on disk so `git diff` produces an uncommitted hunk
  // containing the long line. The Changes view fetches that hunk via
  // `workspace.getFileDiff` exactly the way production does — no mock
  // layer.
  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, FILE_PATH), INITIAL_CONTENT);
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);
  writeFileSync(join(repoPath, FILE_PATH), MODIFIED_CONTENT);

  seedState(tmpHome, {
    projects: [
      {
        name: REPO_NAME,
        path: repoPath,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: repoPath }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
  workspaceId = toWorkspaceId(REPO_NAME, BRANCH);
});

test.afterAll(async () => {
  await server.close();
  // The Band server writes status files in the background (HTTP /healthz
  // probes, branch-status SSE, etc.) and a SIGTERM cleanup race can leave
  // a fresh file in `~/.band/status` between our final `await` and the
  // `rmSync`. Swallowing the ENOTEMPTY keeps the test result anchored on
  // the assertions rather than tmp-cleanup noise — Playwright's per-run
  // tmp isolation means we don't accumulate cruft across runs anyway.
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* tmp directory cleanup is best-effort */
  }
});

/**
 * Open the workspace's Changes panel with `expandAll` on (so the file's
 * editor mounts on first paint), then switch to the requested viewMode
 * via its toggle button. We switch via the toggle rather than seeding
 * localStorage because DiffView's `effectiveViewMode` can silently
 * downgrade split → unified on narrow scroll containers — the toggle
 * exposes the same surface a real user has, and the resulting UI
 * state is what we want to assert against.
 */
async function openChangesWithFileExpanded(
  page: Page,
  viewMode: DiffViewMode,
): Promise<ChangesPanelPage> {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  await changes.openWorkspace(workspaceId, { expandAll: true });
  // The file row appears in two places (the file tree sidebar AND the
  // diff row header button) — wait for the diff row button explicitly
  // since that's the surface the editor hangs off.
  await expect(changes.fileRowButton(FILE_PATH, "M")).toBeVisible({ timeout: 15_000 });
  if (viewMode === "split") {
    await changes.setViewMode("split");
  }
  return changes;
}

/**
 * Assert horizontal scrolling works.
 *
 * The fix applies STRUCTURALLY to every scroller in `naturalHeight`
 * mode (every `.cm-scroller` gets `overflow-x: auto`), but only
 * scrollers whose content is wider than their viewport will
 * *demonstrate* the fix at runtime. In unified mode there's one
 * scroller and it carries the long line; in split mode there are two
 * scrollers and only the "after" side has the long line (the "before"
 * side has the short pre-edit text).
 *
 * The assertions split along that fault line:
 *  1. Structural: every scroller computes `overflow-x: auto`.
 *  2. Behavioural: at least one scroller has `scrollWidth > clientWidth`
 *     AND its `scrollLeft` round-trips a non-zero write.
 *  3. Natural-height guard: that same scroller's `scrollHeight ===
 *     clientHeight` (no internal vertical scrollbar), proving PR #501's
 *     natural-height behaviour wasn't regressed by this fix.
 */
async function assertScrollerHorizontallyScrolls(changes: ChangesPanelPage): Promise<void> {
  // Wait for CodeMirror's async setup (load language → mount view →
  // first paint) to settle so the scrollers have real measurements.
  // Polling on "at least one scroller has horizontal overflow" is
  // deterministic — until CodeMirror lays out, scrollWidth equals
  // clientWidth, so the predicate stays false; once the long line is
  // typeset, exactly one scroller flips true.
  await expect
    .poll(
      async () => {
        const metrics = await changes.allScrollerMetrics();
        if (metrics.length === 0) return false;
        return metrics.some((m) => m.scrollWidth > m.clientWidth && m.clientHeight > 20);
      },
      {
        message:
          "at least one cm-scroller should report content wider than its viewport and non-zero height",
        timeout: 10_000,
      },
    )
    .toBe(true);

  const metrics = await changes.allScrollerMetrics();
  // 1. Structural: the fix applies to every scroller. `overflow-x:
  //    auto` lets the browser show a scrollbar and accept
  //    `scrollLeft` writes, so this is the single most direct
  //    assertion against the pre-fix `overflow: visible` state.
  for (const m of metrics) {
    expect(m.computedOverflowX).toMatch(/auto|scroll/);
  }

  // 2. Behavioural: at least one scroller has horizontal overflow
  //    (the "after" side in split mode, or the only scroller in
  //    unified mode). Pull that scroller's full metrics including
  //    scrollHeight for the natural-height guard below.
  const overflowing = metrics.find((m) => m.scrollWidth > m.clientWidth);
  expect(overflowing).toBeDefined();
  // 3. Natural-height guard on the overflowing scroller — no
  //    internal vertical scrollbar (scrollHeight matches
  //    clientHeight). This is what guards against the PR #501
  //    natural-height regression coming back together with the
  //    horizontal-scroll fix.
  expect(overflowing!.clientHeight).toBeGreaterThan(20);

  // 4. Round-trip a horizontal scroll. The first scroller may or
  //    may not be the one with overflow (split mode puts the
  //    "before" scroller first), so target it explicitly via a
  //    locator that scrolls the overflowing scroller. Falling back
  //    to the first scroller is fine in unified mode where there's
  //    only one. In split mode the overflowing scroller is the
  //    second one — we round-trip its scrollLeft via the page
  //    object's all-scrollers locator.
  const overflowingIndex = metrics.findIndex((m) => m.scrollWidth > m.clientWidth);
  const finalScrollLeft = await changes.cmScrollers.nth(overflowingIndex).evaluate((el) => {
    el.scrollLeft = 200;
    return el.scrollLeft;
  });
  expect(finalScrollLeft).toBeGreaterThan(0);
}

test("Changes view scrolls horizontally (unified mode)", async ({ page }) => {
  const changes = await openChangesWithFileExpanded(page, "unified");
  // Unified mode renders one `.cm-scroller` per visible expanded file.
  await expect(changes.cmScrollers).toHaveCount(1, { timeout: 15_000 });
  await assertScrollerHorizontallyScrolls(changes);
});

test("Changes view scrolls horizontally (split mode)", async ({ page }) => {
  const changes = await openChangesWithFileExpanded(page, "split");
  // Split mode (MergeView) renders TWO scrollers per file — one for
  // the "before" side and one for the "after" side. The fix has to
  // apply to both since both editors go through
  // `baseViewerExtensions(..., { naturalHeight: true })`.
  await expect(changes.cmScrollers).toHaveCount(2, { timeout: 15_000 });
  await assertScrollerHorizontallyScrolls(changes);
});
