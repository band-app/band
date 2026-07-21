/**
 * The unified center dockview renders each active leaf's actions in the group
 * header (next to Maximize), not inside the tab content (#643). This guards the
 * file leaf's side of that: opening a markdown file publishes its preview/source
 * toggle to the header, and doing so must NOT trigger an infinite render loop
 * (a regression where FileViewer.onActionsChange re-fired every render because it
 * depended on the inline renderMarkdown function reference).
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
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-center-leaf-header-actions-token";
const PROJECT = "center-leaf-header-repo";
const BRANCH = "main";
const WORKSPACE = toWorkspaceId(PROJECT, BRANCH);

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repo = join(tmpHome, PROJECT);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", BRANCH]);
  writeFileSync(join(repo, "README.md"), "# Title\n\nsome **markdown** body\n");
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

test("opening a markdown file leaf does not trigger an infinite render loop", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();

  // Open README.md via Quick Open.
  await workspacePage.openQuickOpen();
  await workspacePage.typeQuickOpen("README");
  await expect.poll(() => workspacePage.quickOpenItems.count()).toBeGreaterThan(0);
  await workspacePage.pressQuickOpenKey("Enter");

  // The file leaf renders and the markdown preview/source toggle is published
  // to the group header (proves the actions plumbing works, not just no crash).
  await expect(workspacePage.fileTab("README.md")).toBeAttached({ timeout: 15_000 });
  await expect(page.getByTestId("center-file-leaf__view--source")).toBeVisible({ timeout: 15_000 });

  // Give any runaway effect a chance to blow the stack, then assert none did.
  await expect
    .poll(() => errors.filter((e) => /Maximum update depth/i.test(e)).length, { timeout: 3_000 })
    .toBe(0);
});
