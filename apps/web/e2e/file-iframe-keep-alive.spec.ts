/**
 * An HTML file in Visual mode and a PDF are iframes in a file tab. An iframe reloads when its
 * element is detached, so these tabs stay attached while another tab of the group is selected.
 * The code view still detaches.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { git } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { FileTreesPage } from "./pages/FileTreesPage";
import { HtmlVisualPage } from "./pages/HtmlVisualPage";
import { WorktreePage } from "./pages/WorktreePage";

test.use({ viewport: { width: 1600, height: 900 } });

const TOKEN = "e2e-file-iframe-token";
const REPO_NAME = "file-iframe-repo";
const BRANCH = "main";
const HTML_PATH = "docs/tall.html";
const PDF_PATH = "docs/sample.pdf";
const OTHER_PATH = "docs/notes.txt";
const TALL_HTML = `<!doctype html><html><body style="margin:0"><h1>Tall page</h1><div style="height:4000px"></div><p>bottom</p></body></html>\n`;
const MINIMAL_PDF = `%PDF-1.1
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
trailer<</Root 1 0 R>>
%%EOF
`;

let server: ServerHandle;
let tmpHome: string;
let worktreeId: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(join(repoPath, "docs"), { recursive: true });
  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, HTML_PATH), TALL_HTML);
  writeFileSync(join(repoPath, PDF_PATH), MINIMAL_PDF);
  writeFileSync(join(repoPath, OTHER_PATH), "notes\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);
  seedState(tmpHome, {
    repos: [
      {
        name: REPO_NAME,
        path: repoPath,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: repoPath }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
  worktreeId = toWorktreeId(REPO_NAME, BRANCH, "local");
});

test.beforeEach(async () => {
  await resetClientState(tmpHome);
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

async function openFiles(page: import("@playwright/test").Page, paths: string[]) {
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const trees = new FileTreesPage(page, worktree);
  await worktree.goto(worktreeId);
  await worktree.waitForReady();
  await trees.openFilesTab("docs");
  await trees.expandFileTreeFolder("docs", paths[0]);
  for (const path of paths) await trees.doubleClickFile(path);
  return { worktree, visual: new HtmlVisualPage(page) };
}

test.describe("file tab iframes", () => {
  test("S1, S2: the Visual page loads once and keeps its scroll across tab switches", async ({
    page,
  }) => {
    const { worktree, visual } = await openFiles(page, [OTHER_PATH, HTML_PATH]);
    await visual.openVisual();
    await expect(visual.frame.getByRole("heading", { name: "Tall page" })).toBeVisible();
    await visual.countLoads();
    await visual.markPage();
    await visual.scrollPageTo(1500);
    await expect.poll(() => visual.pageScrollY()).toBe(1500);

    for (let i = 0; i < 3; i++) {
      await worktree.fileTab(OTHER_PATH).click();
      await expect(visual.frameElement).toBeHidden();
      await worktree.fileTab(HTML_PATH).click();
      await expect(visual.frameElement).toBeVisible();
    }

    expect(await visual.loadCount()).toBe(0);
    expect(await visual.pageIsMarked()).toBe(true);
    expect(await visual.pageScrollY()).toBe(1500);
  });

  test("S3: the PDF iframe stays attached while its tab is hidden", async ({ page }) => {
    const { worktree } = await openFiles(page, [OTHER_PATH, PDF_PATH]);
    const frame = page.getByTestId("pdf-preview__frame");
    await expect(frame).toBeVisible();

    await worktree.fileTab(OTHER_PATH).click();
    // Hidden but still in the document, so it is not reloaded when the tab is shown again.
    await expect(frame).toBeHidden();
    await expect(frame).toHaveCount(1);
    await worktree.fileTab(PDF_PATH).click();
    await expect(frame).toBeVisible();
  });

  test("S4: back in code view the hidden tab is detached", async ({ page }) => {
    const { worktree, visual } = await openFiles(page, [OTHER_PATH, HTML_PATH]);
    await visual.openVisual();
    await visual.sourceButton.click();
    await expect(visual.frameElement).toHaveCount(0);

    await worktree.fileTab(OTHER_PATH).click();
    await expect(worktree.fileTab(HTML_PATH)).toBeVisible();
    await expect(visual.frameElement).toHaveCount(0);
    await expect(page.getByTestId("center-file-leaf__view--preview")).toHaveCount(0);
  });
});
