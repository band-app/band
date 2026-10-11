/**
 * A cold-parked hidden worktree releases the file watchers its open file
 * leaves hold, and catches up on reveal (`worktree-cold-park.ts`).
 *
 * Every visited worktree stays mounted, so its file leaves would otherwise
 * keep a `worktree.fileChanges` subscription, and with it the server's
 * recursive `fs.watch` on that worktree, for as long as the worktree exists.
 * Once the worktree goes cold (here: hidden past the 5 minute window and not
 * the worktree most recently left) the subscription closes. Revealing the
 * worktree resubscribes and reloads the file once, so an edit made while it
 * was cold still shows up.
 *
 * The 5 minute threshold is crossed with Playwright's fake clock
 * (`installClock` / `advanceClock` on the page object).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { gitInHome } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { FileViewerPage } from "./pages/FileViewerPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-worktree-cold-park-token";
const REPO = "cold-park-repo";
const BRANCHES = ["cold-a", "cold-b", "cold-c"];
const [WS_A, WS_B, WS_C] = BRANCHES.map((branch) => toWorktreeId(REPO, branch, "local"));
const FILE = "notes.txt";

const MINUTE = 60_000;

test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome!: string;
let worktreeA!: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, REPO);
  mkdirSync(repoPath, { recursive: true });
  gitInHome(repoPath, ["init", "-q", "-b", "main"], tmpHome);
  writeFileSync(join(repoPath, FILE), "BEFORE-COLD\n");
  gitInHome(repoPath, ["add", "."], tmpHome);
  gitInHome(repoPath, ["commit", "-q", "-m", "init"], tmpHome);
  const worktrees = [{ branch: "main", path: repoPath }];
  for (const branch of BRANCHES) {
    const path = join(tmpHome, `${REPO}-${branch}`);
    gitInHome(repoPath, ["worktree", "add", "-q", "-b", branch, path], tmpHome);
    worktrees.push({ branch, path });
  }
  worktreeA = worktrees[1].path;
  seedState(tmpHome, {
    repos: [{ name: REPO, path: repoPath, defaultBranch: "main", worktrees }],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
});

test("a cold worktree releases its file watcher and reloads the open file on reveal", async ({
  page,
}) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const viewerA = new FileViewerPage(page, worktreePage.cachedPanelEntries(WS_A));
  const openSubscriptionsA = worktreePage.trackFileChangeSubscriptions(WS_A);
  await worktreePage.installClock();

  await worktreePage.goto(WS_A);
  await worktreePage.waitForReady();
  await worktreePage.openFileLeaf(FILE, WS_A);
  await viewerA.expectContent("BEFORE-COLD");

  // Leave A, then B, so B is the most recently left (exempt) and A is not.
  await worktreePage.switchWorktree(WS_B);
  await expect(worktreePage.cachedPanelEntries(WS_B)).toBeVisible();
  await worktreePage.switchWorktree(WS_C);
  await expect(worktreePage.cachedPanelEntries(WS_C)).toBeVisible();

  // Hidden but still warm: A's file leaf keeps its watcher.
  await expect.poll(() => openSubscriptionsA(), { timeout: 10_000 }).toBeGreaterThan(0);

  await worktreePage.advanceClock(5 * MINUTE + 1_000);
  await expect.poll(() => openSubscriptionsA(), { timeout: 10_000 }).toBe(0);

  // An edit while A is cold goes unobserved...
  writeFileSync(join(worktreeA, FILE), "CHANGED-WHILE-COLD\n");

  // ...until A is shown again: the leaf resubscribes and reloads once.
  await worktreePage.switchWorktree(WS_A);
  await viewerA.expectContent("CHANGED-WHILE-COLD");
  await expect.poll(() => openSubscriptionsA(), { timeout: 10_000 }).toBeGreaterThan(0);
});
