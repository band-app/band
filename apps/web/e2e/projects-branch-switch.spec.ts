/**
 * Frontend regression for the "branch disappears from project branches"
 * bug. When the branch checked out inside a worktree is switched (by an
 * agent, a person, or a terminal `git switch`), the worktree's card used to
 * vanish from the project-list sidebar until a restart — because
 * `projects.list` intersected git's live view against tracked worktrees by
 * BRANCH NAME, and `WorkspaceCard` keyed its DOM identity off a branch-derived
 * workspace id. The fix keys both on the worktree's stable, frozen
 * `workspaceId`, so the card survives the rename.
 *
 * Test architecture (matches the doctrine in CLAUDE.md § Testing Strategy and
 * the `write-integration-test` skill):
 *
 *   - The same production binary the user ships runs against a fresh tmp
 *     `~/.band/`; migrations apply to the throwaway SQLite DB on boot.
 *   - A REAL git repo + secondary worktree on disk — required because
 *     `projects.list` enriches each project with `git worktree list`, and the
 *     branch switch must be a real `git switch` for the list to see it.
 *   - The branch is switched out from under the running server, then a fresh
 *     navigation re-runs `projects.list` against the switched git state. The
 *     card, keyed by the frozen `workspaceId`, must still be rendered.
 *   - No tRPC mocking, no `page.route()` on our own routes, no MSW.
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

const TOKEN = "e2e-projects-branch-switch-token";

const PROJECT = "branch-switch-repo";
const DEFAULT_BRANCH = "main";
const FEATURE_BRANCH = "feature";

const WORKSPACE_MAIN = toWorkspaceId(PROJECT, DEFAULT_BRANCH);
// The card's identity is frozen at creation on `feature`, so this id stays
// stable across the later `git switch` to `feature-renamed`.
const WORKSPACE_FEATURE = toWorkspaceId(PROJECT, FEATURE_BRANCH);

// Wide viewport so `useIsDesktop()` reports true and the shared dockview —
// and therefore the project-list sidebar with its workspace cards — renders.
test.use({ viewport: { width: 1280, height: 800 } });

// Hermetic git environment — explicit allowlist, host config pinned to
// /dev/null so a contributor's global git settings can't leak in. Mirrors
// the canonical pattern in `workspace-cache-eviction.spec.ts`.
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

function git(cwd: string, args: string[], home: string): string {
  return execFileSync("git", args, { cwd, env: makeGitEnv(home), encoding: "utf-8" });
}

let server!: ServerHandle;
let tmpHome: string;
let repoPath: string;
let featureWorktreePath: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", DEFAULT_BRANCH], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# Branch switch test\n");
  git(repoPath, ["add", "."], tmpHome);
  git(repoPath, ["commit", "-m", "initial commit"], tmpHome);

  // Worktree lives inside `tmpHome` so the recursive cleanup reaps it.
  featureWorktreePath = join(tmpHome, `${PROJECT}-${FEATURE_BRANCH}`);
  git(repoPath, ["worktree", "add", "-b", FEATURE_BRANCH, featureWorktreePath], tmpHome);

  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: repoPath,
        defaultBranch: DEFAULT_BRANCH,
        worktrees: [
          { branch: DEFAULT_BRANCH, path: repoPath },
          { branch: FEATURE_BRANCH, path: featureWorktreePath },
        ],
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

test.describe("Project branch list across a worktree branch switch", () => {
  test("the workspace card stays visible after the worktree's branch is switched", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    await workspacePage.goto(WORKSPACE_MAIN);
    await workspacePage.waitForReady();

    // Positive anchor: the feature worktree's card is rendered in the sidebar
    // before any switch, keyed by its frozen workspaceId.
    await expect(workspacePage.workspaceCard(WORKSPACE_FEATURE)).toBeVisible();

    // Switch the branch checked out inside the worktree, out from under the
    // running server — exactly what an agent / terminal `git switch` does.
    git(featureWorktreePath, ["switch", "-c", "feature-renamed"], tmpHome);

    // Re-navigate so the dashboard re-runs `projects.list` against the
    // switched git state (rather than waiting on the 30s background poll).
    await workspacePage.goto(WORKSPACE_MAIN);
    await workspacePage.waitForReady();

    // The card must still be present — its identity is the frozen workspaceId,
    // not the now-changed branch. Before the fix it vanished here.
    await expect(workspacePage.workspaceCard(WORKSPACE_FEATURE)).toBeVisible();
  });
});
