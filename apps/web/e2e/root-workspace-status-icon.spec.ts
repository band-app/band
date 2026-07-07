/**
 * Root workspace status-icon swap.
 *
 * The default-branch ("root") workspace card shows a house icon as its
 * identity marker. When its agent has a live status ("working" /
 * "needs_attention") the status dot must REPLACE the house — occupying the
 * same slot — exactly the way the branch glyph is replaced on every other
 * workspace card. The regression this guards against: the root card showed
 * the status dot AND the house side by side, instead of swapping.
 *
 * Real production binary, real git repo so the default branch reconciles to a
 * WorkspaceCard, no tRPC mocks. The status is driven live via the real
 * `statuses.update` mutation (the same procedure the dashboard calls), whose
 * SSE update the mounted status watcher consumes — so the swap happens the
 * same way it would in production. Page objects only.
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

const TOKEN = "e2e-root-workspace-status-icon-token";
const PROJECT = "status-icon-repo";
const DEFAULT_BRANCH = "main";
const WORKSPACE = toWorkspaceId(PROJECT, DEFAULT_BRANCH);

// Wide viewport so `useIsDesktop()` reports true (threshold 1024px) and the
// desktop sidebar renders the project list with its workspace cards.
test.use({ viewport: { width: 1280, height: 800 } });

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

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  const repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", DEFAULT_BRANCH], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# Status icon test\n");
  git(repoPath, ["add", "."], tmpHome);
  git(repoPath, ["commit", "-m", "init"], tmpHome);

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
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Root workspace status icon", () => {
  test("shows the home icon and no status dot while the agent is idle", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForReady();

    // The house is the root card's idle identity marker…
    await expect(workspacePage.rootWorkspaceHomeIcon(WORKSPACE)).toBeVisible();
    // …and with no live agent status there is no status dot beside it.
    await expect(workspacePage.agentStatusDot(WORKSPACE)).toHaveCount(0);
  });

  test("replaces the home icon with the status dot when the agent is active", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForReady();

    // Anchor the starting state: house present, no dot.
    await expect(workspacePage.rootWorkspaceHomeIcon(WORKSPACE)).toBeVisible();
    await expect(workspacePage.agentStatusDot(WORKSPACE)).toHaveCount(0);

    // Drive a live "working" status through the real mutation + SSE path.
    // `statuses.update` emits to currently-subscribed SSE listeners with no
    // replay, and the browser's status-stream subscription isn't guaranteed
    // to be live the instant `waitForReady()` returns (it keys on the dockview
    // Maximize button, not on SSE connectivity). Re-fire the mutation — the
    // upsert is idempotent and the router re-emits on every call — until the
    // dot renders, so a lost pre-subscription event can't flake the test.
    await expect
      .poll(
        async () => {
          await workspacePage.setAgentStatus(WORKSPACE, "working");
          return workspacePage.agentStatusDot(WORKSPACE).count();
        },
        // Match the `waitForReady` budget: on a slow CI worker the SSE
        // subscription can take longer than the default 5 s poll window to
        // come up, and this loop is the barrier that waits for it.
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    // Positive anchor: the status dot appeared (the swap happened)…
    await expect(workspacePage.agentStatusDot(WORKSPACE)).toBeVisible();
    // …and it REPLACED the house rather than sitting beside it.
    await expect(workspacePage.rootWorkspaceHomeIcon(WORKSPACE)).toHaveCount(0);
  });
});
