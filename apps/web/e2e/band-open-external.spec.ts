/**
 * `band open <abs path outside the worktree>` opens a focused external tab.
 *
 * The spec calls the real `editor.openFile` procedure (what the CLI calls), so the hub emits
 * the real `open-file` event with `external: true`. No route or procedure is mocked.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { gitInHome as git } from "./helpers/git";
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
import { FileViewerPage } from "./pages/FileViewerPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-band-open-external-token";
const REPO = "band-open-external-repo";
const BRANCH = "main";
const WORKTREE = toWorktreeId(REPO, BRANCH, "local");
const PDF = `%PDF-1.1
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
trailer<</Root 1 0 R>>
%%EOF
`;

test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome: string | undefined;
let outside!: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, REPO);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", BRANCH], tmpHome);
  writeFileSync(join(repoPath, "inside.ts"), "export const inside = 1;\n");
  git(repoPath, ["add", "."], tmpHome);
  git(repoPath, ["commit", "-m", "seed"], tmpHome);

  outside = realpathSync(mkdtempSync(join(tmpdir(), "band-open-external-")));
  writeFileSync(join(outside, "doc.pdf"), PDF);
  writeFileSync(join(outside, "note.txt"), "band-open-external-note\n");
  const lines = Array.from(
    { length: 300 },
    (_, i) => `const line${i + 1} = "marker-line-${i + 1}";`,
  );
  writeFileSync(join(outside, "long.ts"), `${lines.join("\n")}\n`);

  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repoPath,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: repoPath }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => {
  if (tmpHome) resetClientState(tmpHome);
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
  if (outside) rmSync(outside, { recursive: true, force: true });
});

async function ready(page: import("@playwright/test").Page): Promise<WorktreePage> {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();
  return worktreePage;
}

test.describe("band open on a file outside the worktree", () => {
  test("S1: opens and focuses an external tab", async ({ page }) => {
    const worktreePage = await ready(page);
    const path = join(outside, "note.txt");
    await trpcMutate(server.url, TOKEN, "editor.openFile", {
      worktreeId: WORKTREE,
      filePath: path,
    });

    await expect(worktreePage.fileTab(path)).toBeAttached({ timeout: 15_000 });
    await expect
      .poll(async () => (await worktreePage.readOpenTabsState(WORKTREE))?.active)
      .toBe(path);
    await new FileViewerPage(page).expectContent("band-open-external-note");
  });

  test("S2: a PDF shows the PDF preview", async ({ page }) => {
    const worktreePage = await ready(page);
    const path = join(outside, "doc.pdf");
    await trpcMutate(server.url, TOKEN, "editor.openFile", {
      worktreeId: WORKTREE,
      filePath: path,
    });

    await expect(worktreePage.fileTab(path)).toBeAttached({ timeout: 15_000 });
    await expect(new FileViewerPage(page).pdfFrame).toBeVisible({ timeout: 15_000 });
  });

  test("S3: a line scrolls to that line", async ({ page }) => {
    const worktreePage = await ready(page);
    const path = join(outside, "long.ts");
    await trpcMutate(server.url, TOKEN, "editor.openFile", {
      worktreeId: WORKTREE,
      filePath: path,
      line: 250,
    });

    await expect(worktreePage.fileTab(path)).toBeAttached({ timeout: 15_000 });
    // CodeMirror renders only the viewport, so line 250 in the DOM means it scrolled there.
    await new FileViewerPage(page).expectContent("marker-line-250");
  });
});
