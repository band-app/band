/**
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

const WS_ALPHA = toWorkspaceId(PROJECT_ALPHA, "main");
const WS_BETA = toWorkspaceId(PROJECT_BETA, "main");

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
        worktrees: [{ branch: "main", path: `/tmp/fake/${PROJECT_ALPHA}` }],
      },
      {
        name: PROJECT_BETA,
        path: `/tmp/fake/${PROJECT_BETA}`,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: `/tmp/fake/${PROJECT_BETA}` }],
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
    await picker.waitVisible();

    await expect(picker.dialog).toBeVisible();
  });

  test("clicking the desktop title-bar workspace name opens the picker", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const picker = new WorkspacePicker(page);

    await workspacePage.goto(WS_ALPHA);
    await workspacePage.waitForReady();

    // The title-bar name is the desktop analogue of the mobile header tap.
    await expect(workspacePage.desktopTitleWorkspaceNameButton).toBeVisible();
    await workspacePage.openWorkspacePickerViaTitleBar();
    await picker.waitVisible();

    await expect(picker.dialog).toBeVisible();
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
