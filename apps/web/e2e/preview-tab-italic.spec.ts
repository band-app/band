/**
 * A single-click open from the Explorer tree is a PREVIEW open: the tab is
 * reused for the next single-click and its title renders italic to signal the
 * transient state. Guards that the italic seeds from the tab's initial
 * `preview` param (api.getParameters() can be empty on a freshly-added panel.s
 * first tab render). #643.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { gitInHome as git } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { FileTreesPage } from "./pages/FileTreesPage";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-preview-tab-italic-token";
const PROJECT = "preview-tab-italic-repo";
const BRANCH = "main";
const WORKSPACE = toWorkspaceId(PROJECT, BRANCH);

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repo = join(tmpHome, PROJECT);
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, ["init", "-b", BRANCH]);
  writeFileSync(join(repo, "src/aaa.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "src/bbb.ts"), "export const b = 2;\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: repo,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: repo }],
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

test("single-click tree open is a preview (italic tab)", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const trees = new FileTreesPage(page, workspacePage);
  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();

  await trees.openFilesTab("src");
  await trees.expandFileTreeFolder("src", "src/aaa.ts");
  await trees.openFile("src/aaa.ts");

  const titleSpan = page.getByTestId("center-file-tab--src/aaa.ts").locator("span").first();
  await expect(titleSpan).toBeVisible();
  await expect(titleSpan).toHaveClass(/italic/);
});
