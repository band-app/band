/**
 * A message with an image and no text reaches the agent and stays in the
 * chat history. Before the fix the hub answered 400 "text is required", so
 * the composer showed the message but no turn started and a reload lost it.
 *
 * The real server runs against the scripted ACP stub agent; the test drives
 * the composer through `ChatPanePage`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { acpStubEnv, stubRequests } from "./helpers/acp-stub";
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

const TOKEN = "e2e-chat-image-only-token";
const REPO = "imageonly";
const WORKTREE = toWorktreeId(REPO, "main", "local");
// A 1x1 PNG, the smallest image the composer accepts as an attachment.
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

test("an image-only message starts a turn and survives a reload", async ({ page }) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  await chatPane.goto(WORKTREE);
  await chatPane.waitForReady();

  await chatPane.attachFile({ name: "pixel.png", mimeType: "image/png", buffer: PIXEL_PNG });
  await expect(chatPane.submitButton).toBeEnabled();
  await chatPane.submitButton.click();

  await expect(chatPane.userMessagesWithImage).toHaveCount(1);
  await expect(chatPane.assistantMessage("Heard")).toBeVisible();

  const [sent] = stubRequests(tmpHome, "session/prompt");
  const blocks = sent.params.prompt as { type: string; text?: string }[];
  expect(blocks.some((b) => b.type === "image")).toBe(true);
  expect(blocks.filter((b) => b.type === "text").every((b) => b.text?.trim())).toBe(true);

  await chatPane.reload();
  await chatPane.waitForReady();
  await expect(chatPane.userMessagesWithImage).toHaveCount(1);
  await expect(chatPane.assistantMessage("Heard")).toBeVisible();
});

test("a message with no text and no image cannot be sent", async ({ page }) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  await chatPane.goto(WORKTREE);
  await chatPane.waitForReady();

  // The first test's chat is still in this worktree, so compare against what is there now.
  const before = await chatPane.userMessagesWithImage.count();
  await expect(chatPane.submitButton).toBeDisabled();
  await chatPane.submit();
  await expect(chatPane.userMessagesWithImage).toHaveCount(before);
  await expect(chatPane.thinkingIndicator).not.toBeVisible();
});
