/**
 * Layout coverage for the command-palette-style dialogs, exercised through the
 * WorkspacePickerDialog (which lists real seeded workspaces and filters them
 * client-side, so the result count — and therefore the card height — changes
 * as the user types).
 *
 * The dialogs share the `command-palette` `DialogContent` variant
 * (`packages/ui/src/components/dialog.tsx`), so pinning its geometry on one
 * dialog pins it for all five (quick open, find in files, switch workspace,
 * command palette, language picker).
 *
 * Two user-observable contracts, both asserted via real Chromium DOM geometry
 * (`boundingBox()`), no CSS-class introspection:
 *
 *   1. Desktop (wide viewport): the card is anchored in the upper third by its
 *      TOP edge, so the search input stays at a FIXED Y as results appear and
 *      disappear — only the list below it grows/shrinks. The old centred layout
 *      re-centred the whole card, bobbing the input up and down; this spec
 *      fails on that behaviour.
 *   2. Mobile (narrow viewport): the input is pinned BELOW the results list
 *      (bottom of the sheet, easy thumb reach), so the input's Y is greater
 *      than the last (bottom-most) result row's Y — proving it's below the
 *      entire list, not merely mid-list.
 *
 * Architecture: real production binary against a fresh tmp `~/.band/`, no tRPC
 * mocks. One project with several worktrees is seeded so the picker has enough
 * rows to shrink meaningfully when filtered. All interaction is via page
 * objects.
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

const TOKEN = "e2e-command-dialog-layout-token";
const PROJECT = "layout-demo";

// A handful of worktrees so the picker list is tall when unfiltered and
// collapses to a single row when a unique branch is typed — the height delta
// that would move a centred card's input. The names are deliberately
// dissimilar (cmdk filters by fuzzy *subsequence*, so near-identical names
// like `feature-a`/`feature-b` would all survive a single-letter query):
// only `epsilon` contains an "s", so typing it narrows the list to one row.
const BRANCHES = ["main", "alpha", "bravo", "charlie", "delta", "epsilon"];
const FILTER_TO_ONE = "epsilon";
const WS_MAIN = toWorkspaceId(PROJECT, "main");

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: `/tmp/fake/${PROJECT}`,
        defaultBranch: "main",
        worktrees: BRANCHES.map((branch) => ({
          branch,
          path: `/tmp/fake/${PROJECT}/${branch}`,
        })),
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

test.describe("Command dialog layout — desktop (upper third, input anchored)", () => {
  // Wide viewport so `useIsDesktop()` is true, the shared dockview mounts, and
  // the ⌘K picker uses the desktop (top-anchored) branch of the variant.
  test.use({ viewport: { width: 1280, height: 800 } });

  test("input stays at a fixed Y as the result list shrinks, list sits below the input", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const picker = new WorkspacePicker(page);

    await workspacePage.goto(WS_MAIN);
    await workspacePage.waitForReady();

    await workspacePage.openWorkspacePickerViaShortcut();
    await picker.waitVisible();

    // All rows visible: on desktop the input is at the TOP, the list below it.
    await expect(picker.options).toHaveCount(BRANCHES.length);
    const inputFull = await picker.inputBox();
    const firstRowFull = await picker.firstOptionBox();
    expect(firstRowFull.y).toBeGreaterThan(inputFull.y);

    // Filter down to a single row — the card gets much shorter. A centred
    // dialog would re-centre and pull the input downward; the top-anchored
    // command-palette variant must keep the input at the same Y.
    await picker.typeQuery(FILTER_TO_ONE);
    await expect(picker.options).toHaveCount(1);

    const inputFiltered = await picker.inputBox();
    expect(Math.abs(inputFiltered.y - inputFull.y)).toBeLessThanOrEqual(2);
  });
});

test.describe("Command dialog layout — mobile (input below the list)", () => {
  // Narrow viewport so `useIsDesktop()` is false and the picker renders as the
  // bottom-sheet variant with the input pinned below the results list.
  test.use({ viewport: { width: 390, height: 844 } });

  test("input sits below the last result row", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const picker = new WorkspacePicker(page);

    await workspacePage.goto(WS_MAIN);
    await workspacePage.waitForMobileReady();

    // Mobile opens the picker from the workspace header title.
    await workspacePage.openSwitcherFromHeader();
    await picker.waitVisible();

    await expect(picker.options.first()).toBeVisible();
    const inputBox = await picker.inputBox();
    const lastRowBox = await picker.lastOptionBox();

    // Input pinned below the ENTIRE list → its top edge is below the top of the
    // last (bottom-most) row. Measuring against the last row (not the first)
    // proves the input isn't merely mid-list.
    expect(inputBox.y).toBeGreaterThan(lastRowBox.y);
  });
});
