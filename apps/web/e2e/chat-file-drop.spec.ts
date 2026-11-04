/**
 * Dropping files on the chat pane in a browser: attachable types attach, anything else gets a
 * notice, and a "Drop to attach" overlay shows only while files are dragged over the pane.
 *
 * The real server runs against the scripted ACP stub. A real file-manager drag cannot be
 * automated, so the drag events are dispatched on the page with real `File` objects.
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

const TOKEN = "e2e-chat-file-drop-token";
const REPO = "filedrop";
const WORKTREE = toWorktreeId(REPO, "main", "local");
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoDir = join(tmpHome, "repo");
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
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  server = await startServer({ tmpHome, env: acpStubEnv(tmpHome) });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

async function openChat(page: import("@playwright/test").Page): Promise<ChatPanePage> {
  const chat = new ChatPanePage(page, server.url, TOKEN);
  await chat.goto(WORKTREE);
  await chat.waitForReady();
  return chat;
}

test("S4: a PNG dropped on the message list attaches; a .ts file gets a browser notice", async ({
  page,
}) => {
  const chat = await openChat(page);

  await chat.startDrag({
    files: [{ name: "pixel.png", mimeType: "image/png", buffer: PIXEL_PNG }],
  });
  await chat.dropOnChat("messages");
  await expect(chat.attachments).toHaveCount(1);
  await expect(chat.attachments.first()).toHaveAttribute("data-file-name", "pixel.png");

  await chat.startDrag({
    files: [{ name: "app.ts", mimeType: "video/mp2t", buffer: Buffer.from("export {};\n") }],
  });
  await chat.dropOnChat("messages");
  await expect(chat.composerNotice).toContainText("dropped in a browser");
  await expect(chat.attachments).toHaveCount(1);
  expect(await chat.promptValue()).toBe("");
});

test("S4: an attachable file with no media type attaches by its extension", async ({ page }) => {
  const chat = await openChat(page);
  await chat.startDrag({
    files: [
      { name: "notes.md", mimeType: "application/octet-stream", buffer: Buffer.from("# hi") },
    ],
  });
  await chat.dropOnChat("composer");
  await expect(chat.attachments).toHaveCount(1);
});

test("S5: the overlay shows while files are dragged over the pane and goes away on leave or drop", async ({
  page,
}) => {
  const chat = await openChat(page);

  // Text and other non-file drags never show it.
  await chat.startDrag({ text: "some text" });
  await chat.dragEvent("dragover", "messages");
  await expect(chat.dropOverlay).toHaveCount(0);

  await chat.startDrag({
    files: [{ name: "pixel.png", mimeType: "image/png", buffer: PIXEL_PNG }],
  });
  await chat.dragEvent("dragenter", "messages");
  await chat.dragEvent("dragover", "messages");
  await expect(chat.dropOverlay).toBeVisible();
  await expect(chat.dropOverlay).toContainText("Drop to attach");

  // The drag leaves the pane (or the window).
  await chat.dragEvent("dragleave", "messages");
  await expect(chat.dropOverlay).toHaveCount(0);

  await chat.dragEvent("dragover", "composer");
  await expect(chat.dropOverlay).toBeVisible();
  await chat.dropOnChat("composer");
  await expect(chat.dropOverlay).toHaveCount(0);
  await expect(chat.attachments).toHaveCount(1);
});

test("S6 (web): a file dropped outside the chat is not left to navigate the page", async ({
  page,
}) => {
  const chat = await openChat(page);
  await chat.startDrag({
    files: [{ name: "pixel.png", mimeType: "image/png", buffer: PIXEL_PNG }],
  });
  expect(await chat.dropOutsideChat()).toBe(true);
});
