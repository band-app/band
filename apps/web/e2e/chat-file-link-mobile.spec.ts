/**
 * Mobile-route coverage for the `band:open-file` listener filter
 * added in issue #539. The desktop spec
 * (`chat-file-link-workspace.spec.ts`) only exercises the
 * `SharedDockviewLayout` listener, which mounts on viewports >=
 * 1024 px. The mobile route in `workspace.$workspaceId.tsx` has the
 * SAME shape of listener — same workspaceId filter, same
 * backwards-compat fall-through — but is wired separately.
 *
 * A regression that touched only one listener and forgot the other
 * would silently re-open the leak on whichever surface was missed.
 * This spec pins the mobile route's listener to the same contract
 * as the desktop one.
 *
 * The mobile route mounts only ONE workspace at a time (no LRU
 * cache), so the cross-workspace dispatch can't come from another
 * workspace's chat being alive simultaneously. The test still pins
 * the filter contract by dispatching synthetic events with
 * mismatched workspaceIds — covering the case where any non-chat
 * caller (CLI bridge, command palette, future feature) hands the
 * mobile route an event addressed to a different workspace.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

const TOKEN = "e2e-chat-file-link-mobile-token";
const PROJECT = "chat-file-link-mobile-repo";
const DEFAULT_BRANCH = "main";

const WORKSPACE_A = toWorkspaceId(PROJECT, DEFAULT_BRANCH);
const WORKSPACE_OTHER = "some-other-workspace/main";

// Narrow viewport — `useIsDesktop()` reports false (the threshold is
// 1024 px in `apps/web/src/hooks/useIsDesktop.ts`), so the mobile
// branch of `workspace.$workspaceId.tsx` mounts and registers its
// own `band:open-file` listener. The shared dockview never mounts at
// this viewport.
test.use({ viewport: { width: 800, height: 900 } });

function makeGitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@test.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

function git(cwd: string, args: string[], home: string): void {
  execFileSync("git", args, { cwd, env: makeGitEnv(home) });
}

let server!: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  const repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", DEFAULT_BRANCH], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# Mobile listener filter test\n");
  git(repoPath, ["add", "."], tmpHome);
  git(repoPath, ["commit", "-m", "initial commit"], tmpHome);

  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: repoPath,
        defaultBranch: DEFAULT_BRANCH,
        worktrees: [{ branch: DEFAULT_BRANCH, path: repoPath }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (server) await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("mobile chat file-link workspace scoping (issue #539)", () => {
  test("event addressed to a DIFFERENT workspace is ignored — no Quick Open dialog opens", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(WORKSPACE_A);
    // Mobile layout has no maximize button (no dockview), so
    // `waitForReady` from the desktop helper isn't usable. Wait
    // instead for the mobile-specific surface — the chat tab is the
    // default landing view. README.md exists on disk, so the
    // mobile tab nav is visible once the route hydrates.
    await workspacePage.waitForMobileReady();

    // Filename DELIBERATELY missing from workspace A's index so the
    // bug version's auto-open shortcut would take the 0-result
    // branch (which reveals the dialog visibly) — the
    // single-match branch closes the dialog silently and would
    // create a false-green coverage hole, the same one that the
    // desktop spec's deleted original test #1 had.
    //
    // Dispatch addressed to a workspace that ISN'T the route's
    // current workspaceId. The mobile listener's filter check
    // (`detail.workspaceId && detail.workspaceId !== workspaceId`)
    // must drop this event so the dialog stays hidden.
    // Positive control FIRST. We dispatch a known-good event
    // addressed to THIS workspace and wait for the dialog to become
    // visible. By the time `toBeVisible()` resolves, the React
    // commit, the 150 ms search debounce, the search round-trip,
    // and the 0-result autoOpen branch have all run. The positive
    // control is the timing anchor: any in-flight listener work
    // that the cross-workspace dispatch below would trigger has the
    // same ~150 ms-ish lifecycle, so by the time we're past the
    // positive control's `toBeVisible()` the cross-workspace event
    // has had at least as much time as the positive control did.
    await workspacePage.dispatchOpenFileEvent({
      filename: "still-missing-mobile.ts",
      workspaceId: WORKSPACE_A,
    });
    await expect(workspacePage.quickOpenDialog()).toBeVisible();

    // Close the dialog so the cross-workspace dispatch below
    // observes a clean baseline (hidden) — otherwise the positive
    // control's open state masks the negative we're trying to prove.
    await workspacePage.closeQuickOpenDialog();
    await expect(workspacePage.quickOpenDialog()).toBeHidden();

    // Now the cross-workspace dispatch. The positive control above
    // proved the listener's react/render/search path runs in well
    // under our `toBeVisible()` 5 s default expect-timeout, so a
    // bounded poll for "dialog stays hidden" of 1 s is more than
    // enough time for the bug version's autoOpen to land — if it
    // were going to land at all, it'd land within ~200 ms. A
    // `toBeHidden` snapshot inside the poll would be ambiguous
    // (auto-retrying assertions return immediately on the first
    // match, so `toBeHidden` is true at t=0 and the poll succeeds
    // even on a buggy build). Instead we poll for the dialog's
    // visibility transitioning to TRUE within a bounded timeout
    // and assert the timeout DOES expire (no visibility flip) — the
    // assertion is positive-shaped per TEST-23, and the bounded
    // timeout makes the test deterministic. With the bug, the
    // dialog goes visible within ~200 ms (0-result auto-open) and
    // the assertion fails fast; with the fix, the listener drops
    // the event and the poll exhausts the budget without finding
    // a true. We catch the polling rejection to convert "poll
    // timed out without finding true" into "test passed".
    await workspacePage.dispatchOpenFileEvent({
      filename: "missing-from-A-too.ts",
      workspaceId: WORKSPACE_OTHER,
    });
    let leaked = false;
    try {
      await expect
        .poll(() => workspacePage.quickOpenDialog().isVisible(), { timeout: 800 })
        .toBe(true);
      leaked = true;
    } catch {
      // poll exhausted budget without observing a flip to visible —
      // exactly the contract we want to confirm. swallow.
    }
    expect(leaked).toBe(false);
  });

  test("event with no workspaceId in its detail falls through to this route's workspace (backwards-compat)", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForMobileReady();

    await workspacePage.dispatchOpenFileEvent({
      filename: "does-not-resolve-anywhere-mobile-compat.ts",
    });

    await expect(workspacePage.quickOpenDialog()).toBeVisible();
  });
});
