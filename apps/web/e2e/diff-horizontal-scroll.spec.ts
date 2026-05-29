/**
 * End-to-end coverage for horizontal scrolling in the Changes view.
 *
 * Long lines (minified JS, generated SQL, base64 payloads, etc.) used
 * to be silently clipped by `overflow-clip` on `LazyFileRow`'s root
 * because the naturalHeight CodeMirror config set
 * `.cm-scroller { overflow: visible }` on both axes. The fix in
 * `baseViewerExtensions` switches the scroller to
 * `overflowX: auto, height: auto` (overflowY is left to default to
 * `visible` so the browser's CSS Overflow L3 resolution to `auto` is
 * what lands at runtime — see `codemirror-setup.ts` for the full
 * rationale). Horizontal scrolling works while the vertical axis
 * still flows with the auto-height parent chain (no regression of
 * PR #501).
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
 * `pages/ChangesPanelPage.ts`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { git } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChangesPanelPage } from "./pages/ChangesPanelPage";

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
// at our 2400-px viewport, even after accounting for the project
// sidebar, chat panel, file tree, gutters, and padding. Repeating
// `the_quick_brown_fox_jumps_over_the_lazy_dog_` (44 chars) 30× gives a
// ~1300-char line, roughly 8000 px in a 13-px monospaced font — well
// past the ~800–900 px the editor pane gets inside the dockview at
// the 2400 viewport.
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
  cleanupTmpHome(tmpHome);
});

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
  //    unified mode).
  const overflowing = metrics.find((m) => m.scrollWidth > m.clientWidth);
  expect(overflowing).toBeDefined();
  // 3. Natural-height guard on the overflowing scroller — no
  //    internal vertical scrollbar (`scrollHeight` ≈ `clientHeight`)
  //    and a non-trivial height. This is what guards against PR
  //    #501's natural-height fix regressing in tandem with this
  //    horizontal-scroll change — if `height: auto` ever dropped off
  //    `.cm-scroller`, content would overflow vertically and
  //    `scrollHeight` would diverge from `clientHeight` by far more
  //    than the 1-px subpixel-rounding tolerance below. We allow
  //    that 1-px slop because some browsers / device-pixel ratios
  //    round `scrollHeight` up by one even when there's no actual
  //    overflow.
  expect(overflowing!.clientHeight).toBeGreaterThan(20);
  expect(overflowing!.scrollHeight).toBeLessThanOrEqual(overflowing!.clientHeight + 1);

  // 4. Round-trip a horizontal scroll on the overflowing scroller.
  //    Unified mode has a single scroller; split mode puts the
  //    "before" scroller first and the overflowing "after" scroller
  //    second. The page object owns the locator chain — the spec just
  //    asks for "scroll the Nth scroller and tell me what scrollLeft
  //    landed at", per the integration-test doctrine.
  const overflowingIndex = metrics.findIndex((m) => m.scrollWidth > m.clientWidth);
  const finalScrollLeft = await changes.roundTripScrollLeftAt(overflowingIndex, 200);
  expect(finalScrollLeft).toBeGreaterThan(0);
}

test("Changes view scrolls horizontally (unified mode)", async ({ page }) => {
  const changes = await ChangesPanelPage.openWithFileExpanded({
    page,
    baseUrl: server.url,
    token: TOKEN,
    workspaceId,
    filename: FILE_PATH,
    fileStatus: "M",
    viewMode: "unified",
  });
  // Unified mode renders one `.cm-scroller` per visible expanded file.
  await expect(changes.cmScrollers).toHaveCount(1, { timeout: 15_000 });
  await assertScrollerHorizontallyScrolls(changes);
});

test("Changes view scrolls horizontally (split mode)", async ({ page }) => {
  const changes = await ChangesPanelPage.openWithFileExpanded({
    page,
    baseUrl: server.url,
    token: TOKEN,
    workspaceId,
    filename: FILE_PATH,
    fileStatus: "M",
    viewMode: "split",
  });
  // Split mode (MergeView) renders TWO scrollers per file — one for
  // the "before" side and one for the "after" side. The fix has to
  // apply to both since both editors go through
  // `baseViewerExtensions(..., { naturalHeight: true })`.
  await expect(changes.cmScrollers).toHaveCount(2, { timeout: 15_000 });
  await assertScrollerHorizontallyScrolls(changes);
});
