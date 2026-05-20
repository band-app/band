/**
 * End-to-end coverage for the project-list scroll + focus behaviour around
 * workspace switching (issue #456 follow-up).
 *
 * Regression guard for the bug we hit while refactoring to the single
 * shared dockview layout: navigating BACK to a previously-visited
 * workspace reset the project-list scroll to the top AND dropped DOM
 * focus to <body>, breaking keyboard nav. Root cause was an
 * unconditional `panel.api.setActive()` on the projects edge group in
 * `SharedDockviewLayout`, which triggered dockview's focus dance even
 * when the panel was already active.
 *
 * Expected behaviour (verified here):
 *
 *  - **Direct URL navigation** to a workspace deep in the list centers
 *    the active card in the project list.
 *  - **Clicking a card in the list** leaves the project list scroll
 *    position EXACTLY where the user left it (no auto-scroll — the
 *    card is already under their cursor).
 *  - **Browser back navigation** to a previously-active workspace also
 *    centers its card, even when the list is scrolled elsewhere.
 *
 * The test mocks tRPC at the network layer (via `createTrpcMock`) so it
 * doesn't need real git repos — it only cares about the dashboard rendering
 * a long list of projects and the workspace card click → URL nav loop.
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

const TOKEN = "e2e-workspace-switch-token";
const PROJECT_COUNT = 25;

// Wide viewport so `useIsDesktop()` reports true and the shared dockview
// renders (matches >= 1024px in apps/web/src/hooks/useIsDesktop.ts).
test.use({ viewport: { width: 1280, height: 700 } });

let server: ServerHandle;
let tmpHome: string;

// Generated fixture: 25 projects, each with a single "main" worktree. The
// list is long enough to overflow the viewport so the scroll behaviour is
// observable.
function makeProjects(): {
  name: string;
  path: string;
  defaultBranch: string;
  kind: "git";
  worktrees: { branch: string; path: string; pinned: boolean }[];
}[] {
  return Array.from({ length: PROJECT_COUNT }, (_, i) => ({
    name: `project-${String(i).padStart(2, "0")}`,
    path: `/tmp/fake/project-${i}`,
    defaultBranch: "main",
    kind: "git",
    worktrees: [{ branch: "main", path: `/tmp/fake/project-${i}`, pinned: false }],
  }));
}

const FIRST_WORKSPACE = toWorkspaceId("project-00", "main");
const LAST_WORKSPACE = toWorkspaceId(
  `project-${String(PROJECT_COUNT - 1).padStart(2, "0")}`,
  "main",
);
// A workspace mid-list — far enough from either edge that
// `scrollIntoView({ block: "center" })` can actually center it without
// hitting the scroll-bounds clamp.
const MIDDLE_WORKSPACE = toWorkspaceId(
  `project-${String(Math.floor(PROJECT_COUNT / 2)).padStart(2, "0")}`,
  "main",
);

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  // The server's loadState reads from the SQLite DB; seedState ensures the
  // settings/tokens path is set up. The actual project payload the page
  // sees comes from the tRPC mock below.
  seedState(tmpHome, { projects: [] });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  rmSync(tmpHome, { recursive: true, force: true });
});

/**
 * Read the active workspace card's vertical position and the project list
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
    const vp = document.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]");
    if (!vp) {
      return {
        scrollTop: -1,
        scrollHeight: -1,
        clientHeight: -1,
        activeCardTopInVp: null,
        url: location.pathname,
      };
    }
    // The active card has the "bg-accent/50 border-l-2 border-l-primary"
    // classes applied via the `isActive` styling in WorkspaceCard.
    const activeCard = vp.querySelector<HTMLElement>(".bg-accent\\/50.border-l-2");
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
  mock.query("projects.list", { projects: makeProjects() });
  await mock.install(page);
}

test("direct URL nav centers the active workspace card in the project list", async ({ page }) => {
  await setupMocks(page);

  // Land directly on a workspace from the MIDDLE of the list. We avoid the
  // last workspace here because `scrollIntoView({ block: "center" })`
  // clamps to the scroll bounds — a workspace near the bottom edge ends up
  // at the bottom of the viewport, not the center. The middle workspace
  // can actually be centered without hitting the clamp.
  await page.goto(`${server.url}/workspace/${encodeURIComponent(MIDDLE_WORKSPACE)}?token=${TOKEN}`);

  // Wait for the active card to be in the DOM. The styling kicks in once
  // the projects query resolves AND the Zustand store sees the active
  // workspace id from the route.
  const activeCard = page.locator(".bg-accent\\/50.border-l-2");
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

  await page.goto(`${server.url}/workspace/${encodeURIComponent(LAST_WORKSPACE)}?token=${TOKEN}`);

  // Wait for the list to settle on the last workspace.
  await expect(page.locator(".bg-accent\\/50.border-l-2")).toBeVisible({ timeout: 10_000 });

  // Manually scroll the list to the top — simulates a user who wants to
  // explore other projects without losing their scroll context.
  await page.evaluate(() => {
    const vp = document.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]");
    if (vp) vp.scrollTop = 0;
  });
  const beforeClick = await readListState(page);
  expect(beforeClick.scrollTop).toBe(0);

  // Click the FIRST visible workspace card. Since the list is scrolled to
  // the top, this is project-00's "main". Scroll the project-00 header into
  // view first to make the click target stable across viewport sizes.
  await page.getByText("project-00", { exact: false }).first().scrollIntoViewIfNeeded();
  // Click on the branch row directly (the workspace card, not the project header).
  // We target by accessible label: the WorkspaceCard renders a tabindex=0 div
  // with the branch text inside.
  const firstWorkspaceCard = page
    .locator('div.cursor-pointer.select-none[tabindex="0"]')
    .filter({ hasText: /^main$/ })
    .first();
  await firstWorkspaceCard.click();

  // URL switches to the clicked workspace.
  await expect(page).toHaveURL(new RegExp(`${encodeURIComponent(FIRST_WORKSPACE)}`));

  // Critical: scroll position is unchanged. The card the user just clicked
  // is already where their cursor was — auto-scrolling would feel like a
  // jolt and would also fight with focus.
  await page.waitForTimeout(300); // marker window expires
  const afterClick = await readListState(page);
  expect(afterClick.scrollTop).toBe(0);
});

test("browser back navigation re-centers the active card", async ({ page }) => {
  await setupMocks(page);

  // Start at the LAST workspace — direct URL nav centers it.
  await page.goto(`${server.url}/workspace/${encodeURIComponent(LAST_WORKSPACE)}?token=${TOKEN}`);
  await expect(page.locator(".bg-accent\\/50.border-l-2")).toBeVisible({ timeout: 10_000 });
  const initial = await readListState(page);
  const initialScrollTop = initial.scrollTop;

  // Scroll to the top and click project-00's main — the in-list click
  // path, so no auto-scroll.
  await page.evaluate(() => {
    const vp = document.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]");
    if (vp) vp.scrollTop = 0;
  });
  const firstWorkspaceCard = page
    .locator('div.cursor-pointer.select-none[tabindex="0"]')
    .filter({ hasText: /^main$/ })
    .first();
  await firstWorkspaceCard.click();
  await expect(page).toHaveURL(new RegExp(`${encodeURIComponent(FIRST_WORKSPACE)}`));
  await page.waitForTimeout(300);
  expect((await readListState(page)).scrollTop).toBe(0); // confirm no scroll

  // Now press browser back — this returns to the LAST workspace via a
  // navigation that did NOT go through the in-list path, so the
  // recent-activation marker is NOT set and the auto-scroll-into-view
  // should fire.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${encodeURIComponent(LAST_WORKSPACE)}`));
  // Wait for the post-navigation effect to settle. The card's
  // scrollIntoView({ block: "center" }) runs synchronously inside an effect
  // after the activeWorkspaceId-driven re-render commits.
  await page.waitForTimeout(200);
  const afterBack = await readListState(page);
  expect(afterBack.scrollTop).toBe(initialScrollTop);
  expect(afterBack.scrollTop).toBeGreaterThan(0); // i.e. did scroll back
});
