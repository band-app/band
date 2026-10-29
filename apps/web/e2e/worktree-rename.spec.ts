/**
 * Renaming a worktree's displayed title from the sidebar card.
 *
 * Real production hub against a temp `~/.band/` with one real git repo. A title is stored on the
 * hub, so a reload shows it again, and clearing it brings the name back.
 *
 * Covers: Rename… from the context menu and the title surviving a reload (S1), clearing the title
 * by double-click (S2), Escape cancelling (S3) and the tooltip keeping the branch (S4).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
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
import { trpcMutate } from "./helpers/trpc";
import { RenameWorktreePage } from "./pages/RenameWorktreePage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-worktree-rename-token";
const WORKTREE = "app-feat-x";

test.use({ viewport: { width: 1280, height: 900 } });
test.describe.configure({ mode: "serial" });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const app = join(tmpHome, "app");
  mkdirSync(app, { recursive: true });
  gitInHome(app, ["init", "-b", "main"], tmpHome);
  writeFileSync(join(app, "README.md"), "# app\n");
  gitInHome(app, ["add", "."], tmpHome);
  gitInHome(app, ["commit", "-m", "initial"], tmpHome);
  const checkout = join(tmpHome, "feat-x-checkout");
  gitInHome(app, ["worktree", "add", "-b", "feat-x", checkout], tmpHome);
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  seedState(tmpHome, {
    repos: [
      {
        name: "app",
        path: app,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: app },
          { branch: "feat-x", path: checkout },
        ],
      },
    ],
  });
  server = await startServer({ tmpHome });
});

test.beforeEach(async () => {
  resetClientState(tmpHome);
  await trpcMutate(server.url, TOKEN, "worktrees.setTitle", { worktreeId: WORKTREE, title: null });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

async function open(page: import("@playwright/test").Page) {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto("app-main");
  await worktreePage.waitForReady();
  return new RenameWorktreePage(page);
}

test("S1: Rename… from the context menu shows the title, and a reload keeps it", async ({
  page,
}) => {
  const rename = await open(page);
  await expect(rename.title(WORKTREE)).toHaveText("feat-x");
  await rename.renameFromMenu(WORKTREE, "Login revamp");
  await expect(rename.title(WORKTREE)).toHaveText("Login revamp");
  await rename.reload();
  await expect(rename.title(WORKTREE)).toHaveText("Login revamp");
});

test("S2: clearing the title by double-click brings the name back", async ({ page }) => {
  await trpcMutate(server.url, TOKEN, "worktrees.setTitle", {
    worktreeId: WORKTREE,
    title: "Login revamp",
  });
  const rename = await open(page);
  await expect(rename.title(WORKTREE)).toHaveText("Login revamp");
  await rename.startEditingByDoubleClick(WORKTREE);
  await rename.type("");
  await rename.press("Enter");
  await expect(rename.title(WORKTREE)).toHaveText("feat-x");
});

test("S3: Escape saves nothing", async ({ page }) => {
  await trpcMutate(server.url, TOKEN, "worktrees.setTitle", {
    worktreeId: WORKTREE,
    title: "Login revamp",
  });
  const rename = await open(page);
  await rename.startEditingByDoubleClick(WORKTREE);
  await rename.type("Something else");
  await rename.press("Escape");
  await expect(rename.input).toHaveCount(0);
  await expect(rename.title(WORKTREE)).toHaveText("Login revamp");
  await rename.reload();
  await expect(rename.title(WORKTREE)).toHaveText("Login revamp");
});

test("S4: the tooltip of a renamed worktree still shows the branch", async ({ page }) => {
  await trpcMutate(server.url, TOKEN, "worktrees.setTitle", {
    worktreeId: WORKTREE,
    title: "Login revamp",
  });
  const rename = await open(page);
  const tooltip = await rename.hoverTooltip(WORKTREE);
  await expect(tooltip).toContainText("app/feat-x");
  await expect(tooltip).toContainText("Login revamp");
});
