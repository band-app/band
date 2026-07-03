import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
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
import { TasksDialog } from "./pages/TasksDialog";

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// Seeded task ids (from `beforeAll`):
//   tsk_1000 — myapp/main,      completed, has session
//   tsk_2000 — myapp/feat/auth, failed
//   tsk_3000 — backend/main,    running

test("tasks dialog renders and shows seeded tasks", async ({ page }) => {
  const tasks = new TasksDialog(page, server.url, TOKEN);
  await tasks.goto();
  await tasks.open();

  await expect(tasks.card("tsk_1000")).toBeVisible();
  await expect(tasks.card("tsk_2000")).toBeVisible();
  await expect(tasks.card("tsk_3000")).toBeVisible();
});

test("tasks dialog shows status badges", async ({ page }) => {
  const tasks = new TasksDialog(page, server.url, TOKEN);
  await tasks.goto();
  await tasks.open();

  await expect(tasks.statusBadge("completed")).toBeVisible();
  await expect(tasks.statusBadge("failed")).toBeVisible();
  await expect(tasks.statusBadge("running")).toBeVisible();
});

test("filtering by status works", async ({ page }) => {
  const tasks = new TasksDialog(page, server.url, TOKEN);
  await tasks.goto();
  await tasks.open();

  // Wait for tasks to load.
  await expect(tasks.card("tsk_1000")).toBeVisible();

  await tasks.filterByStatus("completed");

  // The completed task stays visible (positive anchor proving the filter
  // applied); the failed + running tasks drop out.
  await expect(tasks.card("tsk_1000")).toBeVisible();
  await expect(tasks.card("tsk_2000")).toHaveCount(0);
  await expect(tasks.card("tsk_3000")).toHaveCount(0);
});

test("filtering by project works", async ({ page }) => {
  const tasks = new TasksDialog(page, server.url, TOKEN);
  await tasks.goto();
  await tasks.open();

  // Wait for tasks to load.
  await expect(tasks.card("tsk_1000")).toBeVisible();

  await tasks.filterByProject("backend");

  // Only the backend task remains (positive anchor); the myapp tasks drop out.
  await expect(tasks.card("tsk_3000")).toBeVisible();
  await expect(tasks.card("tsk_1000")).toHaveCount(0);
  await expect(tasks.card("tsk_2000")).toHaveCount(0);
});

test("empty state shows when no tasks match filters", async ({ page }) => {
  const tasks = new TasksDialog(page, server.url, TOKEN);
  await tasks.goto();
  await tasks.open();

  // Wait for tasks to load.
  await expect(tasks.card("tsk_1000")).toBeVisible();

  // backend + completed matches no seeded task.
  await tasks.filterByProject("backend");
  await tasks.filterByStatus("completed");

  await expect(tasks.emptyState).toBeVisible();
  await expect(tasks.card("tsk_3000")).toHaveCount(0);
});

test("completed task shows session link", async ({ page }) => {
  const tasks = new TasksDialog(page, server.url, TOKEN);
  await tasks.goto();
  await tasks.open();

  // The completed task with a sessionId exposes a session deep-link.
  await expect(tasks.card("tsk_1000")).toBeVisible();
  await expect(tasks.sessionLink.first()).toBeVisible();
});

test("new task dialog opens and shows project/workspace selectors", async ({ page }) => {
  const tasks = new TasksDialog(page, server.url, TOKEN);
  await tasks.goto();
  await tasks.open();

  await expect(tasks.card("tsk_1000")).toBeVisible();

  await tasks.openNewTask();

  await expect(tasks.newTaskProject).toBeVisible();
  await expect(tasks.newTaskWorkspace).toBeVisible();
  await expect(tasks.newTaskPrompt).toBeVisible();
});

test("tasks dialog renders filter controls", async ({ page }) => {
  const tasks = new TasksDialog(page, server.url, TOKEN);
  await tasks.goto();
  await tasks.open();

  await expect(tasks.projectFilter).toBeVisible();
  await expect(tasks.statusFilter).toBeVisible();
});
