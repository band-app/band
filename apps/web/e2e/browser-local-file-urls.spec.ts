/**
 * Typing a local file location into a browser tab's address bar opens the
 * file through the hub's signed worktree preview route.
 *
 * Real hub, real git worktree. The harness is the web build in plain
 * Chromium, so `HtmlPreviewPage` stubs the Electron bridge and the tab's
 * URL is read from the hub's saved tab record (the `<webview>` has no
 * engine behind it). Not covered: the page rendering inside Electron.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { removeBrowserTabs } from "./helpers/browser-tabs";
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
import { HtmlPreviewPage } from "./pages/HtmlPreviewPage";
import { WorktreePage } from "./pages/WorktreePage";

test.use({ viewport: { width: 2400, height: 900 } });

const TOKEN = "e2e-local-file-urls-token";
const REPO_NAME = "local-file-urls-repo";
const BRANCH = "main";
const DECK = "docs/deck.html";
const SPACED = "docs/My Deck.html";
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const DECK_HTML = `<!doctype html><link rel="stylesheet" href="style.css"><img src="${PIXEL}"><p>the deck</p>`;

let server: ServerHandle;
let tmpHome: string;
let repoPath: string;
let worktreeId: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(join(repoPath, "docs"), { recursive: true });
  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, DECK), DECK_HTML);
  writeFileSync(join(repoPath, SPACED), DECK_HTML);
  writeFileSync(join(repoPath, "docs", "style.css"), "p { color: rgb(1, 2, 3); }");
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
  await removeBrowserTabs(server.url, TOKEN, worktreeId);
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

/** Open a browser tab (through the Preview button) and return its page object. */
async function openBrowserTab(page: import("@playwright/test").Page): Promise<HtmlPreviewPage> {
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const trees = new FileTreesPage(page, worktree);
  const preview = new HtmlPreviewPage(page, server.url, TOKEN);
  await preview.installDesktopBridgeStub();
  await worktree.goto(worktreeId);
  await worktree.waitForReady();
  await trees.openFilesTab("docs");
  await trees.expandFileTreeFolder("docs", DECK);
  await trees.openFile(DECK);
  await preview.clickPreview();
  await preview.expectSingleTabUrl(worktreeId);
  await expect(preview.addressBar).toBeVisible();
  return preview;
}

async function savedUrlEndingWith(preview: HtmlPreviewPage, suffix: string): Promise<string> {
  let url = "";
  await expect
    .poll(async () => {
      url = await preview.expectSingleTabUrl(worktreeId);
      return url.endsWith(suffix);
    })
    .toBe(true);
  return url;
}

test.describe("local file URLs in the address bar", () => {
  const forms: Array<[string, () => string]> = [
    ["file:///<path>", () => `file://${repoPath}/${DECK}#3`],
    ["file://<path without the leading slash>", () => `file://${repoPath.slice(1)}/${DECK}#3`],
    ["a bare absolute path", () => `${repoPath}/${DECK}#3`],
  ];

  for (const [label, build] of forms) {
    test(`${label} opens the file with its stylesheet and keeps the fragment`, async ({ page }) => {
      const preview = await openBrowserTab(page);
      const typed = build();
      await preview.submitAddress(typed);

      const url = await savedUrlEndingWith(preview, "#3");
      expect(url).toContain(`/api/worktree-preview/${encodeURIComponent(worktreeId)}/`);
      await expect(preview.addressBar).toHaveValue(typed);
      const rendered = await preview.openInSecondPage(url.replace(/#3$/, ""), "local-file");
      expect(rendered.color).toBe("rgb(1, 2, 3)");
      expect(rendered.text).toBe("the deck");
    });
  }

  test("a path with spaces opens", async ({ page }) => {
    const preview = await openBrowserTab(page);
    await preview.submitAddress(`file://${repoPath}/docs/My%20Deck.html`);

    const url = await savedUrlEndingWith(preview, "My%20Deck.html");
    const rendered = await preview.openInSecondPage(url, "local-file-spaces");
    expect(rendered.text).toBe("the deck");
  });

  test("a path outside every worktree shows the in-view error and requests nothing", async ({
    page,
  }) => {
    const preview = await openBrowserTab(page);
    const before = await preview.expectSingleTabUrl(worktreeId);
    const requested: string[] = [];
    page.on("request", (r) => requested.push(r.url()));

    await preview.submitAddress("file:///etc/hosts");

    await expect(preview.localFileError).toBeVisible();
    await expect(preview.addressBar).toHaveValue("file:///etc/hosts");
    expect(await preview.expectSingleTabUrl(worktreeId)).toBe(before);
    expect(requested.filter((u) => /https:\/\/(etc|www\.google)/.test(u))).toEqual([]);
  });

  test("ordinary input still gets https:// or a search", async ({ page }) => {
    const preview = await openBrowserTab(page);

    await preview.submitAddress("example.com");
    await expect(preview.addressBar).toHaveValue("https://example.com");
    await expect(preview.localFileError).toHaveCount(0);

    await preview.submitAddress("some words");
    await expect(preview.addressBar).toHaveValue("https://www.google.com/search?q=some%20words");
  });
});
