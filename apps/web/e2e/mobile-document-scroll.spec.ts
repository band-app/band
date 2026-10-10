/**
 * The mobile layout never lets the document itself scroll; only the panes
 * inside it do. On iOS a scrolled document opened a gap between the composer
 * and the software keyboard and slid the header under iOS 26's top-edge blur
 * (`useAppHeight` in `MobileWorktreeShell.tsx` undoes any document scroll).
 * Also checks that the page head links the web app manifest, which keeps
 * every Band URL inside the home-screen app.
 *
 * Runs in Playwright's WebKit with an iPhone profile (the `webkit-iphone`
 * project in `playwright.config.ts`). Headless WebKit has no
 * software keyboard, no touch fling and no mouse wheel, and its document can't
 * scroll at all. The test adds the extra scroll range iOS gives the page while
 * the keyboard is up, then scrolls the document the way iOS does; the
 * keyboard itself is checked by hand on an iPhone.
 *
 * Real server, no tRPC mocking; the ACP stub agent is the only stub.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { acpStubEnv } from "./helpers/acp-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChatPanePage } from "./pages/ChatPanePage";
import { MobileLayoutPage } from "./pages/MobileLayoutPage";

const TOKEN = "e2e-mobile-document-scroll-token";
const REPO = "docscroll";
const WORKTREE = toWorktreeId(REPO, "main", "local");
const LONG_ANSWER = Array.from(
  { length: 60 },
  (_, i) => `Paragraph ${i + 1} of a long answer that the transcript has to scroll through.`,
).join("\n\n");

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoDir = join(tmpHome, REPO);
  mkdirSync(repoDir, { recursive: true });
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repoDir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoDir }],
      },
    ],
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    defaultCodingAgent: "claude-code",
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, {
      turns: [{ match: "Write a long answer", steps: [{ say: LONG_ANSWER }] }],
    }),
  });
});

// UI state lives on the server now: start each test from none.
test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server?.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
});

test("the page head links the web app manifest", async ({ page }) => {
  const layout = new MobileLayoutPage(page, server.url, TOKEN);
  await layout.gotoDashboard();
  expect(await layout.readManifestHref()).toBe("/manifest.webmanifest");
});

test("the document stays at scroll 0 while the chat transcript scrolls", async ({ page }) => {
  const layout = new MobileLayoutPage(page, server.url, TOKEN);
  const chat = new ChatPanePage(page, server.url, TOKEN);
  await chat.goto(WORKTREE);
  await chat.waitForReady();
  await chat.typeMessage("Write a long answer");
  await chat.tapSend();
  await expect(chat.assistantMessage("Paragraph 60 of a long answer")).toBeVisible();

  // Tap the prompt, the way a tap that opens the keyboard does. Headless
  // WebKit doesn't scroll the document on focus, so this only checks the
  // starting point; the scroll below is what the layout has to undo.
  await chat.tapPrompt();
  await expect.poll(() => layout.readDocumentScroll()).toEqual({ x: 0, y: 0 });

  // iOS scrolls the document while the keyboard is up. The scroll lands, and
  // the layout puts it back to 0.
  await layout.addKeyboardScrollRange(400);
  expect(await layout.scrollDocument(300)).toEqual({ scrolledTo: 300 });
  await expect.poll(() => layout.readDocumentScroll()).toEqual({ x: 0, y: 0 });

  // The transcript stays scrollable, and moving it leaves the document at 0.
  // Touch scrolling inside panes is checked by hand on an iPhone.
  const pinned = await chat.readScrollTop();
  expect(pinned).toBeGreaterThan(0);
  await chat.scrollToTop();
  await expect.poll(() => chat.readScrollTop()).toBe(0);
  await expect.poll(() => layout.readDocumentScroll()).toEqual({ x: 0, y: 0 });
});

test("a scroll made while a sheet locks the page is kept until the sheet closes", async ({
  page,
}) => {
  const layout = new MobileLayoutPage(page, server.url, TOKEN);
  const chat = new ChatPanePage(page, server.url, TOKEN);
  await chat.goto(WORKTREE);
  await chat.waitForReady();
  await layout.openSheet("explorer");

  // iOS scrolls the document to keep a sheet's focused input above the
  // keyboard; the layout leaves that scroll alone while the sheet is open.
  await layout.addKeyboardScrollRange(400);
  expect(await layout.scrollDocument(300)).toEqual({ scrolledTo: 300 });
  expect(await layout.readDocumentScrollAfterFrames()).toEqual({ x: 0, y: 300 });

  await layout.closeSheet();
  await expect.poll(() => layout.readDocumentScroll()).toEqual({ x: 0, y: 0 });
});
