import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";

const TOKEN = "e2e-test-token";

let server: ServerHandle;
let tmpHome: string;

function seedTask(
  tmpHome: string,
  task: {
    id: string;
    workspaceId: string;
    project: string;
    branch: string;
    prompt: string;
    status: "running" | "completed" | "failed";
    sessionId?: string;
    startedAt: number;
    completedAt?: number;
  },
): void {
  const tasksDir = join(tmpHome, ".band", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, `${task.id}.json`), JSON.stringify(task));
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    projects: [
      {
        name: "myapp",
        path: "/tmp/myapp",
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: "/tmp/myapp" },
          { branch: "feat/auth", path: "/tmp/myapp-auth" },
        ],
      },
      {
        name: "backend",
        path: "/tmp/backend",
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: "/tmp/backend" }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });

  seedTask(tmpHome, {
    id: "tsk_1000",
    workspaceId: "myapp-main",
    project: "myapp",
    branch: "main",
    prompt: "Add authentication to the API",
    status: "completed",
    sessionId: "session_abc",
    startedAt: Date.now() - 3600_000,
    completedAt: Date.now() - 3500_000,
  });

  seedTask(tmpHome, {
    id: "tsk_2000",
    workspaceId: "myapp-feat/auth",
    project: "myapp",
    branch: "feat/auth",
    prompt: "Fix login validation bug",
    status: "failed",
    startedAt: Date.now() - 7200_000,
    completedAt: Date.now() - 7100_000,
  });

  seedTask(tmpHome, {
    id: "tsk_3000",
    workspaceId: "backend-main",
    project: "backend",
    branch: "main",
    prompt: "Optimize database queries",
    status: "running",
    startedAt: Date.now() - 60_000,
  });

  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("tasks page renders and shows seeded tasks", async ({ page }) => {
  await page.goto(`${server.url}/tasks?token=${TOKEN}`);

  await expect(page.getByText("Add authentication to the API")).toBeVisible();
  await expect(page.getByText("Fix login validation bug")).toBeVisible();
  await expect(page.getByText("Optimize database queries")).toBeVisible();
});

test("tasks page shows status badges", async ({ page }) => {
  await page.goto(`${server.url}/tasks?token=${TOKEN}`);

  await expect(page.getByText("Completed")).toBeVisible();
  await expect(page.getByText("Failed")).toBeVisible();
  await expect(page.getByText("Running")).toBeVisible();
});

test("filtering by status works", async ({ page }) => {
  await page.goto(`${server.url}/tasks?token=${TOKEN}`);

  // Wait for tasks to load
  await expect(page.getByText("Add authentication to the API")).toBeVisible();

  // Click "completed" status filter
  await page.getByRole("button", { name: "completed" }).click();

  // Only the completed task should be visible
  await expect(page.getByText("Add authentication to the API")).toBeVisible();
  await expect(page.getByText("Fix login validation bug")).not.toBeVisible();
  await expect(page.getByText("Optimize database queries")).not.toBeVisible();
});

test("filtering by project works", async ({ page }) => {
  await page.goto(`${server.url}/tasks?token=${TOKEN}`);

  // Wait for tasks to load
  await expect(page.getByText("Add authentication to the API")).toBeVisible();

  // Select "backend" project from dropdown
  await page.locator('[data-slot="select-trigger"]').first().click();
  await page.getByRole("option", { name: "backend" }).click();

  // Only the backend task should be visible
  await expect(page.getByText("Optimize database queries")).toBeVisible();
  await expect(page.getByText("Add authentication to the API")).not.toBeVisible();
  await expect(page.getByText("Fix login validation bug")).not.toBeVisible();
});

test("empty state shows when no tasks match filters", async ({ page }) => {
  await page.goto(`${server.url}/tasks?token=${TOKEN}`);

  // Wait for tasks to load
  await expect(page.getByText("Add authentication to the API")).toBeVisible();

  // Select "backend" project + "completed" status — no tasks match
  await page.locator('[data-slot="select-trigger"]').first().click();
  await page.getByRole("option", { name: "backend" }).click();
  await page.getByRole("button", { name: "completed" }).click();

  await expect(page.getByText("No tasks found")).toBeVisible();
  await expect(page.getByText("Try adjusting your filters")).toBeVisible();
});

test("completed task shows session link", async ({ page }) => {
  await page.goto(`${server.url}/tasks?token=${TOKEN}`);

  // The completed task with a sessionId should have a "Session" link
  await expect(page.getByText("Add authentication to the API")).toBeVisible();
  const sessionLink = page.getByRole("link", { name: "Session" });
  await expect(sessionLink.first()).toBeVisible();
});

test("new task dialog opens and shows project/workspace selectors", async ({ page }) => {
  await page.goto(`${server.url}/tasks?token=${TOKEN}`);

  // Wait for page to load
  await expect(page.getByText("Add authentication to the API")).toBeVisible();

  // Click "New Task" button
  await page.getByRole("button", { name: "New Task" }).click();

  // Dialog should open with form elements
  await expect(page.getByText("Dispatch a new task to a coding agent")).toBeVisible();
  await expect(page.getByText("Project", { exact: true })).toBeVisible();
  await expect(page.getByText("Workspace", { exact: true })).toBeVisible();
  await expect(page.getByText("Prompt", { exact: true })).toBeVisible();
});

test("back button navigates to dashboard", async ({ page }) => {
  await page.goto(`${server.url}/tasks?token=${TOKEN}`);
  await expect(page.locator("h1", { hasText: "Tasks" })).toBeVisible();

  // Click the back arrow
  const backLink = page.locator("a[href='/']");
  await expect(backLink).toBeVisible();
});
