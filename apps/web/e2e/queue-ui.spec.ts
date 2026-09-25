import { expect, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-queue-test-token";

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, { projects: [] });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

// ---------------------------------------------------------------------------
// Helpers — call the real server's queue store via tRPC HTTP API
// ---------------------------------------------------------------------------

async function trpcMutate(procedure: string, input: unknown): Promise<void> {
  const res = await fetch(`${server.url}/trpc/${procedure}?token=${TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`trpcMutate(${procedure}) failed: ${res.status} ${text}`);
  }
}

async function pushQueue(workspaceId: string, text: string, chatId?: string): Promise<void> {
  await trpcMutate("queue.push", { workspaceId, text, chatId });
}

async function clearQueue(workspaceId: string, chatId?: string): Promise<void> {
  await trpcMutate("queue.clear", { workspaceId, chatId });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("queued messages render with text, Queued badge, and Cancel button", async ({ page }) => {
  const wsId = "test-ws-render";

  // The default layout is a single terminal, so open the chat the queue targets.
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(wsId);
  const chatId = await workspacePage.openChatAndGetId(wsId);

  // Push messages after we know the chatId so they reach the correct queue
  await pushQueue(wsId, "fix the bug", chatId);
  await pushQueue(wsId, "add tests", chatId);

  // Both queued message texts should be visible
  await expect(page.getByText("fix the bug")).toBeVisible();
  await expect(page.getByText("add tests")).toBeVisible();

  // Both should show the "Queued" badge
  const queuedBadges = page.getByText("Queued");
  await expect(queuedBadges).toHaveCount(2);

  // Both should have a Cancel button
  const cancelButtons = page.getByRole("button", { name: "Cancel" });
  await expect(cancelButtons).toHaveCount(2);

  await clearQueue(wsId, chatId);
});

test("empty queue renders no queued message bubbles", async ({ page }) => {
  const wsId = "test-ws-empty";

  // The default layout is a single terminal, so open a chat to observe.
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(wsId);
  await workspacePage.openChat(wsId);

  // Wait for the chat to load — the prompt input should be visible
  await expect(page.getByPlaceholder("Type a message")).toBeVisible();

  // No "Queued" badge should appear
  await expect(page.getByText("Queued")).not.toBeVisible();
});

test("cancel button calls queue.remove and bubble disappears", async ({ page }) => {
  const wsId = "test-ws-cancel";

  // The default layout is a single terminal, so open the chat the queue targets.
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(wsId);
  const chatId = await workspacePage.openChatAndGetId(wsId);

  await pushQueue(wsId, "first message", chatId);
  await pushQueue(wsId, "second message", chatId);

  // Both messages should be visible initially
  await expect(page.getByText("first message")).toBeVisible();
  await expect(page.getByText("second message")).toBeVisible();

  // Click Cancel on the first message
  const cancelButtons = page.getByRole("button", { name: "Cancel" });
  await cancelButtons.first().click();

  // After cancel, the first message should disappear
  await expect(page.getByText("first message")).not.toBeVisible();

  // Second message should still be visible
  await expect(page.getByText("second message")).toBeVisible();

  // Only one "Queued" badge should remain
  await expect(page.getByText("Queued")).toHaveCount(1);

  await clearQueue(wsId, chatId);
});

test("multiple queued messages render in array order", async ({ page }) => {
  const wsId = "test-ws-order";

  // The default layout is a single terminal, so open the chat the queue targets.
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(wsId);
  const chatId = await workspacePage.openChatAndGetId(wsId);

  await pushQueue(wsId, "alpha", chatId);
  await pushQueue(wsId, "beta", chatId);
  await pushQueue(wsId, "gamma", chatId);

  // All three messages should be visible
  await expect(page.getByText("alpha")).toBeVisible();
  await expect(page.getByText("beta")).toBeVisible();
  await expect(page.getByText("gamma")).toBeVisible();

  // Three "Queued" badges
  await expect(page.getByText("Queued")).toHaveCount(3);

  // Verify DOM order: alpha should come before beta, beta before gamma
  const bubbleTexts = await page
    .locator("[class*='is-user']")
    .filter({ has: page.getByText("Queued") })
    .allTextContents();

  const alphaIdx = bubbleTexts.findIndex((t) => t.includes("alpha"));
  const betaIdx = bubbleTexts.findIndex((t) => t.includes("beta"));
  const gammaIdx = bubbleTexts.findIndex((t) => t.includes("gamma"));

  expect(alphaIdx).toBeLessThan(betaIdx);
  expect(betaIdx).toBeLessThan(gammaIdx);

  await clearQueue(wsId, chatId);
});
