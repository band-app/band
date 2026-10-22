/**
 * End-to-end coverage for issue #505 — switching groups restores the
 * worktree last viewed under that group, while ALL keeps the current
 * selection.
 *
 * Architecture:
 *
 *   - Real production binary runs against a fresh tmp `~/.band/`.
 *     Migrations apply against the throwaway SQLite DB on boot.
 *   - No tRPC mocks. Two groups and four
 *     repos (two worktrees per group) are seeded into the SQLite DB, each a one-commit
 *     git repo in the tmp home so its terminal can start. Every UI
 *     surface this test touches (sidebar, group dropdown, worktree navigation
 *     via URL) lives on top of the real backend's `repos.list` and
 *     `groups.list` responses.
 *   - All interactions go through `WorktreePage` per the doctrine — no
 *     raw `getByTestId` / `page.goto` in the test body.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { gitInHome } from "./helpers/git";
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

const TOKEN = "e2e-group-restore-last-worktree-token";

// Group ids follow grp_<short_name>.
const GROUP_PERSONAL = "grp_personal";
const GROUP_WORK = "grp_work";

const REPO_PERSONAL_1 = "alpha-personal";
const REPO_PERSONAL_2 = "beta-personal";
const REPO_WORK_1 = "alpha-work";
const REPO_WORK_2 = "beta-work";

const WS_PERSONAL_1 = toWorktreeId(REPO_PERSONAL_1, "main", "local");
const WS_PERSONAL_2 = toWorktreeId(REPO_PERSONAL_2, "main", "local");
const WS_WORK_1 = toWorktreeId(REPO_WORK_1, "main", "local");
const WS_WORK_2 = toWorktreeId(REPO_WORK_2, "main", "local");

// Wide viewport so `useIsDesktop()` reports true and the shared layout
// renders, matching the platform where users actually run into this
// behaviour (the group dropdown is also visible on mobile, but the
// worktree URL nav lives in the desktop shell).
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  // Real repos: a terminal can't start in a missing directory.
  const repo = (name: string, groupId: string) => {
    const path = join(tmpHome, name);
    mkdirSync(path, { recursive: true });
    gitInHome(path, ["init", "-b", "main"], tmpHome);
    writeFileSync(join(path, "README.md"), `# ${name}\n`);
    gitInHome(path, ["add", "."], tmpHome);
    gitInHome(path, ["commit", "-m", "initial"], tmpHome);
    return { name, path, defaultBranch: "main", worktrees: [{ branch: "main", path, groupId }] };
  };
  seedState(tmpHome, {
    groups: [
      { id: GROUP_PERSONAL, name: "Personal", color: "#8b5cf6" },
      { id: GROUP_WORK, name: "Work", color: "#3b82f6" },
    ],
    repos: [
      repo(REPO_PERSONAL_1, GROUP_PERSONAL),
      repo(REPO_PERSONAL_2, GROUP_PERSONAL),
      repo(REPO_WORK_1, GROUP_WORK),
      repo(REPO_WORK_2, GROUP_WORK),
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

// Clear the per-test state we care about — the group filter and the
// "last worktree" map both live in localStorage. Encapsulated in the
// page object so the test body never touches raw `page.evaluate` /
// localStorage keys, per the integration-test doctrine.
test.beforeEach(async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.resetGroupStateAndGoto(WS_PERSONAL_1);
});

test.describe("Group switch restores last-used worktree (issue #505)", () => {
  test("switching to a specific group restores the worktree last viewed under it", async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);

    // Step 1 — Land on a Personal worktree and pick Personal in the
    // dropdown. The group switch from ALL → Personal has no history yet,
    // so the active worktree shouldn't change.
    await worktreePage.goto(WS_PERSONAL_1);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_PERSONAL_1)));
    await worktreePage.selectGroupFilter(GROUP_PERSONAL);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_PERSONAL_1)));

    // Step 2 — Pick the second Personal worktree. The active worktree
    // is now WS_PERSONAL_2, group filter still Personal.
    await worktreePage.switchWorktree(WS_PERSONAL_2);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_PERSONAL_2)));

    // Step 3 — Switch to Work via the dropdown. This should:
    //   - persist Personal → WS_PERSONAL_2 (the active ws was a Personal
    //     worktree, so it's saved),
    //   - find no history under Work and leave the active ws alone.
    await worktreePage.selectGroupFilter(GROUP_WORK);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_PERSONAL_2)));
    await expect
      .poll(() => worktreePage.readGroupLastWorktrees())
      .toEqual({
        [GROUP_PERSONAL]: WS_PERSONAL_2,
      });

    // Step 4 — Pick a Work worktree; activeWorktreeId becomes
    // WS_WORK_1 while filter is Work.
    await worktreePage.switchWorktree(WS_WORK_1);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_WORK_1)));

    // Step 5 — Switch back to Personal. This is the headline behaviour:
    // Work gets persisted as WS_WORK_1, and the saved Personal →
    // WS_PERSONAL_2 entry restores the worktree.
    await worktreePage.selectGroupFilter(GROUP_PERSONAL);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_PERSONAL_2)));
    await expect
      .poll(() => worktreePage.readGroupLastWorktrees())
      .toEqual({
        [GROUP_PERSONAL]: WS_PERSONAL_2,
        [GROUP_WORK]: WS_WORK_1,
      });

    // Step 6 — Round-trip: switch back to Work; the restore should land
    // on WS_WORK_1, not on whatever was active before (WS_PERSONAL_2).
    await worktreePage.selectGroupFilter(GROUP_WORK);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_WORK_1)));
  });

  test("ALL keeps the current worktree and does not record a per-group entry", async ({ page }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);

    // Land on a Personal worktree with the filter starting at ALL
    // (the beforeEach hook cleared the filter). Pick a different
    // worktree so we know which one to assert on.
    await worktreePage.goto(WS_PERSONAL_1);
    await worktreePage.switchWorktree(WS_WORK_2);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_WORK_2)));

    // Sanity check: no per-group entry has been recorded yet — selecting
    // a worktree while on ALL must not write to the map. `expect.poll`
    // here (rather than a bare `expect(await ...)`) so a micro-task
    // delay between the user click and the `localStorage` write doesn't
    // race the assertion.
    await expect.poll(() => worktreePage.readGroupLastWorktrees()).toEqual({});

    // Switch to Personal — no history yet, so the worktree shouldn't
    // change. (We assert this so the next step's "ALL keeps current
    // selection" claim has something to push back against.)
    await worktreePage.selectGroupFilter(GROUP_PERSONAL);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_WORK_2)));

    // Switch back to ALL. Per the issue, ALL must NOT navigate — the
    // current selection persists. WS_WORK_2 was set while on ALL, so
    // even though we cycled through Personal, the user's last explicit
    // pick should still be the active worktree.
    await worktreePage.selectGroupFilter(null);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_WORK_2)));

    // ALL also doesn't write a `null` key into the per-group map. The
    // only entry we should see is the side-effect of leaving Personal
    // → ALL, which records Personal's outgoing activeWorktreeId — but
    // WS_WORK_2's repo is in Work, not Personal, so the
    // "only save when repo matches outgoing group" guard skips the
    // write entirely. The map stays empty. Use `expect.poll` to ride
    // out the React state→localStorage write micro-task.
    await expect.poll(() => worktreePage.readGroupLastWorktrees()).toEqual({});
  });

  test("keyboard shortcut path shares the same restore logic as the dropdown", async ({ page }) => {
    // Per the issue: "Keyboard shortcut path AND click path should both
    // use the same restore logic — don't fix only one." This test
    // verifies that the ⌘1..9 digit accelerators drive the same
    // `setGroupFilter` orchestration as the dropdown by exercising a
    // round-trip via the listener registered in `DashboardShell`'s
    // `useEffect`.
    //
    // Each press goes to whatever holds focus, as a user's would: the
    // sidebar card just clicked, or the terminal a worktree switch moves
    // focus into a frame or more later. ⌘+digit works from both.

    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    await worktreePage.goto(WS_PERSONAL_1);

    // Build up: ⌘1 → Personal, then click a Personal worktree.
    await worktreePage.pressGroupShortcut(1);
    await expect(worktreePage.groupFilterTrigger()).toHaveText("Personal");
    await worktreePage.switchWorktree(WS_PERSONAL_1);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_PERSONAL_1)));

    // ⌘2 → Work, click a Work worktree.
    await worktreePage.pressGroupShortcut(2);
    await expect(worktreePage.groupFilterTrigger()).toHaveText("Work");
    await worktreePage.switchWorktree(WS_WORK_2);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_WORK_2)));

    // Round-trip: ⌘1 should restore Personal → WS_PERSONAL_1.
    await worktreePage.pressGroupShortcut(1);
    await expect(worktreePage.groupFilterTrigger()).toHaveText("Personal");
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_PERSONAL_1)));

    // ⌘2 should restore Work → WS_WORK_2.
    await worktreePage.pressGroupShortcut(2);
    await expect(worktreePage.groupFilterTrigger()).toHaveText("Work");
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_WORK_2)));

    // Final state of the map mirrors what the click-path test produces.
    await expect
      .poll(() => worktreePage.readGroupLastWorktrees())
      .toEqual({
        [GROUP_PERSONAL]: WS_PERSONAL_1,
        [GROUP_WORK]: WS_WORK_2,
      });
  });

  test("⌘1..9 switches groups with focus in the terminal", async ({ page }) => {
    // A worktree switch moves focus into the worktree's terminal, so that
    // is where a user presses ⌘1..9 next. ⌘+digit types nothing into a
    // terminal, so the shortcut must not be skipped there.
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    await worktreePage.goto(WS_PERSONAL_1);
    await worktreePage.selectGroupFilter(GROUP_PERSONAL);
    await worktreePage.selectGroupFilter(GROUP_WORK);
    await worktreePage.switchWorktree(WS_WORK_2);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_WORK_2)));

    await worktreePage.pressGroupShortcutInTerminal(WS_WORK_2, 1);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_PERSONAL_1)));
    await expect(worktreePage.groupFilterTrigger()).toHaveText("Personal");

    await worktreePage.pressGroupShortcutInTerminal(WS_PERSONAL_1, 2);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_WORK_2)));
    await expect(worktreePage.groupFilterTrigger()).toHaveText("Work");
  });

  test("Ctrl+1..9 is left to the terminal and switches groups from the sidebar", async ({
    page,
  }) => {
    // Off macOS the shortcut is Ctrl+digit, and a terminal sends Ctrl+3..8
    // to the shell as control characters, so the terminal keeps Ctrl+digit.
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    await worktreePage.goto(WS_PERSONAL_1);
    await worktreePage.selectGroupFilter(GROUP_PERSONAL);
    await worktreePage.selectGroupFilter(GROUP_WORK);
    await worktreePage.switchWorktree(WS_WORK_2);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_WORK_2)));

    // Ctrl+1 in the terminal must not switch to Personal (which would
    // restore WS_PERSONAL_1). ⌘0 after it proves the keys were handled:
    // it shows All and, like any switch to All, stays on the worktree.
    await worktreePage.pressGroupShortcutInTerminal(WS_WORK_2, 1, "Control");
    await worktreePage.pressGroupShortcutInTerminal(WS_WORK_2, 0);
    await expect.poll(() => worktreePage.readGroupFilter()).toBeNull();
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_WORK_2)));

    // From the sidebar, Ctrl+1 switches to Personal and restores its
    // worktree. Focus already sits in the terminal (the switch above put
    // it there), so nothing moves it off the sidebar before the key.
    await worktreePage.pressGroupShortcutFromRepoList(1);
    await expect(worktreePage.groupFilterTrigger()).toHaveText("Personal");
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_PERSONAL_1)));
  });

  test("per-group memory survives a full page reload", async ({ page }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);

    // Build up: Personal → WS_PERSONAL_2, Work → WS_WORK_1.
    await worktreePage.goto(WS_PERSONAL_2);
    await worktreePage.selectGroupFilter(GROUP_PERSONAL);
    await worktreePage.selectGroupFilter(GROUP_WORK);
    await worktreePage.switchWorktree(WS_WORK_1);

    // Verify the map has both entries before reload.
    await expect
      .poll(() => worktreePage.readGroupLastWorktrees())
      .toEqual({
        [GROUP_PERSONAL]: WS_PERSONAL_2,
        [GROUP_WORK]: WS_WORK_1,
      });

    // Hard-reload — the route serializes the current worktree
    // (WS_WORK_1) in the URL, so we come back on Work. The persisted
    // group-last-worktree entries should still be there in
    // localStorage, and restoring to Personal should still land us on
    // WS_PERSONAL_2.
    await worktreePage.reload();
    await expect
      .poll(() => worktreePage.readGroupLastWorktrees())
      .toEqual({
        [GROUP_PERSONAL]: WS_PERSONAL_2,
        [GROUP_WORK]: WS_WORK_1,
      });

    await worktreePage.selectGroupFilter(GROUP_PERSONAL);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(WS_PERSONAL_2)));
  });
});
