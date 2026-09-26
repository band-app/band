/**
 * The file leaf's "View changes" header button only renders while that file
 * has changes against the workspace's diff target (default: uncommitted). It
 * reads the same changes summary the Changes panel uses, and a save refetches
 * it, so the button appears when a save makes the file differ from HEAD and
 * disappears when a save makes it match again.
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
import { FileViewerPage } from "./pages/FileViewerPage";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-file-leaf-view-changes-token";
const PROJECT = "file-leaf-view-changes-repo";
const BRANCH = "main";
const WORKSPACE = toWorkspaceId(PROJECT, BRANCH);

const CLEAN_FILE = "clean.txt";
const CHANGED_FILE = "changed.txt";
// No trailing newline, so retyping it in the editor restores the committed bytes.
const CLEAN_ORIGINAL = "clean original text";
const CLEAN_EDITED = "clean edited text";

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repo = join(tmpHome, PROJECT);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", BRANCH], tmpHome);
  writeFileSync(join(repo, CLEAN_FILE), CLEAN_ORIGINAL);
  writeFileSync(join(repo, CHANGED_FILE), "changed original\n");
  git(repo, ["add", "."], tmpHome);
  git(repo, ["commit", "-m", "initial"], tmpHome);
  // An uncommitted edit, so changed.txt shows up in the Changes summary.
  writeFileSync(join(repo, CHANGED_FILE), "changed modified\n");
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

test("View changes shows only for a file with changes and follows saves", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  // Scoped to the visible file leaf: both leaves stay mounted once opened.
  const viewer = new FileViewerPage(page, workspacePage.fileLeafVisibilityMarker(true));

  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();

  // A file with uncommitted changes gets the button. This also proves the
  // changes summary has loaded before the negative check below.
  await workspacePage.openFileViaQuickOpen(CHANGED_FILE);
  await viewer.expectContent("changed modified");
  await expect(workspacePage.fileLeafViewChangesButton).toBeVisible({ timeout: 15_000 });

  // A clean file does not.
  await workspacePage.openFileViaQuickOpen(CLEAN_FILE);
  await viewer.expectContent(CLEAN_ORIGINAL);
  await expect(workspacePage.fileLeafViewChangesButton).toBeHidden();

  // Saving an edit makes it changed: the button appears.
  await viewer.replaceAll(CLEAN_EDITED);
  await workspacePage.saveFileLeaf();
  await expect(workspacePage.fileLeafViewChangesButton).toBeVisible({ timeout: 15_000 });

  // Saving it back to the committed content makes it clean: the button goes.
  await viewer.replaceAll(CLEAN_ORIGINAL);
  await workspacePage.saveFileLeaf();
  await expect(workspacePage.fileLeafViewChangesButton).toBeHidden({ timeout: 15_000 });
});
