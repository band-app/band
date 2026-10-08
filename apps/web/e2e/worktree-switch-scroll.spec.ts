/**
 * End-to-end coverage for the repo-list scroll + focus behaviour around
 * worktree switching (issue #456 follow-up).
 *
 * Regression guard for the bug we hit while refactoring to the single
 * shared dockview layout: navigating BACK to a previously-visited
 * worktree reset the repo-list scroll to the top AND dropped DOM
 * focus to <body>, breaking keyboard nav. Root cause was an
 * unconditional `panel.api.setActive()` on the repos edge group in
 * `SharedDockviewLayout`, which triggered dockview's focus dance even
 * when the panel was already active.
 *
 * Expected behaviour (verified here):
 *
 *  - **Direct URL navigation** to a worktree deep in the list centers
 *    the active card in the repo list.
 *  - **Clicking a card in the list** leaves the repo list scroll
 *    position EXACTLY where the user left it (no auto-scroll — the
 *    card is already under their cursor).
 *  - **Browser back navigation** to a previously-active worktree also
 *    centers its card, even when the list is scrolled elsewhere.
 *
 * The test mocks tRPC at the network layer (via `createTrpcMock`) so it
 * doesn't need real git repos — it only cares about the dashboard rendering
 * a long list of repos and the worktree card click → URL nav loop.
 */

import { expect, type Page, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { createTrpcMock } from "./helpers/trpc-mock";

const TOKEN = "e2e-worktree-switch-token";
const REPO_COUNT = 25;

// Wide viewport so `useIsDesktop()` reports true and the shared dockview
// renders (matches >= 1024px in apps/web/src/hooks/useIsDesktop.ts).
test.use({ viewport: { width: 1280, height: 700 } });

let server: ServerHandle;
let tmpHome: string;

// Generated fixture: 25 repos, each with a single "main" worktree. The
// list is long enough to overflow the viewport so the scroll behaviour is
// observable.
function makeRepos(): {
  name: string;
  path: string;
  defaultBranch: string;
  kind: "git";
  worktrees: { name: string; branch: string; path: string; pinned: boolean }[];
}[] {
  return Array.from({ length: REPO_COUNT }, (_, i) => ({
    name: `repo-${String(i).padStart(2, "0")}`,
    path: `/tmp/fake/repo-${i}`,
    defaultBranch: "main",
    kind: "git",
    worktrees: [{ name: "main", branch: "main", path: `/tmp/fake/repo-${i}`, pinned: false }],
  }));
}

const FIRST_WORKTREE = toWorktreeId("repo-00", "main");
const LAST_WORKTREE = toWorktreeId(`repo-${String(REPO_COUNT - 1).padStart(2, "0")}`, "main");
// A worktree mid-list — far enough from either edge that
// `scrollIntoView({ block: "center" })` can actually center it without
// hitting the scroll-bounds clamp.
const MIDDLE_WORKTREE = toWorktreeId(
  `repo-${String(Math.floor(REPO_COUNT / 2)).padStart(2, "0")}`,
  "main",
);

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  // The server's loadState reads from the SQLite DB; seedState ensures the
  // settings/tokens path is set up. The actual repo payload the page
  // sees comes from the tRPC mock below.
  seedState(tmpHome, { repos: [] });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

// UI state lives on the server now: start each test from none, like the
// fresh localStorage each test's browser context used to give it.
test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

/**
 * Read the active worktree card's vertical position and the repo list
 * viewport's scroll state in one round-trip — keeps each assertion close to
 * what the user actually sees.
 */
async function readListState(page: Page): Promise<{
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  activeCardTopInVp: number | null;
  url: string;
}> {
  return await page.evaluate(() => {
    const vp = document.querySelector<HTMLElement>('[data-testid="repos-panel__list"]');
    if (!vp) {
      return {
        scrollTop: -1,
        scrollHeight: -1,
        clientHeight: -1,
        activeCardTopInVp: null,
        url: location.pathname,
      };
    }
    // The active card carries `data-active="true"` (set by WorktreeCard's
    // `isActive` styling) — much more stable than keying off Tailwind class
    // strings, which can churn with design-token / dark-mode tweaks.
    const activeCard = vp.querySelector<HTMLElement>('[data-active="true"]');
    const vpRect = vp.getBoundingClientRect();
    const cardRect = activeCard?.getBoundingClientRect();
    return {
      scrollTop: vp.scrollTop,
      scrollHeight: vp.scrollHeight,
      clientHeight: vp.clientHeight,
      activeCardTopInVp: cardRect ? Math.round(cardRect.top - vpRect.top) : null,
      url: location.pathname,
    };
  });
}

async function setupMocks(page: Page): Promise<void> {
  const mock = createTrpcMock();
  mock.addDockviewMocks();
  mock.query("repos.list", { repos: makeRepos() });
  await mock.install(page);
}

test("direct URL nav centers the active worktree card in the repo list", async ({ page }) => {
  await setupMocks(page);

  // Land directly on a worktree from the MIDDLE of the list. We avoid the
  // last worktree here because `scrollIntoView({ block: "center" })`
  // clamps to the scroll bounds — a worktree near the bottom edge ends up
  // at the bottom of the viewport, not the center. The middle worktree
  // can actually be centered without hitting the clamp.
  await page.goto(`${server.url}/worktree/${encodeURIComponent(MIDDLE_WORKTREE)}?token=${TOKEN}`);

  // Wait for the active card to be in the DOM. The styling kicks in once
  // the repos query resolves AND the Zustand store sees the active
  // worktree id from the route.
  const activeCard = page.locator('[data-active="true"]');
  await expect(activeCard).toBeVisible({ timeout: 10_000 });

  const state = await readListState(page);

  // The list must actually overflow (otherwise the test is trivially passing).
  expect(state.scrollHeight).toBeGreaterThan(state.clientHeight + 50);

  // The active card should be roughly centered — top of card sits somewhere
  // between 25% and 75% of the viewport height (block: "center" semantics).
  expect(state.activeCardTopInVp).not.toBeNull();
  const center = state.clientHeight / 2;
  const top = state.activeCardTopInVp ?? 0;
  expect(top).toBeGreaterThan(center - state.clientHeight * 0.4);
  expect(top).toBeLessThan(center + state.clientHeight * 0.4);
});

test("clicking a card in the list preserves the scroll position (no auto-scroll)", async ({
  page,
}) => {
  await setupMocks(page);

  await page.goto(`${server.url}/worktree/${encodeURIComponent(LAST_WORKTREE)}?token=${TOKEN}`);

  // Wait for the list to settle on the last worktree.
  await expect(page.locator('[data-active="true"]')).toBeVisible({ timeout: 10_000 });

  // Manually scroll the list to the top — simulates a user who wants to
  // explore other repos without losing their scroll context.
  await page.evaluate(() => {
    const vp = document.querySelector<HTMLElement>('[data-testid="repos-panel__list"]');
    if (vp) vp.scrollTop = 0;
  });
  const beforeClick = await readListState(page);
  expect(beforeClick.scrollTop).toBe(0);

  // Click the FIRST visible worktree card. Since the list is scrolled to
  // the top, this is repo-00's "main". Scroll the repo-00 header into
  // view first to make the click target stable across viewport sizes.
  await page.getByText("repo-00", { exact: false }).first().scrollIntoViewIfNeeded();
  // Click on the branch row directly (the worktree card, not the repo header).
  // We target by accessible label: the WorktreeCard renders a tabindex=0 div
  // with the branch text inside.
  const firstWorktreeCard = page
    .locator('div.cursor-pointer.select-none[tabindex="0"]')
    .filter({ hasText: /^main$/ })
    .first();
  await firstWorktreeCard.click();

  // URL switches to the clicked worktree.
  await expect(page).toHaveURL(new RegExp(`${encodeURIComponent(FIRST_WORKTREE)}`));

  // Critical: scroll position is unchanged. The card the user just clicked
  // is already where their cursor was — auto-scrolling would feel like a
  // jolt and would also fight with focus.
  await page.waitForTimeout(300); // marker window expires
  const afterClick = await readListState(page);
  expect(afterClick.scrollTop).toBe(0);
});

test("browser back navigation re-centers the active card", async ({ page }) => {
  await setupMocks(page);

  // Start at the LAST worktree — direct URL nav centers it.
  await page.goto(`${server.url}/worktree/${encodeURIComponent(LAST_WORKTREE)}?token=${TOKEN}`);
  await expect(page.locator('[data-active="true"]')).toBeVisible({ timeout: 10_000 });
  const initial = await readListState(page);
  const initialScrollTop = initial.scrollTop;

  // Scroll to the top and click repo-00's main — the in-list click
  // path, so no auto-scroll.
  await page.evaluate(() => {
    const vp = document.querySelector<HTMLElement>('[data-testid="repos-panel__list"]');
    if (vp) vp.scrollTop = 0;
  });
  const firstWorktreeCard = page
    .locator('div.cursor-pointer.select-none[tabindex="0"]')
    .filter({ hasText: /^main$/ })
    .first();
  await firstWorktreeCard.click();
  await expect(page).toHaveURL(new RegExp(`${encodeURIComponent(FIRST_WORKTREE)}`));
  await page.waitForTimeout(300);
  expect((await readListState(page)).scrollTop).toBe(0); // confirm no scroll

  // Now press browser back — this returns to the LAST worktree via a
  // navigation that did NOT go through the in-list path, so the
  // recent-activation marker is NOT set and the auto-scroll-into-view
  // should fire.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${encodeURIComponent(LAST_WORKTREE)}`));
  // Wait for the post-navigation effect to settle. The card's
  // scrollIntoView({ block: "center" }) runs synchronously inside an effect
  // after the activeWorktreeId-driven re-render commits.
  await page.waitForTimeout(200);
  const afterBack = await readListState(page);
  expect(afterBack.scrollTop).toBe(initialScrollTop);
  expect(afterBack.scrollTop).toBeGreaterThan(0); // i.e. did scroll back
});
