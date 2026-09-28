/**
 * The chat composer and find in the chat.
 *
 *   - The prompt is a one-line field with the send button in its bottom
 *     right corner, and it grows as the text gets more lines. The settings
 *     (mode, model, context) sit in a row below the field.
 *   - The execution mode menu and the model trigger carry no icons.
 *   - The context ring next to the model is always shown, with no setting to
 *     turn it on. Its numbers are the agent's ACP `usage_update`: tokens used
 *     out of the window size, and the cost the agent reports.
 *   - Cmd/Ctrl+F in a chat opens a find widget that counts the matches in
 *     the conversation, highlights them, and steps through them, scrolling
 *     a message that isn't mounted (the list is virtualized) into view.
 *
 * Architecture: the REAL `dist/start-server.mjs` against a fresh temp home,
 * the ACP stub agent for both chats (a scripted `usage_update` for the
 * composer, a seeded session for find), and the UI driven through
 * `ChatPanePage`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { acpStubEnv, type SeededTurn, seedStubSession } from "./helpers/acp-stub";
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
import { ChatPanePage } from "./pages/ChatPanePage";

const TOKEN = "e2e-chat-composer-find-token";
const COMPOSER_PROJECT = "composer";
const FIND_PROJECT = "findchat";
const COMPOSER_WORKSPACE = toWorkspaceId(COMPOSER_PROJECT, "main");
const FIND_WORKSPACE = toWorkspaceId(FIND_PROJECT, "main");
const FIND_CHAT_ID = "find-chat-deterministic-id";
const FIND_SESSION_ID = "22222222-3333-4444-5555-666666666666";
const NEEDLE = "zebra-token";
/** Turns whose text holds the needle: the agent's reply in 1, 9 and 17, the
 *  user's prompt in 5. */
const NEEDLE_TURNS = new Set([1, 5, 9, 17]);
const TURNS = 20;

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const projects = [COMPOSER_PROJECT, FIND_PROJECT].map((name) => {
    const path = join(tmpHome, name);
    mkdirSync(path, { recursive: true });
    return { name, path, defaultBranch: "main", worktrees: [{ branch: "main", path }] };
  });
  seedState(tmpHome, { projects });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    defaultCodingAgent: "claude-code",
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });

  seedStubSession(tmpHome, {
    sessionId: FIND_SESSION_ID,
    cwd: projects[1].path,
    turns: buildTurns(),
  });

  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, {
      turns: [
        {
          match: "report usage",
          steps: [
            { say: "Usage reported." },
            {
              usage: { used: 50_000, size: 200_000, cost: { amount: 0.042, currency: "USD" } },
            },
          ],
        },
      ],
    }),
  });

  await trpcMutate(server.url, TOKEN, "chats.create", {
    workspaceId: FIND_WORKSPACE,
    id: FIND_CHAT_ID,
    agent: "claude-code",
  });
  await trpcMutate(server.url, TOKEN, "chats.setActiveSession", {
    workspaceId: FIND_WORKSPACE,
    chatId: FIND_CHAT_ID,
    sessionId: FIND_SESSION_ID,
  });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  if (server) await server.close();
  cleanupTmpHome(tmpHome);
});

test("the prompt is one line with send in its corner and grows with more lines", async ({
  page,
}) => {
  const chat = new ChatPanePage(page, server.url, TOKEN);
  await chat.goto(COMPOSER_WORKSPACE);
  await chat.waitForReady();
  await expect(chat.modeMenuButton).toBeVisible();
  await expect(chat.modelMenuButton).toBeVisible();

  const empty = await chat.composerGeometry();
  // One line: the field is no taller than the send button plus its padding.
  expect(empty.body.height).toBeLessThan(empty.submit.height * 1.8);
  // Send sits in the field's bottom right corner.
  const bodyRight = empty.body.x + empty.body.width;
  const bodyBottom = empty.body.y + empty.body.height;
  expect(bodyRight - (empty.submit.x + empty.submit.width)).toBeLessThanOrEqual(8);
  expect(bodyBottom - (empty.submit.y + empty.submit.height)).toBeLessThanOrEqual(8);
  // The settings row is below the field, mode on the left, model and
  // context on the right with the ring after the model.
  expect(empty.modeMenu.y).toBeGreaterThanOrEqual(bodyBottom);
  expect(empty.modelMenu.y).toBeGreaterThanOrEqual(bodyBottom);
  expect(empty.modeMenu.x).toBeLessThan(empty.modelMenu.x);
  expect(empty.contextMeter.x).toBeGreaterThan(empty.modelMenu.x);

  await chat.typeLines(["first line", "second line", "third line"]);
  const grown = await chat.composerGeometry();
  expect(grown.prompt.height).toBeGreaterThan(empty.prompt.height * 2);
  // Send stays in the bottom right corner of the taller field.
  expect(
    grown.body.y + grown.body.height - (grown.submit.y + grown.submit.height),
  ).toBeLessThanOrEqual(8);
});

test("the mode menu and model trigger carry no icons", async ({ page }) => {
  const chat = new ChatPanePage(page, server.url, TOKEN);
  await chat.goto(COMPOSER_WORKSPACE);
  await chat.waitForReady();

  await expect(chat.modelMenuModel).toHaveText("Stub Small");
  expect(await chat.iconCount(chat.modelMenuButton)).toBe(0);
  expect(await chat.iconCount(chat.modeMenuButton)).toBe(0);

  await chat.openModeMenu();
  await expect(chat.modeMenuItems).toHaveText([/Default/, /Plan/]);
  expect(await chat.iconCount(chat.modeMenuItems)).toBe(0);
});

test("the context ring is always shown and reports the agent's usage_update", async ({ page }) => {
  const chat = new ChatPanePage(page, server.url, TOKEN);
  await chat.goto(COMPOSER_WORKSPACE);
  await chat.waitForReady();

  // Shown with no setting turned on, empty until the agent reports usage.
  await expect(chat.contextMeter).toHaveAccessibleName("Context window: no usage yet");

  await chat.typeMessage("report usage");
  await chat.submit();
  await expect(chat.assistantMessage("Usage reported.")).toBeVisible();

  await expect(chat.contextMeter).toHaveAccessibleName("Context window: 25% of 200k");
  await chat.hoverContextMeter();
  await expect(chat.contextMeterDetails).toContainText("Context: 50,000 / 200,000 (25%)");
  await expect(chat.contextMeterDetails).toContainText("Cost: $0.042");
});

test("Cmd/Ctrl+F finds text in the conversation and steps through the matches", async ({
  page,
}) => {
  const chat = new ChatPanePage(page, server.url, TOKEN);
  await chat.goto(FIND_WORKSPACE);
  await chat.waitForReady();
  await expect(chat.assistantMessage(replyText(TURNS - 1))).toBeVisible({ timeout: 30_000 });

  await chat.openFind();
  await chat.find.type(NEEDLE);
  await expect(chat.find.count).toHaveText(new RegExp(`^\\d/${NEEDLE_TURNS.size}$`));
  await expect.poll(async () => (await chat.findHighlights()).current).toBe(NEEDLE);

  // Step until the first match (turn 1, far above the viewport and not
  // mounted) is current. It scrolls into view and is highlighted.
  for (let i = 0; i < NEEDLE_TURNS.size; i++) {
    if ((await chat.find.count.textContent()) === `1/${NEEDLE_TURNS.size}`) break;
    await chat.find.press("Enter");
  }
  await expect(chat.find.count).toHaveText(`1/${NEEDLE_TURNS.size}`);
  await expect(chat.assistantMessage(replyText(1))).toBeInViewport();
  await expect
    .poll(() => chat.findHighlights())
    .toMatchObject({ current: NEEDLE, currentInView: true });

  // The user's prompt in turn 5 is the next match.
  await chat.find.press("Enter");
  await expect(chat.find.count).toHaveText(`2/${NEEDLE_TURNS.size}`);
  await expect(chat.userMessage(promptText(5))).toBeInViewport();
  await expect
    .poll(() => chat.findHighlights())
    .toMatchObject({ current: NEEDLE, currentInView: true });

  // Shift+Enter goes back.
  await chat.find.press("Shift+Enter");
  await expect(chat.find.count).toHaveText(`1/${NEEDLE_TURNS.size}`);

  // Matching is case-insensitive until Match Case is on.
  await chat.find.type(NEEDLE.toUpperCase());
  await expect(chat.find.count).toHaveText(new RegExp(`/${NEEDLE_TURNS.size}$`));
  await chat.find.matchCaseToggle.click();
  await chat.find.expectNoResults();

  // Escape closes the widget, clears the highlights and returns to the prompt.
  await chat.find.type(NEEDLE);
  await chat.find.press("Escape");
  await expect(chat.find.root).toHaveCount(0);
  await expect(chat.promptInput).toBeFocused();
  await expect.poll(async () => (await chat.findHighlights()).total).toBe(0);
});

function buildTurns(): SeededTurn[] {
  return Array.from({ length: TURNS }, (_, i) => ({ user: promptText(i), agent: replyText(i) }));
}

function promptText(turn: number): string {
  return turn === 5 ? `prompt ${turn} asks about the ${NEEDLE}` : `prompt ${turn}`;
}

function replyText(turn: number): string {
  return NEEDLE_TURNS.has(turn) && turn !== 5
    ? `reply ${turn} mentions the ${NEEDLE} here`
    : `reply ${turn}`;
}
