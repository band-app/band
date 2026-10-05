/**
 * Coverage for the WorktreePickerDialog, in two groups:
 *
 * 1. "open affordances" — the ways a user opens the picker on desktop: the
 *    ⌘K shortcut (macOS), the Ctrl+K shortcut (Windows/Linux wide-viewport
 *    web), and clicking the desktop title-bar worktree-name button.
 * 2. "pin is separate from select" — the pin/select separation regression
 *    described below.
 *
 * Regression coverage for the WorktreePickerDialog pin/select separation
 * (PR #553). Tapping a row's pin button must toggle the pinned state WITHOUT
 * selecting the worktree — the dialog stays open and the URL doesn't change.
 * Clicking the row body, by contrast, selects the worktree: it navigates and
 * closes the dialog.
 *
 * The bug this guards: cmdk fires a row's `onSelect` from the item's bubbled
 * `onClick`, so an earlier version of the pin button (which only stopped
 * propagation on `mousedown`) let a real click bubble to the item and navigate
 * away. The fix stops propagation on pointerdown/mousedown/click and toggles
 * once on click.
 *
 * Architecture: real production binary against a fresh tmp `~/.band/`, no tRPC
 * mocks. Two repos are seeded into the SQLite DB; the picker lists their
 * worktrees from the real `repos.list` response. Pinning goes through the
 * real `pinnedWorktrees` mutation. All interaction is via page objects.
 */

import { expect, test } from "@playwright/test";
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
import { WorktreePage } from "./pages/WorktreePage";
import { WorktreePicker } from "./pages/WorktreePicker";

const TOKEN = "e2e-worktree-picker-token";

const REPO_ALPHA = "alpha-picker";
const REPO_BETA = "beta-picker";
const REPO_GAMMA = "gamma-picker";

const WS_ALPHA = toWorktreeId(REPO_ALPHA, "main");
const WS_BETA = toWorktreeId(REPO_BETA, "main");
const WS_GAMMA = toWorktreeId(REPO_GAMMA, "main");

// A feature-branch worktree on alpha (name !== defaultBranch), used to assert
// the switcher shows the branch glyph — not the house icon — for non-root
// worktrees.
const ALPHA_FEATURE_BRANCH = "feat/switcher-home";
const WS_ALPHA_FEATURE = toWorktreeId(REPO_ALPHA, ALPHA_FEATURE_BRANCH);

// Wide viewport so `useIsDesktop()` reports true and the shared dockview (which
// owns the ⌘K picker shortcut and the repo-list sidebar) mounts, along with
// the desktop title bar whose worktree name opens the same picker.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    repos: [
      {
        name: REPO_ALPHA,
        path: `/tmp/fake/${REPO_ALPHA}`,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: `/tmp/fake/${REPO_ALPHA}` },
          { branch: ALPHA_FEATURE_BRANCH, path: `/tmp/fake/${REPO_ALPHA}-feature` },
        ],
      },
      {
        name: REPO_BETA,
        path: `/tmp/fake/${REPO_BETA}`,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: `/tmp/fake/${REPO_BETA}` }],
      },
      {
        name: REPO_GAMMA,
        path: `/tmp/fake/${REPO_GAMMA}`,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: `/tmp/fake/${REPO_GAMMA}` }],
      },
    ],
  });
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

test.describe("Worktree picker — open affordances", () => {
  test("⌘K opens the picker", async ({ page }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const picker = new WorktreePicker(page);

    await worktreePage.goto(WS_ALPHA);
    await worktreePage.waitForReady();

    await worktreePage.openWorktreePickerViaShortcut();
    // waitVisible asserts the dialog reached `state: "visible"` (it throws on
    // timeout), so it is the assertion — no redundant expect needed.
    await picker.waitVisible();
  });

  test("Ctrl+K opens the picker (non-macOS path)", async ({ page }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const picker = new WorktreePicker(page);

    await worktreePage.goto(WS_ALPHA);
    await worktreePage.waitForReady();

    // Distinct code branch from ⌘K, with its own terminal-focus guard.
    await worktreePage.openWorktreePickerViaCtrlShortcut();
    await picker.waitVisible();
  });
});

test.describe("Worktree picker — pin is separate from select", () => {
  test("tapping pin toggles the pinned state without selecting the worktree", async ({ page }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const picker = new WorktreePicker(page);

    await worktreePage.goto(WS_ALPHA);
    await worktreePage.waitForReady();

    await worktreePage.openWorktreePickerViaShortcut();
    await picker.waitVisible();

    // Pre-condition: beta is not pinned yet.
    await expect(picker.pinButton(WS_BETA)).toHaveAttribute("aria-label", "Pin worktree");

    await picker.togglePin(WS_BETA);

    // The pin flipped...
    await expect(picker.pinButton(WS_BETA)).toHaveAttribute("aria-label", "Unpin worktree");
    // ...and the pin tap did NOT select beta: dialog still open, still on alpha.
    await expect(picker.dialog).toBeVisible();
    await expect(page).toHaveURL(new RegExp(WS_ALPHA));
  });

  test("clicking a row body selects the worktree and closes the dialog", async ({ page }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const picker = new WorktreePicker(page);

    await worktreePage.goto(WS_ALPHA);
    await worktreePage.waitForReady();

    await worktreePage.openWorktreePickerViaShortcut();
    await picker.waitVisible();

    await picker.select(WS_BETA);

    // Positive anchor: we navigated to beta...
    await expect(page).toHaveURL(new RegExp(WS_BETA));
    // ...and the dialog closed.
    await expect(picker.dialog).toBeHidden();
  });
});

test.describe("Worktree picker — ordering is recency, not pinned", () => {
  test("a pinned but stale worktree does not float above a recently-used one", async ({ page }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const picker = new WorktreePicker(page);

    await worktreePage.goto(WS_ALPHA);
    await worktreePage.waitForReady();

    // Pin GAMMA — the worktree we never visit, so it stays the LEAST
    // recently accessed. Under the old sort a pinned card floated near the
    // top of the switcher; under the new sort recency wins and pin status is
    // ignored for ordering.
    //
    // Recency lives ONLY in localStorage (`lib/recent-worktrees.ts`, key
    // `band-recent-worktrees`) — there is no server/DB projection — and
    // Playwright gives every test a fresh browser context, so this test
    // starts from an empty recent list no matter what earlier tests did.
    // GAMMA is never selected in this context, so it never enters the recent
    // list; DB-persisted pins from earlier tests are irrelevant now that
    // pinning no longer affects order.
    await worktreePage.openWorktreePickerViaShortcut();
    await picker.waitVisible();
    await picker.togglePin(WS_GAMMA);
    await expect(picker.pinButton(WS_GAMMA)).toHaveAttribute("aria-label", "Unpin worktree");
    await picker.dismiss();
    await expect(picker.dialog).toBeHidden();

    // Build the recency trail: visit BETA, then ALPHA. Selecting a row calls
    // `recordWorktreeAccess`, so the recent order becomes [ALPHA, BETA];
    // GAMMA has never been accessed and sorts last.
    await worktreePage.openWorktreePickerViaShortcut();
    await picker.waitVisible();
    await picker.select(WS_BETA);
    await expect(page).toHaveURL(new RegExp(WS_BETA));
    await worktreePage.waitForReady();

    await worktreePage.openWorktreePickerViaShortcut();
    await picker.waitVisible();
    await picker.select(WS_ALPHA);
    await expect(page).toHaveURL(new RegExp(WS_ALPHA));
    await worktreePage.waitForReady();

    // Reopen on ALPHA and read the row order. Expected: ALPHA (active) first,
    // then BETA (recently used), then the pinned-but-stale GAMMA LAST.
    await worktreePage.openWorktreePickerViaShortcut();
    await picker.waitVisible();

    // Guard against a vacuous pass: `orderedWorktreeIds` snapshots the DOM
    // without auto-retry, so wait for all rows (alpha main + alpha feature +
    // beta + gamma = 4) to render before reading the order.
    await picker.expectOptionCount(4);

    const order = await picker.orderedWorktreeIds();
    // The load-bearing assertion: pinned GAMMA must NOT jump ahead of the
    // more-recently-used BETA (it did under the old pinned-priority sort).
    expect(order.indexOf(WS_BETA)).toBeLessThan(order.indexOf(WS_GAMMA));
    // Scoped to the three worktrees this test drives (the seed also has an
    // untouched feature worktree), the order is strict recency with the active
    // worktree pinned to top.
    const scoped = order.filter((id) => [WS_ALPHA, WS_BETA, WS_GAMMA].includes(id));
    expect(scoped).toEqual([WS_ALPHA, WS_BETA, WS_GAMMA]);
  });
});

test.describe("Worktree picker — root worktrees show a house icon", () => {
  test("the main-branch worktree shows a house icon; a feature branch does not", async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const picker = new WorktreePicker(page);

    await worktreePage.goto(WS_ALPHA);
    await worktreePage.waitForReady();

    await worktreePage.openWorktreePickerViaShortcut();
    await picker.waitVisible();

    // The default-branch worktree is the repo's main checkout — marked with
    // a house icon, mirroring the repo-list root card. Assert it for two
    // different repos so the marker is proven not to be repo-specific.
    await expect(picker.homeIcon(WS_ALPHA)).toBeVisible();
    await expect(picker.homeIcon(WS_BETA)).toBeVisible();

    // The feature-branch worktree renders in the list but keeps the branch
    // glyph — no house icon.
    await expect(picker.item(WS_ALPHA_FEATURE)).toBeVisible();
    await expect(picker.homeIcon(WS_ALPHA_FEATURE)).toHaveCount(0);
  });
});
