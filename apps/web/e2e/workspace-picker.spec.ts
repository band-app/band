/**
 * Coverage for the WorkspacePickerDialog, in two groups:
 *
 * 1. "open affordances" — the ways a user opens the picker on desktop: the
 *    ⌘K shortcut (macOS), the Ctrl+K shortcut (Windows/Linux wide-viewport
 *    web), and clicking the desktop title-bar workspace-name button.
 * 2. "pin is separate from select" — the pin/select separation regression
 *    described below.
 *
 * Regression coverage for the WorkspacePickerDialog pin/select separation
 * (PR #553). Tapping a row's pin button must toggle the pinned state WITHOUT
 * selecting the workspace — the dialog stays open and the URL doesn't change.
 * Clicking the row body, by contrast, selects the workspace: it navigates and
 * closes the dialog.
 *
 * The bug this guards: cmdk fires a row's `onSelect` from the item's bubbled
 * `onClick`, so an earlier version of the pin button (which only stopped
 * propagation on `mousedown`) let a real click bubble to the item and navigate
 * away. The fix stops propagation on pointerdown/mousedown/click and toggles
 * once on click.
 *
 * Architecture: real production binary against a fresh tmp `~/.band/`, no tRPC
 * mocks. Two projects are seeded into the SQLite DB; the picker lists their
 * worktrees from the real `projects.list` response. Pinning goes through the
 * real `pinnedWorkspaces` mutation. All interaction is via page objects.
 */

import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorkspacePage } from "./pages/WorkspacePage";
import { WorkspacePicker } from "./pages/WorkspacePicker";

const TOKEN = "e2e-workspace-picker-token";

const PROJECT_ALPHA = "alpha-picker";
const PROJECT_BETA = "beta-picker";
const PROJECT_GAMMA = "gamma-picker";

const WS_ALPHA = toWorkspaceId(PROJECT_ALPHA, "main");
const WS_BETA = toWorkspaceId(PROJECT_BETA, "main");
const WS_GAMMA = toWorkspaceId(PROJECT_GAMMA, "main");

// A feature-branch worktree on alpha (name !== defaultBranch), used to assert
// the switcher shows the branch glyph — not the house icon — for non-root
// workspaces.
const ALPHA_FEATURE_BRANCH = "feat/switcher-home";
const WS_ALPHA_FEATURE = toWorkspaceId(PROJECT_ALPHA, ALPHA_FEATURE_BRANCH);

// Wide viewport so `useIsDesktop()` reports true and the shared dockview (which
// owns the ⌘K picker shortcut and the project-list sidebar) mounts, along with
// the desktop title bar whose workspace name opens the same picker.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT_ALPHA,
        path: `/tmp/fake/${PROJECT_ALPHA}`,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: `/tmp/fake/${PROJECT_ALPHA}` },
          { branch: ALPHA_FEATURE_BRANCH, path: `/tmp/fake/${PROJECT_ALPHA}-feature` },
        ],
      },
      {
        name: PROJECT_BETA,
        path: `/tmp/fake/${PROJECT_BETA}`,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: `/tmp/fake/${PROJECT_BETA}` }],
      },
      {
        name: PROJECT_GAMMA,
        path: `/tmp/fake/${PROJECT_GAMMA}`,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: `/tmp/fake/${PROJECT_GAMMA}` }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Workspace picker — open affordances", () => {
  test("⌘K opens the picker", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const picker = new WorkspacePicker(page);

    await workspacePage.goto(WS_ALPHA);
    await workspacePage.waitForReady();

    await workspacePage.openWorkspacePickerViaShortcut();
    // waitVisible asserts the dialog reached `state: "visible"` (it throws on
    // timeout), so it is the assertion — no redundant expect needed.
    await picker.waitVisible();
  });

  test("Ctrl+K opens the picker (non-macOS path)", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const picker = new WorkspacePicker(page);

    await workspacePage.goto(WS_ALPHA);
    await workspacePage.waitForReady();

    // Distinct code branch from ⌘K, with its own terminal-focus guard.
    await workspacePage.openWorkspacePickerViaCtrlShortcut();
    await picker.waitVisible();
  });

  test("clicking the desktop title-bar workspace name opens the picker", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const picker = new WorkspacePicker(page);

    await workspacePage.goto(WS_ALPHA);
    await workspacePage.waitForReady();

    // The title-bar name is the desktop analogue of the mobile header tap.
    await workspacePage.assertTitleBarWorkspaceNameVisible();
    await workspacePage.openWorkspacePickerViaTitleBar();
    await picker.waitVisible();
  });
});

test.describe("Workspace picker — pin is separate from select", () => {
  test("tapping pin toggles the pinned state without selecting the workspace", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const picker = new WorkspacePicker(page);

    await workspacePage.goto(WS_ALPHA);
    await workspacePage.waitForReady();

    await workspacePage.openWorkspacePickerViaShortcut();
    await picker.waitVisible();

    // Pre-condition: beta is not pinned yet.
    await expect(picker.pinButton(WS_BETA)).toHaveAttribute("aria-label", "Pin workspace");

    await picker.togglePin(WS_BETA);

    // The pin flipped...
    await expect(picker.pinButton(WS_BETA)).toHaveAttribute("aria-label", "Unpin workspace");
    // ...and the pin tap did NOT select beta: dialog still open, still on alpha.
    await expect(picker.dialog).toBeVisible();
    await expect(page).toHaveURL(new RegExp(WS_ALPHA));
  });

  test("clicking a row body selects the workspace and closes the dialog", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const picker = new WorkspacePicker(page);

    await workspacePage.goto(WS_ALPHA);
    await workspacePage.waitForReady();

    await workspacePage.openWorkspacePickerViaShortcut();
    await picker.waitVisible();

    await picker.select(WS_BETA);

    // Positive anchor: we navigated to beta...
    await expect(page).toHaveURL(new RegExp(WS_BETA));
    // ...and the dialog closed.
    await expect(picker.dialog).toBeHidden();
  });
});

test.describe("Workspace picker — ordering is recency, not pinned", () => {
  test("a pinned but stale workspace does not float above a recently-used one", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const picker = new WorkspacePicker(page);

    await workspacePage.goto(WS_ALPHA);
    await workspacePage.waitForReady();

    // Pin GAMMA — the workspace we never visit, so it stays the LEAST
    // recently accessed. Under the old sort a pinned card floated near the
    // top of the switcher; under the new sort recency wins and pin status is
    // ignored for ordering.
    //
    // Recency lives ONLY in localStorage (`lib/recent-workspaces.ts`, key
    // `band-recent-workspaces`) — there is no server/DB projection — and
    // Playwright gives every test a fresh browser context, so this test
    // starts from an empty recent list no matter what earlier tests did.
    // GAMMA is never selected in this context, so it never enters the recent
    // list; DB-persisted pins from earlier tests are irrelevant now that
    // pinning no longer affects order.
    await workspacePage.openWorkspacePickerViaShortcut();
    await picker.waitVisible();
    await picker.togglePin(WS_GAMMA);
    await expect(picker.pinButton(WS_GAMMA)).toHaveAttribute("aria-label", "Unpin workspace");
    await picker.dismiss();
    await expect(picker.dialog).toBeHidden();

    // Build the recency trail: visit BETA, then ALPHA. Selecting a row calls
    // `recordWorkspaceAccess`, so the recent order becomes [ALPHA, BETA];
    // GAMMA has never been accessed and sorts last.
    await workspacePage.openWorkspacePickerViaShortcut();
    await picker.waitVisible();
    await picker.select(WS_BETA);
    await expect(page).toHaveURL(new RegExp(WS_BETA));
    await workspacePage.waitForReady();

    await workspacePage.openWorkspacePickerViaShortcut();
    await picker.waitVisible();
    await picker.select(WS_ALPHA);
    await expect(page).toHaveURL(new RegExp(WS_ALPHA));
    await workspacePage.waitForReady();

    // Reopen on ALPHA and read the row order. Expected: ALPHA (active) first,
    // then BETA (recently used), then the pinned-but-stale GAMMA LAST.
    await workspacePage.openWorkspacePickerViaShortcut();
    await picker.waitVisible();

    // Guard against a vacuous pass: `orderedWorkspaceIds` snapshots the DOM
    // without auto-retry, so wait for all rows (alpha main + alpha feature +
    // beta + gamma = 4) to render before reading the order.
    await picker.expectOptionCount(4);

    const order = await picker.orderedWorkspaceIds();
    // The load-bearing assertion: pinned GAMMA must NOT jump ahead of the
    // more-recently-used BETA (it did under the old pinned-priority sort).
    expect(order.indexOf(WS_BETA)).toBeLessThan(order.indexOf(WS_GAMMA));
    // Scoped to the three workspaces this test drives (the seed also has an
    // untouched feature worktree), the order is strict recency with the active
    // workspace pinned to top.
    const scoped = order.filter((id) => [WS_ALPHA, WS_BETA, WS_GAMMA].includes(id));
    expect(scoped).toEqual([WS_ALPHA, WS_BETA, WS_GAMMA]);
  });
});

test.describe("Workspace picker — root workspaces show a house icon", () => {
  test("the main-branch workspace shows a house icon; a feature branch does not", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const picker = new WorkspacePicker(page);

    await workspacePage.goto(WS_ALPHA);
    await workspacePage.waitForReady();

    await workspacePage.openWorkspacePickerViaShortcut();
    await picker.waitVisible();

    // The default-branch worktree is the project's main checkout — marked with
    // a house icon, mirroring the project-list root card. Assert it for two
    // different projects so the marker is proven not to be project-specific.
    await expect(picker.homeIcon(WS_ALPHA)).toBeVisible();
    await expect(picker.homeIcon(WS_BETA)).toBeVisible();

    // The feature-branch worktree renders in the list but keeps the branch
    // glyph — no house icon.
    await expect(picker.item(WS_ALPHA_FEATURE)).toBeVisible();
    await expect(picker.homeIcon(WS_ALPHA_FEATURE)).toHaveCount(0);
  });
});
