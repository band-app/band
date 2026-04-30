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
// Helpers
// ---------------------------------------------------------------------------

/**
 * UIMessage-format part — matches the format returned by the server's
 * sessions.messages endpoint after conversion.
 */
type UIPart =
  | { type: "text"; text: string }
  | {
      type: "dynamic-tool";
      toolCallId: string;
      toolName: string;
      state: "input-available" | "output-available" | "output-error";
      input?: unknown;
      output?: string;
      errorText?: string;
      title?: string;
    };

interface UIMessageFixture {
  role: "user" | "assistant";
  id: string;
  parts: UIPart[];
}

function installSessionMock(mock: ReturnType<typeof createTrpcMock>, messages: UIMessageFixture[]) {
  mock.addDockviewMocks();
  mock.query("sessions.list", {
    sessions: [
      {
        sessionId: "s1",
        summary: "Test session",
        lastModified: Date.now() - 60_000,
      },
    ],
    supported: true,
  });
  mock.query("sessions.messages", () => ({
    messages,
    firstEventId: null,
    lastEventId: null,
    hasMore: false,
  }));
}

async function loadSession(page: import("@playwright/test").Page) {
  const clockButton = page.locator("button").filter({ has: page.locator("svg.lucide-clock") });
  await expect(clockButton).toBeVisible();
  await clockButton.click();
  // Use menuitem role to match DropdownMenuItem (avoids matching the dockview tab title)
  await page.getByRole("menuitem", { name: /Test session/ }).click();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("TodoWrite renders as a task list widget, not a generic tool call", async ({ page }) => {
  const mock = createTrpcMock();
  installSessionMock(mock, [
    {
      role: "user",
      id: "m1",
      parts: [{ type: "text", text: "Help me with this project" }],
    },
    {
      role: "assistant",
      id: "m2",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tc1",
          toolName: "TodoWrite",
          state: "output-available",
          input: {
            todos: [
              { content: "Setup project", status: "completed" },
              { content: "Write tests", status: "in_progress" },
              { content: "Deploy to prod", status: "pending" },
            ],
          },
          output: "ok",
        },
      ],
    },
    {
      role: "assistant",
      id: "m4",
      parts: [{ type: "text", text: "Here is your todo list." }],
    },
  ]);
  await mock.install(page);

  await page.goto(`${server.url}/workspace/test-workspace?token=${TOKEN}`);
  await loadSession(page);

  // The TaskListWidget should render
  await expect(page.getByText("Todos")).toBeVisible();
  await expect(page.getByText("1/3")).toBeVisible();

  // All task subjects visible
  await expect(page.getByText("Setup project")).toBeVisible();
  await expect(page.getByText("Write tests")).toBeVisible();
  await expect(page.getByText("Deploy to prod")).toBeVisible();

  // No collapsible ToolCall with "TodoWrite" in its title
  await expect(page.locator("button", { hasText: "TodoWrite" })).not.toBeVisible();
});

test("completed todos show strikethrough styling", async ({ page }) => {
  const mock = createTrpcMock();
  installSessionMock(mock, [
    {
      role: "user",
      id: "m1",
      parts: [{ type: "text", text: "Track tasks" }],
    },
    {
      role: "assistant",
      id: "m2",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tc1",
          toolName: "TodoWrite",
          state: "output-available",
          input: {
            todos: [
              { content: "First done", status: "completed" },
              { content: "Second done", status: "completed" },
              { content: "Still pending", status: "pending" },
            ],
          },
          output: "ok",
        },
      ],
    },
  ]);
  await mock.install(page);

  await page.goto(`${server.url}/workspace/test-workspace?token=${TOKEN}`);
  await loadSession(page);

  await expect(page.getByText("2/3")).toBeVisible();

  // Completed tasks should have line-through class
  const firstDone = page.getByText("First done");
  await expect(firstDone).toBeVisible();
  await expect(firstDone).toHaveClass(/line-through/);

  const secondDone = page.getByText("Second done");
  await expect(secondDone).toBeVisible();
  await expect(secondDone).toHaveClass(/line-through/);

  // Pending task should NOT have line-through
  const pending = page.getByText("Still pending");
  await expect(pending).toBeVisible();
  await expect(pending).not.toHaveClass(/line-through/);
});

test("in-progress todos show activeForm text instead of subject", async ({ page }) => {
  const mock = createTrpcMock();
  installSessionMock(mock, [
    {
      role: "user",
      id: "m1",
      parts: [{ type: "text", text: "Work on tests" }],
    },
    {
      role: "assistant",
      id: "m2",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tc1",
          toolName: "TodoWrite",
          state: "output-available",
          input: {
            todos: [
              {
                content: "Write tests",
                status: "in_progress",
                activeForm: "Writing tests",
              },
              { content: "Review PR", status: "pending" },
            ],
          },
          output: "ok",
        },
      ],
    },
  ]);
  await mock.install(page);

  await page.goto(`${server.url}/workspace/test-workspace?token=${TOKEN}`);
  await loadSession(page);

  // The activeForm text should be shown for the in-progress task
  await expect(page.getByText("Writing tests")).toBeVisible();

  // The subject "Write tests" should NOT be visible (replaced by activeForm)
  await expect(page.getByText("Write tests", { exact: true })).not.toBeVisible();

  // The pending task shows its subject normally
  await expect(page.getByText("Review PR")).toBeVisible();
});

test("multiple TodoWrite calls in same message collapse into one widget showing final state", async ({
  page,
}) => {
  const mock = createTrpcMock();
  installSessionMock(mock, [
    {
      role: "user",
      id: "m1",
      parts: [{ type: "text", text: "Build the feature" }],
    },
    {
      role: "assistant",
      id: "m2",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tc1",
          toolName: "TodoWrite",
          state: "output-available",
          input: {
            todos: [
              { content: "Research API", status: "in_progress" },
              { content: "Implement endpoint", status: "pending" },
            ],
          },
          output: "ok",
        },
        {
          type: "dynamic-tool",
          toolCallId: "tc2",
          toolName: "TodoWrite",
          state: "output-available",
          input: {
            todos: [
              { content: "Research API", status: "completed" },
              { content: "Implement endpoint", status: "completed" },
              { content: "Write tests", status: "in_progress" },
            ],
          },
          output: "ok",
        },
        { type: "text", text: "Making progress on the implementation." },
      ],
    },
  ]);
  await mock.install(page);

  await page.goto(`${server.url}/workspace/test-workspace?token=${TOKEN}`);
  await loadSession(page);

  // Only ONE Todos widget should be rendered (both calls in same message)
  const todosHeaders = page.getByText("Todos");
  await expect(todosHeaders).toHaveCount(1);

  // The final state: 2 completed out of 3
  await expect(page.getByText("2/3")).toBeVisible();

  // All 3 items from the second call should be visible
  await expect(page.getByText("Research API")).toBeVisible();
  await expect(page.getByText("Implement endpoint")).toBeVisible();
  await expect(page.getByText("Write tests")).toBeVisible();
});

test("task list is hidden when all todos are completed", async ({ page }) => {
  const mock = createTrpcMock();
  installSessionMock(mock, [
    {
      role: "user",
      id: "m1",
      parts: [{ type: "text", text: "Finish everything" }],
    },
    {
      role: "assistant",
      id: "m2",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tc1",
          toolName: "TodoWrite",
          state: "output-available",
          input: {
            todos: [
              { content: "Setup project", status: "completed" },
              { content: "Write tests", status: "completed" },
              { content: "Deploy to prod", status: "completed" },
            ],
          },
          output: "ok",
        },
      ],
    },
    {
      role: "assistant",
      id: "m4",
      parts: [{ type: "text", text: "All done!" }],
    },
  ]);
  await mock.install(page);

  await page.goto(`${server.url}/workspace/test-workspace?token=${TOKEN}`);
  await loadSession(page);

  // The assistant text should be visible
  await expect(page.getByText("All done!")).toBeVisible();

  // The TaskListWidget should NOT be rendered since all tasks are completed
  await expect(page.getByText("Todos")).not.toBeVisible();
});

test("TodoWrite mixed with regular tool calls renders both correctly", async ({ page }) => {
  const mock = createTrpcMock();
  installSessionMock(mock, [
    {
      role: "user",
      id: "m1",
      parts: [{ type: "text", text: "Help me fix the bug" }],
    },
    {
      role: "assistant",
      id: "m2",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "tc1",
          toolName: "TodoWrite",
          state: "output-available",
          input: {
            todos: [
              { content: "Investigate bug", status: "in_progress" },
              { content: "Apply fix", status: "pending" },
            ],
          },
          output: "ok",
        },
        {
          type: "dynamic-tool",
          toolCallId: "tc2",
          toolName: "Read",
          state: "output-available",
          input: { file_path: "/src/app.ts" },
          output: "const app = express();",
          title: "Read(/src/app.ts)",
        },
      ],
    },
    {
      role: "assistant",
      id: "m4",
      parts: [{ type: "text", text: "I found the issue." }],
    },
  ]);
  await mock.install(page);

  await page.goto(`${server.url}/workspace/test-workspace?token=${TOKEN}`);
  await loadSession(page);

  // The TaskListWidget should be visible
  await expect(page.getByText("Todos")).toBeVisible();
  await expect(page.getByText("0/2")).toBeVisible();

  // The Read tool call should render as a collapsible ToolCall
  await expect(page.locator("button", { hasText: "Read(/src/app.ts)" })).toBeVisible();
});
