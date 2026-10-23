/**
 * The left slot of a worktree row always shows the agent status, and a star
 * after the title marks the repo root. Real server, real git repo, status
 * driven through the real `statuses.update` mutation.
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
import { WorktreePicker } from "./pages/WorktreePicker";

const TOKEN = "e2e-agent-status-slot-token";
const REPO = "slotrepo";
const FEATURE = "feat-slot";
const ROOT_ID = toWorktreeId(REPO, "main", "local");
const FEATURE_ID = toWorktreeId(REPO, FEATURE, "local");

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoDir = join(tmpHome, REPO);
  const featureDir = join(tmpHome, `${REPO}-${FEATURE}`);
  mkdirSync(repoDir, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: tmpHome,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@test.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, env });
  git("init", "-b", "main");
  writeFileSync(join(repoDir, "README.md"), "# Slot\n");
  git("add", ".");
  git("commit", "-m", "init");
  git("worktree", "add", "-b", FEATURE, featureDir);
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repoDir,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: repoDir },
          { branch: FEATURE, path: featureDir },
        ],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("idle rows show the faint dot, no branch or house icon, and only the root has a star", async ({
  page,
}) => {
  const worktree = new WorktreePage(page, server.url, TOKEN);
  await worktree.goto(ROOT_ID);
  await worktree.waitForReady();

  for (const id of [ROOT_ID, FEATURE_ID]) {
    await expect(worktree.agentStatusDot(id)).toHaveAttribute("data-status", "idle");
    await expect(worktree.legacyIdentityIcons(id)).toHaveCount(0);
  }
  await expect(worktree.rootWorktreeStar(ROOT_ID)).toBeVisible();
  await expect(worktree.rootWorktreeStar(FEATURE_ID)).toHaveCount(0);

  await worktree.rootWorktreeStar(ROOT_ID).hover();
  await expect(worktree.rootStarTooltip()).toContainText("Repository root");
});

test("the root star stays while the agent works, and the feature row gets no star", async ({
  page,
}) => {
  const worktree = new WorktreePage(page, server.url, TOKEN);
  await worktree.goto(ROOT_ID);
  await worktree.waitForReady();

  try {
    await expect
      .poll(
        async () => {
          await worktree.setAgentStatus(ROOT_ID, "working");
          return worktree.agentStatusDot(ROOT_ID).getAttribute("data-status");
        },
        { timeout: 15_000 },
      )
      .toBe("working");
    await expect(worktree.rootWorktreeStar(ROOT_ID)).toBeVisible();
    await expect(worktree.legacyIdentityIcons(ROOT_ID)).toHaveCount(0);
    await expect(worktree.rootWorktreeStar(FEATURE_ID)).toHaveCount(0);
  } finally {
    await worktree.setAgentStatus(ROOT_ID, "idle");
  }
});

test("the picker shows the same idle dot and star", async ({ page }) => {
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const picker = new WorktreePicker(page);
  await worktree.goto(ROOT_ID);
  await worktree.waitForReady();
  await worktree.openWorktreePickerViaShortcut();
  await picker.waitVisible();

  await expect(picker.agentStatus(ROOT_ID)).toHaveAttribute("data-status", "idle");
  await expect(picker.agentStatus(FEATURE_ID)).toHaveAttribute("data-status", "idle");
  await expect(picker.rootStar(ROOT_ID)).toBeVisible();
  await expect(picker.rootStar(FEATURE_ID)).toHaveCount(0);
});

// Keep last: pins persist in the server database for the rest of the file.
test("the pinned section shows the same marks and star", async ({ page }) => {
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const picker = new WorktreePicker(page);
  await worktree.goto(ROOT_ID);
  await worktree.waitForReady();
  await worktree.openWorktreePickerViaShortcut();
  await picker.waitVisible();
  await picker.togglePin(ROOT_ID);
  await picker.togglePin(FEATURE_ID);
  await picker.dismiss();

  await expect(worktree.pinnedAgentStatus(ROOT_ID)).toHaveAttribute("data-status", "idle");
  await expect(worktree.pinnedAgentStatus(FEATURE_ID)).toHaveAttribute("data-status", "idle");
  await expect(worktree.pinnedRootStar(ROOT_ID)).toBeVisible();
  await expect(worktree.pinnedRootStar(FEATURE_ID)).toHaveCount(0);
});
