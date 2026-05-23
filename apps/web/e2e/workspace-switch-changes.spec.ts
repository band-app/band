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
import { expect, type Page, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
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

test("switch A → B → A keeps the Changes panel populated (no Loading flash)", async ({ page }) => {
  const { counters } = await setupMocks(page);

  // Land on workspace A. The default dockview layout puts the Changes
  // panel at the top of the right group, so its content renders without
  // an explicit tab click.
  await page.goto(`${server.url}/workspace/${encodeURIComponent(WORKSPACE_A)}?token=${TOKEN}`);
  await expectChangesFileVisible(page, FILE_IN_A);

  // Switch to workspace B via the project list (in-list click, same path
  // the user takes). The card markup follows the WorkspaceCard structure
  // used in workspace-switch-scroll.spec.ts. Workspace cards only contain
  // the branch label ("main") — the project name lives on a separate
  // header element — so we can't disambiguate by project name from the
  // card itself. Project order is fixed by `projects.list`'s mock payload
  // above, so positional `.nth()` is stable.
  const workspaceBCard = page
    .locator('div.cursor-pointer.select-none[tabindex="0"]')
    .filter({ hasText: /^main$/ })
    .nth(1); // Project A's card is index 0, Project B's is index 1
  await workspaceBCard.click();
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(WORKSPACE_B)));
  await expectChangesFileVisible(page, FILE_IN_B);

  // Confirm A's diff-summary fetched at least once on the initial load —
  // anchors the rest of the test against an actual data-bearing fetch
  // rather than a fluke-zero counter from a never-rendered panel.
  expect(counters.byWorkspace.get(WORKSPACE_A) ?? 0).toBeGreaterThan(0);

  // Plant a MutationObserver on `document.body` so we can catch a
  // transient "Loading changes..." appearance across the switch-back. An
  // auto-retrying `toHaveCount(0)` would happily pass over a one-frame
  // flash; the observer records every textContent change for the window
  // we care about, so a single moment of loading is enough to fail.
  //
  // The exact literal `"Loading changes..."` (three ASCII periods, NOT a
  // Unicode `…` ellipsis) is what DiffView.tsx renders — see the JSX at
  // line 2013. Some surrounding comments use the Unicode form which can
  // mislead linters / reviewers; the observer matches what reaches the
  // DOM, which is the ASCII variant.
  await page.evaluate(() => {
    interface LoadingFlashRecorder {
      observed: boolean;
      observer: MutationObserver;
    }
    const recorder: LoadingFlashRecorder = {
      observed: document.body.textContent?.includes("Loading changes...") ?? false,
      observer: new MutationObserver(() => {
        if (document.body.textContent?.includes("Loading changes...")) {
          recorder.observed = true;
        }
      }),
    };
    recorder.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    (window as unknown as { __loadingFlashRecorder: LoadingFlashRecorder }).__loadingFlashRecorder =
      recorder;
  });

  // Switch back to A. With the bug this would flash "Loading changes…"
  // and re-fetch the summary. With the fix the cached DiffView for A
  // stays put — its file row is still in the DOM (opacity-faded under
  // B's panel) and we should see it without any Loading transition.
  const workspaceACard = page
    .locator('div.cursor-pointer.select-none[tabindex="0"]')
    .filter({ hasText: /^main$/ })
    .nth(0);
  await workspaceACard.click();
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(WORKSPACE_A)));

  // Settle on a behavioral anchor: A's cached file row becomes VISIBLE
  // again (its panel div flips from opacity:0 back to opacity:1 inside
  // MultiWorkspacePanelHost). This is sturdier than a wall-clock
  // `waitForTimeout` and avoids the `[data-active="true"]` race —
  // `data-active` lives on workspace cards which can flip synchronously
  // with the URL change, before React commits the loading state.
  await expectChangesFileVisible(page, FILE_IN_A);

  const flashObserved = await page.evaluate(() => {
    const w = window as unknown as {
      __loadingFlashRecorder: { observed: boolean; observer: MutationObserver };
    };
    // Disconnect now that we're done — Playwright isolates page contexts
    // per test so there's no cross-test leak, but the live observer
    // shows up as DevTools noise during local debugging.
    w.__loadingFlashRecorder.observer.disconnect();
    return w.__loadingFlashRecorder.observed;
  });
  expect(flashObserved).toBe(false);
});
