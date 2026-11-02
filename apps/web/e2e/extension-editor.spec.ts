/**
 * End-to-end coverage for editor extensions (docs/extensions.md): a fixture extension in
 * `<BAND_HOME>/extensions/text-editor` edits `*.band-test` files in a sandboxed iframe. The real
 * server serves the extension, `GET` and `PUT /api/worktree-file` carry the bytes, and the
 * file watch reloads other windows. No tRPC mocking.
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { trpcMutate } from "./helpers/trpc";
import { ExtensionEditorPage, FIXTURE_EDITOR_REF } from "./pages/ExtensionEditorPage";
import { FileTreesPage } from "./pages/FileTreesPage";
import { WorktreePage } from "./pages/WorktreePage";

test.use({ viewport: { width: 1600, height: 900 } });

const TOKEN = "e2e-extension-editor-token";
const REPO_NAME = "extension-editor-repo";
const BRANCH = "main";
const NOTE = "dir/note.band-test";
const OTHER = "dir/other.band-test";
const PLAIN = "dir/plain.txt";
const FIXTURE = join(import.meta.dirname, "fixtures", "extensions", "text-editor");

let server: ServerHandle;
let tmpHome: string;
let repoPath: string;
let worktreeId: string;

function extensionDir(): string {
  return join(tmpHome, ".band", "extensions", "text-editor");
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", BRANCH]);
  const files: Record<string, string> = {
    [NOTE]: "hello extension\n",
    [OTHER]: "second file\n",
    [PLAIN]: "plain text\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repoPath, rel)), { recursive: true });
    writeFileSync(join(repoPath, rel), content);
  }
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
  cpSync(FIXTURE, extensionDir(), { recursive: true });
  server = await startServer({ tmpHome });
  worktreeId = toWorktreeId(REPO_NAME, BRANCH, "local");
});

test.beforeEach(async () => {
  resetClientState(tmpHome);
  writeFileSync(join(repoPath, NOTE), "hello extension\n");
  writeFileSync(join(repoPath, OTHER), "second file\n");
  // An earlier test may have removed the extension; put it back and have the hub read it again.
  if (!existsDir(extensionDir())) {
    cpSync(FIXTURE, extensionDir(), { recursive: true });
    await trpcMutate(server.url, TOKEN, "extensions.reload", {});
  }
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

function existsDir(path: string): boolean {
  try {
    readFileSync(join(path, "band-extension.json"));
    return true;
  } catch {
    return false;
  }
}

async function setup(page: import("@playwright/test").Page) {
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const trees = new FileTreesPage(page, worktree);
  const editor = new ExtensionEditorPage(page, worktree, trees);
  await worktree.goto(worktreeId);
  await worktree.waitForReady();
  await editor.revealFile("dir", NOTE);
  return { worktree, trees, editor };
}

test("S1: the extension's tab shows the file's text", async ({ page }) => {
  const { editor } = await setup(page);

  await editor.open(NOTE);

  await expect(editor.textarea(NOTE)).toHaveValue("hello extension\n");
});

test("S2: Cmd+S saves to disk and the dirty dot shows during the edit and clears after", async ({
  page,
}) => {
  const { editor } = await setup(page);
  await editor.open(NOTE);

  await editor.replaceText(NOTE, "edited in the extension\n");
  await expect(editor.dirtyDot(NOTE)).toBeVisible();
  await editor.save(NOTE);

  await expect(editor.dirtyDot(NOTE)).toHaveCount(0);
  await expect(editor.status(NOTE)).toHaveText("saved");
  expect(readFileSync(join(repoPath, NOTE), "utf8")).toBe("edited in the extension\n");
});

test("S3: another window reloads after a save, or asks when it has unsaved edits", async ({
  page,
  browser,
}) => {
  const a = await setup(page);
  await a.editor.open(NOTE);

  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const pageB = await context.newPage();
  const b = await setup(pageB);
  await b.editor.open(NOTE);

  await a.editor.replaceText(NOTE, "from window A\n");
  await a.editor.save(NOTE);
  await expect(b.editor.textarea(NOTE)).toHaveValue("from window A\n");
  await expect(b.editor.conflictBanner).toHaveCount(0);

  // B now has unsaved edits of its own, so A's next save asks instead of replacing them.
  await b.editor.replaceText(NOTE, "unsaved in B\n");
  await expect(b.editor.dirtyDot(NOTE)).toBeVisible();
  await a.editor.replaceText(NOTE, "second save from A\n");
  await a.editor.save(NOTE);
  await expect(b.editor.conflictBanner).toBeVisible();
  await expect(b.editor.textarea(NOTE)).toHaveValue("unsaved in B\n");

  await b.editor.loadTheirs.click();
  await expect(b.editor.textarea(NOTE)).toHaveValue("second save from A\n");
  await expect(b.editor.conflictBanner).toHaveCount(0);
  await context.close();
});

test("S4: a change made on disk reloads the tab, or asks when it has unsaved edits", async ({
  page,
}) => {
  const { editor } = await setup(page);
  await editor.open(NOTE);

  writeFileSync(join(repoPath, NOTE), "changed by something else\n");
  await expect(editor.textarea(NOTE)).toHaveValue("changed by something else\n");

  await editor.replaceText(NOTE, "my unsaved edit\n");
  writeFileSync(join(repoPath, NOTE), "changed again\n");
  await expect(editor.conflictBanner).toBeVisible();
  await expect(editor.textarea(NOTE)).toHaveValue("my unsaved edit\n");

  await editor.keepMine.click();
  await expect(editor.conflictBanner).toHaveCount(0);
  await expect(editor.textarea(NOTE)).toHaveValue("my unsaved edit\n");
});

test("S6: Open With lists the extension and the built-in viewer, a default persists, a removed extension falls back", async ({
  page,
}) => {
  const { worktree, trees, editor } = await setup(page);

  // Explorer menu: both choices; the built-in viewer opens the code viewer.
  await trees.openFileTreeMenu(NOTE);
  await page.getByTestId("file-tree__open-with").click();
  await expect(editor.openWithItem("file-tree", FIXTURE_EDITOR_REF)).toBeVisible();
  await expect(editor.openWithItem("file-tree", "builtin")).toBeVisible();
  await editor.openWithItem("file-tree", "builtin").click();
  await expect(page.getByTestId("file-viewer__root")).toBeVisible();
  await expect(editor.editor(NOTE)).toHaveCount(0);

  // Tab menu: switch the open tab to the extension, then make the built-in viewer the default.
  await editor.switchTabEditor(NOTE, FIXTURE_EDITOR_REF);
  await expect(editor.editor(NOTE)).toHaveAttribute("data-ready", "true");
  await editor.setTabDefault(NOTE, "builtin");
  await expect(page.getByTestId("file-viewer__root")).toBeVisible();

  // The default survives a reload and applies to another file of the same kind.
  await page.reload();
  await worktree.waitForReady();
  await editor.revealFile("dir", OTHER);
  await trees.clickFile(OTHER);
  await expect(page.getByTestId("file-viewer__root")).toBeVisible();
  await expect(editor.editor(OTHER)).toHaveCount(0);

  // A removed extension falls back to the built-in viewer.
  await editor.openFromExplorerWith(OTHER, FIXTURE_EDITOR_REF);
  await expect(editor.editor(OTHER)).toHaveAttribute("data-ready", "true");
  rmSync(extensionDir(), { recursive: true, force: true });
  await trpcMutate(server.url, TOKEN, "extensions.reload", {});
  await page.reload();
  await worktree.waitForReady();
  await expect(page.getByTestId("file-viewer__root")).toBeVisible();
  await expect(editor.editor(OTHER)).toHaveCount(0);
});

test("S9: the frame reaches nothing of Band, and /ext sets no cookie", async ({
  page,
  request,
}) => {
  const { editor } = await setup(page);
  await editor.open(NOTE);

  const report = JSON.parse((await editor.probe(NOTE).textContent()) ?? "{}");
  expect(report.origin).toBe("null");
  expect(report.cookie).toBe("threw");
  expect(report.localStorage).toBe("threw");
  expect(report.parentDom).toBe("threw");
  expect(report.parentStorage).toBe("threw");

  const res = await request.get(`${server.url}/ext/text-editor/index.html`);
  expect(res.status()).toBe(200);
  expect(res.headers()["set-cookie"]).toBeUndefined();
  expect(res.headers()["access-control-allow-origin"]).toBe("*");
});

test("S8: the tab moved to a second group keeps its document and unsaved edit", async ({
  page,
}) => {
  const { worktree, trees, editor } = await setup(page);
  await trees.doubleClickFile(NOTE);
  await expect(editor.editor(NOTE)).toHaveAttribute("data-ready", "true");
  await trees.doubleClickFile(OTHER);
  await expect(editor.editor(OTHER)).toHaveAttribute("data-ready", "true");
  await worktree.fileTab(NOTE).click();
  await editor.replaceText(NOTE, "unsaved while moving\n");
  await expect(editor.dirtyDot(NOTE)).toBeVisible();

  const layout = new (await import("./pages/CenterLayout")).CenterLayout(page);
  await layout.dragTab(`file:${NOTE}`, 0, "right");
  await expect(layout.groups).toHaveCount(2);

  await worktree.fileTab(NOTE).click();
  await expect(editor.textarea(NOTE)).toHaveValue("unsaved while moving\n");
  await expect(editor.dirtyDot(NOTE)).toBeVisible();
  await expect(editor.status(NOTE)).not.toHaveText("starting");
  await editor.save(NOTE);
  await expect(editor.dirtyDot(NOTE)).toHaveCount(0);
  expect(readFileSync(join(repoPath, NOTE), "utf8")).toBe("unsaved while moving\n");
});
