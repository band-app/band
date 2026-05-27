import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, type Page, test } from "@playwright/test";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";

const TOKEN = "e2e-test-token";

let server: ServerHandle;
let tmpHome: string;

// All test-side writes to the same `band.db` the server is using must
// set `busy_timeout` so a concurrent server transaction doesn't fail
// us with `SQLITE_BUSY: database is locked`. Phase-B cleanup,
// branch-status-poller writes, and the task store all hold the
// write lock briefly — on CI with 2 workers the test's open + write
// can land exactly inside one of those windows and fail outright
// instead of waiting. 5 s is generous enough to absorb a runner
// stall but short enough that a truly deadlocked server still fails
// fast. (Pre-existing flake surfaced by issue #508's e2e test;
// reads stay readOnly and need no timeout under WAL mode.)
const DB_BUSY_TIMEOUT_MS = 5_000;

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
  const dbPath = join(tmpHome, ".band", "band.db");
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
  const db = drizzle({ client: sqlite });
  migrate(db, { migrationsFolder: join(import.meta.dirname, "../src/server/infra/db/migrations") });
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO tasks (id, workspace_id, project, branch, prompt, status, session_id, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      task.id,
      task.workspaceId,
      task.project,
      task.branch,
      task.prompt,
      task.status,
      task.sessionId ?? null,
      task.startedAt,
      task.completedAt ?? null,
    );
  sqlite.close();
}

function readTaskStatus(tmpHome: string, taskId: string): string | undefined {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"), { readOnly: true });
  try {
    const row = sqlite.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as
      | { status: string }
      | undefined;
    return row?.status;
  } finally {
    sqlite.close();
  }
}

function deleteTask(tmpHome: string, taskId: string): void {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"));
  try {
    sqlite.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
    sqlite.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
  } finally {
    sqlite.close();
  }
}

/**
 * Open the Tasks dialog from the dashboard's hamburger ("Menu") toolbar
 * dropdown. Returns the dialog locator for further interaction. Use after
 * `page.goto` has loaded the dashboard.
 */
async function openTasksDialog(page: Page) {
  // The dashboard React app fetches projects via tRPC on mount, so the
  // toolbar's React click handlers may not be bound by the time `load`
  // fires. Wait for the network to settle before driving the dropdown.
  await page.waitForLoadState("networkidle");
  const trigger = page.locator('button[aria-label="Menu"]');
  // Retry the open until the menu actually appears — covers any remaining
  // hydration race between the click reaching the DOM and React binding
  // the dropdown's onClick.
  await expect(async () => {
    await trigger.click();
    await expect(page.getByRole("menu")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await page.getByRole("menuitem", { name: "Tasks" }).click();
  const dialog = page.getByRole("dialog", { name: "Tasks" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const projectPath = join(tmpHome, "projects", "myapp");
  const backendPath = join(tmpHome, "projects", "backend");
  seedState(tmpHome, {
    projects: [
      {
        name: "myapp",
        path: projectPath,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: projectPath },
          { branch: "feat/auth", path: join(tmpHome, "projects", "myapp-auth") },
        ],
      },
      {
        name: "backend",
        path: backendPath,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: backendPath }],
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

  // Sentinel "running" row that boot-time `cleanupStaleTasks()` is
  // guaranteed to flip to `failed`. Issue #477 moved that cleanup out
  // of the await-blocking boot path and into a `setImmediate` after
  // `httpServer.listen()`, so the listen banner can arrive before
  // cleanup writes land. Without this sentinel, the orphan-running
  // row we seed below would race cleanup and get re-flipped to
  // `failed`, breaking the "Running" badge assertion.
  seedTask(tmpHome, {
    id: "tsk_cleanup_sentinel",
    workspaceId: "myapp-main",
    project: "myapp",
    branch: "main",
    prompt: "sentinel — flipped to failed by Phase B cleanup",
    status: "running",
    startedAt: Date.now() - 86400_000,
  });

  server = await startServer({ tmpHome });

  // Wait for Phase-B cleanup to flip the sentinel. Once it has, any
  // future "running" row we seed will survive untouched on this boot.
  for (let attempt = 0; attempt < 200; attempt++) {
    if (readTaskStatus(tmpHome, "tsk_cleanup_sentinel") === "failed") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  // Remove the sentinel so it doesn't show up in the dashboard's
  // tasks dialog and skew the per-status badge / count assertions.
  deleteTask(tmpHome, "tsk_cleanup_sentinel");

  // Now seed the running task we want the dashboard to render with
  // the "Running" badge. Cleanup has already executed for this boot,
  // so this row stays as-is.
  seedTask(tmpHome, {
    id: "tsk_3000",
    workspaceId: "backend-main",
    project: "backend",
    branch: "main",
    prompt: "Optimize database queries",
    status: "running",
    startedAt: Date.now() - 60_000,
  });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.beforeEach(async ({ page }) => {
  await page.goto(`${server.url}/?token=${TOKEN}`);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("tasks dialog renders and shows seeded tasks", async ({ page }) => {
  const dialog = await openTasksDialog(page);

  await expect(dialog.getByText("Add authentication to the API")).toBeVisible();
  await expect(dialog.getByText("Fix login validation bug")).toBeVisible();
  await expect(dialog.getByText("Optimize database queries")).toBeVisible();
});

test("tasks dialog shows status badges", async ({ page }) => {
  const dialog = await openTasksDialog(page);

  // Scope badge checks to task cards to avoid matching select dropdown options.
  // The card outline is `rounded-lg border-2` — match either width so this
  // doesn't break the next time we re-tune the border thickness.
  const cards = dialog.locator(".rounded-lg.border-2, .rounded-lg.border");
  await expect(cards.getByText("Completed")).toBeVisible();
  await expect(cards.getByText("Failed")).toBeVisible();
  await expect(cards.getByText("Running")).toBeVisible();
});

test("filtering by status works", async ({ page }) => {
  const dialog = await openTasksDialog(page);

  // Wait for tasks to load
  await expect(dialog.getByText("Add authentication to the API")).toBeVisible();

  // Open status filter dropdown (second select trigger) and pick "completed"
  await dialog.locator('[data-slot="select-trigger"]').nth(1).click();
  await page.getByRole("option", { name: "completed" }).click();

  // Only the completed task should be visible
  await expect(dialog.getByText("Add authentication to the API")).toBeVisible();
  await expect(dialog.getByText("Fix login validation bug")).not.toBeVisible();
  await expect(dialog.getByText("Optimize database queries")).not.toBeVisible();
});

test("filtering by project works", async ({ page }) => {
  const dialog = await openTasksDialog(page);

  // Wait for tasks to load
  await expect(dialog.getByText("Add authentication to the API")).toBeVisible();

  // Select "backend" project from dropdown
  await dialog.locator('[data-slot="select-trigger"]').first().click();
  await page.getByRole("option", { name: "backend" }).click();

  // Only the backend task should be visible
  await expect(dialog.getByText("Optimize database queries")).toBeVisible();
  await expect(dialog.getByText("Add authentication to the API")).not.toBeVisible();
  await expect(dialog.getByText("Fix login validation bug")).not.toBeVisible();
});

test("empty state shows when no tasks match filters", async ({ page }) => {
  const dialog = await openTasksDialog(page);

  // Wait for tasks to load
  await expect(dialog.getByText("Add authentication to the API")).toBeVisible();

  // Select "backend" project + "completed" status — no tasks match
  await dialog.locator('[data-slot="select-trigger"]').first().click();
  await page.getByRole("option", { name: "backend" }).click();
  await dialog.locator('[data-slot="select-trigger"]').nth(1).click();
  await page.getByRole("option", { name: "completed" }).click();

  await expect(dialog.getByText("No tasks found")).toBeVisible();
  await expect(dialog.getByText("Try adjusting your filters")).toBeVisible();
});

test("completed task shows session link", async ({ page }) => {
  const dialog = await openTasksDialog(page);

  // The completed task with a sessionId should have a "Session" link
  await expect(dialog.getByText("Add authentication to the API")).toBeVisible();
  const sessionLink = dialog.getByRole("link", { name: "Session" });
  await expect(sessionLink.first()).toBeVisible();
});

test("new task dialog opens and shows project/workspace selectors", async ({ page }) => {
  const dialog = await openTasksDialog(page);

  // Wait for the tasks dialog to load
  await expect(dialog.getByText("Add authentication to the API")).toBeVisible();

  // Click "New Task" button (inside the Tasks dialog)
  await dialog.getByRole("button", { name: "New Task" }).click();

  // Nested "New Task" dialog should open with form elements
  await expect(page.getByText("Dispatch a new task to a coding agent")).toBeVisible();
  await expect(page.getByText("Project", { exact: true })).toBeVisible();
  await expect(page.getByText("Workspace", { exact: true })).toBeVisible();
  await expect(page.getByText("Prompt", { exact: true })).toBeVisible();
});

test("tasks dialog renders filter controls", async ({ page }) => {
  const dialog = await openTasksDialog(page);
  await expect(dialog.getByText("All Projects")).toBeVisible();
});
