/**
 * End-to-end coverage for the Changes panel surviving workspace switches
 * after PR #461's per-workspace content caching (issue #484).
 *
 * Switching workspace A → B → A used to flash "Loading changes…" and wipe
 * the file list / per-file diff cache for A — every `active: false → true`
 * flip caused the DiffView fetch effect to re-run because `active` was in
 * its dep array. The fix splits the data-fetch effect from the SSE
 * subscription effect so the data fetch runs once per workspace/target
 * change, and only the lightweight subscription comes/goes with `active`.
 *
 * Modeled on `workspace-switch-scroll.spec.ts` — same `createTrpcMock` +
 * multi-workspace fixture, no real git repos needed.
 */

import { rmSync } from "node:fs";
import { toWorkspaceId } from "@band-app/dashboard-core";
import { expect, type Page, test } from "@playwright/test";
import {
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { createTrpcMock } from "./helpers/trpc-mock";

const TOKEN = "e2e-workspace-switch-changes-token";

// Wide viewport so `useIsDesktop()` reports true and the shared dockview
// renders (matches >= 1024px in apps/web/src/hooks/useIsDesktop.ts). This
// is the layout that uses MultiWorkspacePanelHost's per-workspace cache —
// the mobile layout doesn't cache at all, so the bug only repros here.
test.use({ viewport: { width: 1280, height: 800 } });

const PROJECT_A = "alpha-repo";
const PROJECT_B = "bravo-repo";
const FILE_IN_A = "src/alpha.ts";
const FILE_IN_B = "src/bravo.ts";

const WORKSPACE_A = toWorkspaceId(PROJECT_A, "main");
const WORKSPACE_B = toWorkspaceId(PROJECT_B, "main");

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  // The DB seed is only used by `loadState` — the page itself sees the
  // mocked tRPC payload registered below. We still seed an empty projects
  // list so the auth/token bootstrap path is happy.
  seedState(tmpHome, { projects: [] });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  rmSync(tmpHome, { recursive: true, force: true });
});

interface DiffSummaryCounters {
  /** Total `workspace.getDiffSummary` calls per workspace ID. */
  byWorkspace: Map<string, number>;
}

interface MockHandles {
  counters: DiffSummaryCounters;
}

async function setupMocks(page: Page): Promise<MockHandles> {
  const mock = createTrpcMock();
  mock.addDockviewMocks();

  // Two projects, each with a single "main" worktree. Branch label matches
  // toWorkspaceId(...) above.
  mock.query("projects.list", {
    projects: [
      {
        name: PROJECT_A,
        path: `/tmp/fake/${PROJECT_A}`,
        defaultBranch: "main",
        kind: "git",
        worktrees: [{ branch: "main", path: `/tmp/fake/${PROJECT_A}`, pinned: false }],
      },
      {
        name: PROJECT_B,
        path: `/tmp/fake/${PROJECT_B}`,
        defaultBranch: "main",
        kind: "git",
        worktrees: [{ branch: "main", path: `/tmp/fake/${PROJECT_B}`, pinned: false }],
      },
    ],
  });

  const counters: DiffSummaryCounters = { byWorkspace: new Map() };

  // Per-workspace diff payload — one file each, so we can assert on a
  // workspace-specific filename. The `branch` diff mode is what the
  // DiffView defaults to on first mount; we return the same payload
  // regardless of compareBranch so the dropdown's "uncommitted" pick
  // doesn't accidentally land on an empty state.
  mock.query("workspace.getDiffSummary", (input) => {
    const workspaceId = input.workspaceId;
    counters.byWorkspace.set(workspaceId, (counters.byWorkspace.get(workspaceId) ?? 0) + 1);

    const file = workspaceId === WORKSPACE_A ? FILE_IN_A : FILE_IN_B;
    return {
      stats: { filesChanged: 1, insertions: 5, deletions: 2 },
      compareBranch: "main",
      defaultBranch: "main",
      headBranch: "feat/something",
      fileStatuses: { [file]: "M" },
      mergeBase: "deadbeef".repeat(5),
    };
  });

  // Branches list — needed so the Diff target dropdown renders without
  // errors. Returning the default-only list keeps things simple.
  mock.query("workspace.listBranches", () => ({
    branches: ["main"],
    defaultBranch: "main",
    headBranch: "feat/something",
  }));

  // Per-file diff — the LazyFileRow doesn't auto-expand on first paint, but
  // the diff cache code reads through this if the user clicks. Returning an
  // empty hunk list keeps the assertion on filename row visibility
  // independent of expand state.
  mock.query("workspace.getFileDiff", () => ({
    hunks: [],
    truncated: false,
  }));

  await mock.install(page);
  return { counters };
}

/**
 * Wait for the Changes panel to render `filename`. The DiffView renders
 * the filename inside a monospaced span next to a status badge; matching
 * the exact string is more robust than keying on class names.
 */
async function expectChangesFileVisible(page: Page, filename: string): Promise<void> {
  await expect(page.getByText(filename, { exact: false })).toBeVisible({ timeout: 10_000 });
}

test("switch A → B → A keeps the Changes panel populated (no Loading flash, no refetch)", async ({
  page,
}) => {
  const { counters } = await setupMocks(page);

  // Land on workspace A. The default dockview layout puts the Changes
  // panel at the top of the right group, so its content renders without
  // an explicit tab click.
  await page.goto(`${server.url}/workspace/${encodeURIComponent(WORKSPACE_A)}?token=${TOKEN}`);
  await expectChangesFileVisible(page, FILE_IN_A);

  // Capture A's diff-summary call count immediately after the file row
  // appears. With the bug, this is 2 (tab badge + DiffView). With the
  // fix, it's also 2 — the difference shows up on the switch BACK.
  const aCallsAfterFirstLoad = counters.byWorkspace.get(WORKSPACE_A) ?? 0;
  expect(aCallsAfterFirstLoad).toBeGreaterThan(0);

  // Switch to workspace B via the project list (in-list click, same path
  // the user takes). The card markup follows the WorkspaceCard structure
  // used in workspace-switch-scroll.spec.ts.
  const workspaceBCard = page
    .locator('div.cursor-pointer.select-none[tabindex="0"]')
    .filter({ hasText: /^main$/ })
    .nth(1); // Project A's card is index 0, Project B's is index 1
  await workspaceBCard.click();
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(WORKSPACE_B)));
  await expectChangesFileVisible(page, FILE_IN_B);

  // Now switch back to A. With the bug this would have flashed
  // "Loading changes…" and re-fetched the summary. With the fix the
  // cached DiffView for A stays put — its file row is still in the DOM
  // (just opacity-faded under B's panel) and we should see it
  // immediately after the activeWorkspaceId flips.
  const workspaceACard = page
    .locator('div.cursor-pointer.select-none[tabindex="0"]')
    .filter({ hasText: /^main$/ })
    .nth(0);
  await workspaceACard.click();
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(WORKSPACE_A)));

  // The Loading text must NEVER appear during the switch back. We poll
  // a few frames worth of time to give the bug-path a chance to surface,
  // then assert the file row is visible.
  await expect(page.getByText("Loading changes...")).toHaveCount(0);
  await expectChangesFileVisible(page, FILE_IN_A);

  // Count assertion: with the fix, the DiffView for A does not refetch
  // on re-activation. The tab badge's useDiffFileCount in
  // SharedDockviewLayout DOES fetch on `activeWorkspaceId` change (it's a
  // workspace-scoped hook), so A's counter increases by AT MOST 1 across
  // the round-trip. Before the fix, DiffView's own refetch would bump it
  // by 2 (DiffView + badge), so this assertion catches the regression.
  await page.waitForTimeout(500);
  const aCallsAfterSwitchBack = counters.byWorkspace.get(WORKSPACE_A) ?? 0;
  const delta = aCallsAfterSwitchBack - aCallsAfterFirstLoad;
  expect(delta).toBeLessThanOrEqual(1);
});
