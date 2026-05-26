/**
 * End-to-end coverage for issue #505 — switching labels restores the
 * workspace last viewed under that label, while ALL keeps the current
 * selection.
 *
 * Architecture (per `docs/frontend-testing.md` + the
 * `write-integration-test` skill):
 *
 *   - Real production binary runs against a fresh tmp `~/.band/`.
 *     Migrations apply against the throwaway SQLite DB on boot.
 *   - No tRPC mocks. Two labels are seeded into `settings.json`, four
 *     projects (two per label) into the SQLite DB. Background git calls
 *     fail gracefully against the bogus paths but every UI surface
 *     this test touches (sidebar, label dropdown, workspace navigation
 *     via URL) lives on top of the real backend's `projects.list` and
 *     `settings.get` responses.
 *   - All interactions go through `WorkspacePage` per the doctrine — no
 *     raw `getByTestId` / `page.goto` in the test body.
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

const TOKEN = "e2e-label-restore-last-workspace-token";

// Label ids match the test fixture in apps/web/tests/trpc.test.ts so the
// reader can see the convention at a glance: lbl_<short_name>.
const LABEL_PERSONAL = "lbl_personal";
const LABEL_WORK = "lbl_work";

const PROJECT_PERSONAL_1 = "alpha-personal";
const PROJECT_PERSONAL_2 = "beta-personal";
const PROJECT_WORK_1 = "alpha-work";
const PROJECT_WORK_2 = "beta-work";

const WS_PERSONAL_1 = toWorkspaceId(PROJECT_PERSONAL_1, "main");
const WS_PERSONAL_2 = toWorkspaceId(PROJECT_PERSONAL_2, "main");
const WS_WORK_1 = toWorkspaceId(PROJECT_WORK_1, "main");
const WS_WORK_2 = toWorkspaceId(PROJECT_WORK_2, "main");

// Wide viewport so `useIsDesktop()` reports true and the shared dockview
// renders, matching the platform where users actually run into this
// behaviour (the label dropdown is also visible on mobile, but the
// workspace URL nav lives in the desktop shell).
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT_PERSONAL_1,
        path: `/tmp/fake/${PROJECT_PERSONAL_1}`,
        defaultBranch: "main",
        label: LABEL_PERSONAL,
        worktrees: [{ branch: "main", path: `/tmp/fake/${PROJECT_PERSONAL_1}` }],
      },
      {
        name: PROJECT_PERSONAL_2,
        path: `/tmp/fake/${PROJECT_PERSONAL_2}`,
        defaultBranch: "main",
        label: LABEL_PERSONAL,
        worktrees: [{ branch: "main", path: `/tmp/fake/${PROJECT_PERSONAL_2}` }],
      },
      {
        name: PROJECT_WORK_1,
        path: `/tmp/fake/${PROJECT_WORK_1}`,
        defaultBranch: "main",
        label: LABEL_WORK,
        worktrees: [{ branch: "main", path: `/tmp/fake/${PROJECT_WORK_1}` }],
      },
      {
        name: PROJECT_WORK_2,
        path: `/tmp/fake/${PROJECT_WORK_2}`,
        defaultBranch: "main",
        label: LABEL_WORK,
        worktrees: [{ branch: "main", path: `/tmp/fake/${PROJECT_WORK_2}` }],
      },
    ],
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    labels: [
      { id: LABEL_PERSONAL, name: "Personal", color: "#8b5cf6" },
      { id: LABEL_WORK, name: "Work", color: "#3b82f6" },
    ],
  });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

// Clear the per-test state we care about — the label filter and the
// "last workspace" map both live in localStorage. Encapsulated in the
// page object so the test body never touches raw `page.evaluate` /
// localStorage keys, per the integration-test doctrine.
test.beforeEach(async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.resetLabelStateAndGoto(WS_PERSONAL_1);
});

test.describe("Label switch restores last-used workspace (issue #505)", () => {
  test("switching to a specific label restores the workspace last viewed under it", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    // Step 1 — Land on a Personal workspace and pick Personal in the
    // dropdown. The label switch from ALL → Personal has no history yet,
    // so the active workspace shouldn't change.
    await workspacePage.goto(WS_PERSONAL_1);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_PERSONAL_1)));
    await workspacePage.selectLabelFilter(LABEL_PERSONAL);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_PERSONAL_1)));

    // Step 2 — Pick the second Personal workspace. The active workspace
    // is now WS_PERSONAL_2, label filter still Personal.
    await workspacePage.switchWorkspace(WS_PERSONAL_2);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_PERSONAL_2)));

    // Step 3 — Switch to Work via the dropdown. This should:
    //   - persist Personal → WS_PERSONAL_2 (the active ws was a Personal
    //     workspace, so it's saved),
    //   - find no history under Work and leave the active ws alone.
    await workspacePage.selectLabelFilter(LABEL_WORK);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_PERSONAL_2)));
    await expect
      .poll(() => workspacePage.readLabelLastWorkspaces())
      .toEqual({
        [LABEL_PERSONAL]: WS_PERSONAL_2,
      });

    // Step 4 — Pick a Work workspace; activeWorkspaceId becomes
    // WS_WORK_1 while filter is Work.
    await workspacePage.switchWorkspace(WS_WORK_1);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_WORK_1)));

    // Step 5 — Switch back to Personal. This is the headline behaviour:
    // Work gets persisted as WS_WORK_1, and the saved Personal →
    // WS_PERSONAL_2 entry restores the workspace.
    await workspacePage.selectLabelFilter(LABEL_PERSONAL);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_PERSONAL_2)));
    await expect
      .poll(() => workspacePage.readLabelLastWorkspaces())
      .toEqual({
        [LABEL_PERSONAL]: WS_PERSONAL_2,
        [LABEL_WORK]: WS_WORK_1,
      });

    // Step 6 — Round-trip: switch back to Work; the restore should land
    // on WS_WORK_1, not on whatever was active before (WS_PERSONAL_2).
    await workspacePage.selectLabelFilter(LABEL_WORK);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_WORK_1)));
  });

  test("ALL keeps the current workspace and does not record a per-label entry", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    // Land on a Personal workspace with the filter starting at ALL
    // (the beforeEach hook cleared the filter). Pick a different
    // workspace so we know which one to assert on.
    await workspacePage.goto(WS_PERSONAL_1);
    await workspacePage.switchWorkspace(WS_WORK_2);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_WORK_2)));

    // Sanity check: no per-label entry has been recorded yet — selecting
    // a workspace while on ALL must not write to the map. `expect.poll`
    // here (rather than a bare `expect(await ...)`) so a micro-task
    // delay between the user click and the `localStorage` write doesn't
    // race the assertion.
    await expect.poll(() => workspacePage.readLabelLastWorkspaces()).toEqual({});

    // Switch to Personal — no history yet, so the workspace shouldn't
    // change. (We assert this so the next step's "ALL keeps current
    // selection" claim has something to push back against.)
    await workspacePage.selectLabelFilter(LABEL_PERSONAL);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_WORK_2)));

    // Switch back to ALL. Per the issue, ALL must NOT navigate — the
    // current selection persists. WS_WORK_2 was set while on ALL, so
    // even though we cycled through Personal, the user's last explicit
    // pick should still be the active workspace.
    await workspacePage.selectLabelFilter(null);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_WORK_2)));

    // ALL also doesn't write a `null` key into the per-label map. The
    // only entry we should see is the side-effect of leaving Personal
    // → ALL, which records Personal's outgoing activeWorkspaceId — but
    // WS_WORK_2's project is labelled Work, not Personal, so the
    // "only save when project matches outgoing label" guard skips the
    // write entirely. The map stays empty. Use `expect.poll` to ride
    // out the React state→localStorage write micro-task.
    await expect.poll(() => workspacePage.readLabelLastWorkspaces()).toEqual({});
  });

  test("keyboard shortcut path shares the same restore logic as the dropdown", async ({ page }) => {
    // Per the issue: "Keyboard shortcut path AND click path should both
    // use the same restore logic — don't fix only one." This test
    // verifies that the ⌘1..9 (Cmd+1..9 / Ctrl+1..9) digit accelerators
    // drive the same `setLabelFilter` orchestration as the dropdown by
    // exercising a round-trip via the listener registered in
    // `DashboardShell`'s `useEffect`.
    //
    // `WorkspacePage.pressLabelShortcut` handles the focus-and-press
    // dance (the chat textarea autofocuses on the workspace route, and
    // the keydown handler in DashboardShell skips when focus is on an
    // editable element); see the page-object method for the rationale.

    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(WS_PERSONAL_1);

    // Build up: Ctrl+1 → Personal, then click a Personal workspace.
    await workspacePage.pressLabelShortcut(1);
    await workspacePage.switchWorkspace(WS_PERSONAL_1);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_PERSONAL_1)));

    // Ctrl+2 → Work, click a Work workspace.
    await workspacePage.pressLabelShortcut(2);
    await workspacePage.switchWorkspace(WS_WORK_2);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_WORK_2)));

    // Round-trip: Ctrl+1 should restore Personal → WS_PERSONAL_1.
    await workspacePage.pressLabelShortcut(1);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_PERSONAL_1)));

    // Ctrl+2 should restore Work → WS_WORK_2.
    await workspacePage.pressLabelShortcut(2);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_WORK_2)));

    // Final state of the map mirrors what the click-path test produces.
    await expect
      .poll(() => workspacePage.readLabelLastWorkspaces())
      .toEqual({
        [LABEL_PERSONAL]: WS_PERSONAL_1,
        [LABEL_WORK]: WS_WORK_2,
      });
  });

  test("per-label memory survives a full page reload", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    // Build up: Personal → WS_PERSONAL_2, Work → WS_WORK_1.
    await workspacePage.goto(WS_PERSONAL_2);
    await workspacePage.selectLabelFilter(LABEL_PERSONAL);
    await workspacePage.selectLabelFilter(LABEL_WORK);
    await workspacePage.switchWorkspace(WS_WORK_1);

    // Verify the map has both entries before reload.
    await expect
      .poll(() => workspacePage.readLabelLastWorkspaces())
      .toEqual({
        [LABEL_PERSONAL]: WS_PERSONAL_2,
        [LABEL_WORK]: WS_WORK_1,
      });

    // Hard-reload — the route serializes the current workspace
    // (WS_WORK_1) in the URL, so we come back on Work. The persisted
    // label-last-workspace entries should still be there in
    // localStorage, and restoring to Personal should still land us on
    // WS_PERSONAL_2.
    await workspacePage.reload();
    await expect
      .poll(() => workspacePage.readLabelLastWorkspaces())
      .toEqual({
        [LABEL_PERSONAL]: WS_PERSONAL_2,
        [LABEL_WORK]: WS_WORK_1,
      });

    await workspacePage.selectLabelFilter(LABEL_PERSONAL);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_PERSONAL_2)));
  });
});
