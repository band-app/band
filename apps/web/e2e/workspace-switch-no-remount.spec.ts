/**
 * Returning to any previously visited workspace is instant: its center
 * dockview was never unmounted, so there is no layout restore, no refetch and
 * no terminal reconnect. `MultiWorkspacePanelHost` keeps every visited
 * workspace mounted (orca's mounted-worktree set); it used to keep an LRU of 3,
 * so visiting five others and coming back remounted the first.
 *
 * Proof of "not remounted": a mark set on the workspace's mounted entry
 * element survives the round trip, and so does a mark on its terminal
 * wrapper, with no second terminal socket. DOM renderer (not WebGL) so
 * printed output lands in `.xterm-rows` where `readTerminalRenderedText` can
 * read it.
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

const TOKEN = "e2e-workspace-switch-no-remount-token";
const PROJECT = "no-remount-repo";
const BRANCHES = ["nr-0", "nr-1", "nr-2", "nr-3", "nr-4", "nr-5"];
const WS = BRANCHES.map((branch) => toWorkspaceId(PROJECT, branch));

test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome!: string;

function makeGitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

function git(cwd: string, args: string[], home: string): void {
  execFileSync("git", args, { cwd, env: makeGitEnv(home) });
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-q", "-b", "main"], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# no remount\n");
  git(repoPath, ["add", "."], tmpHome);
  git(repoPath, ["commit", "-q", "-m", "init"], tmpHome);
  const worktrees = [{ branch: "main", path: repoPath }];
  for (const branch of BRANCHES) {
    const path = join(tmpHome, `${PROJECT}-${branch}`);
    git(repoPath, ["worktree", "add", "-q", "-b", branch, path], tmpHome);
    worktrees.push({ branch, path });
  }
  seedState(tmpHome, {
    projects: [{ name: PROJECT, path: repoPath, defaultBranch: "main", worktrees }],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN, useWebGLTerminalRenderer: false });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
});

test("returning to the first of six visited workspaces does not remount it", async ({ page }) => {
  const [first, ...others] = WS;
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const socketOpens = workspacePage.trackTerminalSocketOpensFor(first);

  await workspacePage.goto(first);
  await workspacePage.waitForReady();
  await workspacePage.openTerminalTab();
  await expect(workspacePage.terminalTabVisibilityMarker(first, true)).toBeVisible({
    timeout: 20_000,
  });
  await workspacePage.waitForTerminalRenderedPrompt(first);
  await workspacePage.runInTerminalUntilRendered(
    first,
    "echo NO_REMOUNT_$((6*7))",
    /NO_REMOUNT_42/,
  );
  await expect.poll(() => socketOpens(), { timeout: 20_000 }).toBe(1);
  await workspacePage.markMountedWorkspace(first);
  expect(await workspacePage.markTerminalWrappers(first)).toBe(1);

  for (const id of others) {
    await workspacePage.switchWorkspace(id);
    await expect(workspacePage.cachedPanelEntries(id)).toBeVisible();
  }

  await workspacePage.switchWorkspace(first);
  await expect(workspacePage.terminalTabVisibilityMarker(first, true)).toBeVisible();

  expect(await workspacePage.isMountedWorkspaceMarked(first)).toBe(true);
  expect(await workspacePage.markedTerminalWrapperCount(first)).toBe(1);
  expect(await workspacePage.readTerminalRenderedText(first)).toContain("NO_REMOUNT_42");
  expect(socketOpens()).toBe(1);
});
