import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { createTrpcMock } from "./helpers/trpc-mock";

const TOKEN = "e2e-test-token";

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
  rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("sessions load and display in the session list", async ({ page }) => {
  const mock = createTrpcMock();
  mock.addDockviewMocks();
  mock.query("sessions.list", {
    sessions: [
      {
        sessionId: "s1",
        summary: "Fix login bug",
        lastModified: Date.now() - 60_000 * 5,
        gitBranch: "fix-login",
      },
      {
        sessionId: "s2",
        summary: "Add tests",
        lastModified: Date.now() - 60_000 * 120,
      },
    ],
    supported: true,
  });
  await mock.install(page);

  await page.goto(`${server.url}/workspace/test-workspace?token=${TOKEN}`);

  // The clock button should be visible since sessions are supported
  const clockButton = page.locator("button").filter({ has: page.locator("svg.lucide-clock") });
  await expect(clockButton).toBeVisible();

  // Click the clock button to open the session list
  await clockButton.click();

  // Verify session summaries are displayed in the session list
  // Use the session list button locator to avoid matching the dockview tab title
  await expect(page.getByRole("button", { name: /Fix login bug/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Add tests/ })).toBeVisible();

  // Verify git branch badge
  await expect(page.getByText("fix-login")).toBeVisible();

  // Verify relative times
  await expect(page.getByText("5m ago")).toBeVisible();
  await expect(page.getByText("2h ago")).toBeVisible();
});

test("empty state shows 'No sessions yet' message", async ({ page }) => {
  const mock = createTrpcMock();
  mock.addDockviewMocks();
  mock.query("sessions.list", { sessions: [], supported: true });
  await mock.install(page);

  await page.goto(`${server.url}/workspace/test-workspace?token=${TOKEN}`);

  // Open session list
  const clockButton = page.locator("button").filter({ has: page.locator("svg.lucide-clock") });
  await expect(clockButton).toBeVisible();
  await clockButton.click();

  await expect(page.getByText("No sessions yet")).toBeVisible();
});

test("session toggle is hidden when not supported", async ({ page }) => {
  const mock = createTrpcMock();
  mock.addDockviewMocks();
  mock.query("sessions.list", { sessions: [], supported: false });
  await mock.install(page);

  await page.goto(`${server.url}/workspace/test-workspace?token=${TOKEN}`);

  // Wait for the page to settle — the chat prompt input should be visible
  await expect(page.getByPlaceholder("Type a message")).toBeVisible();

  // The clock button should NOT be present
  const clockButton = page.locator("button").filter({ has: page.locator("svg.lucide-clock") });
  await expect(clockButton).not.toBeVisible();
});

test("selecting a session loads its messages", async ({ page }) => {
  const mock = createTrpcMock();
  mock.addDockviewMocks();
  mock.query("sessions.list", {
    sessions: [
      {
        sessionId: "s1",
        summary: "Fix login bug",
        lastModified: Date.now() - 60_000,
      },
    ],
    supported: true,
  });
  mock.query("sessions.messages", () => ({
    messages: [
      {
        role: "user" as const,
        id: "m1",
        parts: [{ type: "text" as const, text: "Please fix the login bug" }],
      },
      {
        role: "assistant" as const,
        id: "m2",
        parts: [{ type: "text" as const, text: "I found the issue in auth.ts and fixed it." }],
      },
    ],
    firstEventId: null,
    lastEventId: null,
    hasMore: false,
  }));
  await mock.install(page);

  await page.goto(`${server.url}/workspace/test-workspace?token=${TOKEN}`);

  // Open session list
  const clockButton = page.locator("button").filter({ has: page.locator("svg.lucide-clock") });
  await expect(clockButton).toBeVisible();
  await clockButton.click();

  // Click the session (use role locator to avoid matching the dockview tab title)
  await page.getByRole("button", { name: /Fix login bug/ }).click();

  // Verify historical messages render
  await expect(page.getByText("Please fix the login bug")).toBeVisible();
  await expect(page.getByText("I found the issue in auth.ts and fixed it.")).toBeVisible();
});
