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
    await expect(page.getByRole("button", { name: "Files" })).toBeVisible();

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
    await workspacePage.dispatchOpenFileEvent({
      filename: "missing-from-A-too.ts",
      workspaceId: WORKSPACE_OTHER,
    });

    // Negative assertion over a duration: we want to prove the
    // dialog NEVER becomes visible across the dialog's full
    // lifecycle (150 ms debounce + search + autoOpen effect). A
    // fixed wait is the only deterministic primitive for this —
    // `expect.poll(...).toBe(false)` returns IMMEDIATELY when the
    // predicate first matches, so on the bug version it would
    // succeed at t=0 (before the dialog has had time to open) and
    // create a false-green. The 800 ms wall-clock wait spans the
    // bug version's actual transition window (the dialog becomes
    // visible at ~150 ms with the 0-result auto-open branch, and
    // stays visible). The TEST-24 doctrine prefers auto-retrying
    // assertions; that doctrine assumes the assertion has a
    // positive shape ("becomes visible") — for absence-over-time
    // proofs, an explicit wait is acceptable. Counter-anchored
    // below by a positive control.
    await page.waitForTimeout(800);
    expect(await workspacePage.quickOpenDialog().isVisible()).toBe(false);

    // Positive control: same shape, but addressed to this route's
    // workspaceId. The listener MUST accept this one. Confirms the
    // listener is alive on this route — only the cross-workspace
    // event was dropped. Uses a 0-result filename so the 0-result
    // auto-open branch reveals the dialog (visible) deterministically.
    await workspacePage.dispatchOpenFileEvent({
      filename: "still-missing-mobile.ts",
      workspaceId: WORKSPACE_A,
    });
    await expect(workspacePage.quickOpenDialog()).toBeVisible();
  });

  test("event with no workspaceId in its detail falls through to this route's workspace (backwards-compat)", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(WORKSPACE_A);
    await expect(page.getByRole("button", { name: "Files" })).toBeVisible();

    await workspacePage.dispatchOpenFileEvent({
      filename: "does-not-resolve-anywhere-mobile-compat.ts",
    });

    await expect(workspacePage.quickOpenDialog()).toBeVisible();
  });
});
