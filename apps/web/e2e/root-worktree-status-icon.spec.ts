/**
 * Root worktree status-icon swap.
 *
 * The default-branch ("root") worktree card marks itself with a star after
 * its title. Its left slot always shows the agent status: a faint dot when
 * idle, the state's mark otherwise. The star stays in both cases.
 *
 * Real production binary, real git repo so the default branch reconciles to a
 * WorktreeCard, no tRPC mocks. The status is driven live via the real
 * `statuses.update` mutation (the same procedure the dashboard calls), whose
 * SSE update the mounted status watcher consumes — so the swap happens the
 * same way it would in production. Page objects only.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

const TOKEN = "e2e-root-worktree-status-icon-token";
const REPO = "status-icon-repo";
const DEFAULT_BRANCH = "main";
const WORKTREE = toWorktreeId(REPO, DEFAULT_BRANCH, "local");

// Wide viewport so `useIsDesktop()` reports true (threshold 1024px) and the
// desktop sidebar renders the repo list with its worktree cards.
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

  const repoPath = join(tmpHome, REPO);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", DEFAULT_BRANCH], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# Status icon test\n");
  git(repoPath, ["add", "."], tmpHome);
  git(repoPath, ["commit", "-m", "init"], tmpHome);

  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repoPath,
        defaultBranch: DEFAULT_BRANCH,
        worktrees: [{ branch: DEFAULT_BRANCH, path: repoPath }],
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

test.describe("Root worktree status icon", () => {
  test("shows the idle dot and the root star while the agent is idle", async ({ page }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);

    await worktreePage.goto(WORKTREE);
    await worktreePage.waitForReady();

    await expect(worktreePage.agentStatusDot(WORKTREE)).toHaveAttribute("data-status", "idle");
    await expect(worktreePage.rootWorktreeStar(WORKTREE)).toBeVisible();
    await expect(worktreePage.rootWorktreeStar(WORKTREE)).toHaveAttribute(
      "aria-label",
      "Repository root",
    );
  });

  test("keeps the star while the agent is active", async ({ page }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);

    await worktreePage.goto(WORKTREE);
    await worktreePage.waitForReady();

    // The status stream has no replay, so re-send until the mark changes.
    await expect
      .poll(
        async () => {
          await worktreePage.setAgentStatus(WORKTREE, "working");
          return worktreePage.agentStatusDot(WORKTREE).getAttribute("data-status");
        },
        { timeout: 15_000 },
      )
      .toBe("working");

    await expect(worktreePage.rootWorktreeStar(WORKTREE)).toBeVisible();
  });
});
