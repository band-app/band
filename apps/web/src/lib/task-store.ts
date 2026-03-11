import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@band/logger";
import { tasksDir } from "./state";

const log = createLogger("task-store");

export type TaskStatus = "running" | "completed" | "failed";

export interface TaskRecord {
  id: string;
  workspaceId: string;
  project: string;
  branch: string;
  prompt: string;
  status: TaskStatus;
  sessionId?: string;
  startedAt: number;
  completedAt?: number;
}

export interface TaskFilters {
  project?: string;
  workspaceId?: string;
  status?: TaskStatus;
}

export function generateTaskId(): string {
  return `tsk_${Date.now()}`;
}

export function ensureTasksDir(): void {
  mkdirSync(tasksDir(), { recursive: true });
}

export function saveTask(task: TaskRecord): void {
  ensureTasksDir();
  const filePath = join(tasksDir(), `${task.id}.json`);
  writeFileSync(filePath, JSON.stringify(task, null, 2), "utf-8");
}

export function loadTask(id: string): TaskRecord | null {
  try {
    const filePath = join(tasksDir(), `${id}.json`);
    const data = readFileSync(filePath, "utf-8");
    return JSON.parse(data) as TaskRecord;
  } catch {
    return null;
  }
}

export function listTasks(filters?: TaskFilters): TaskRecord[] {
  const dir = tasksDir();
  const tasks: TaskRecord[] = [];

  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = readFileSync(join(dir, file), "utf-8");
        const task = JSON.parse(data) as TaskRecord;
        if (matchesFilters(task, filters)) {
          tasks.push(task);
        }
      } catch (err) {
        log.warn({ file, err }, "skipping invalid task file");
      }
    }
  } catch {
    // Tasks dir may not exist yet
  }

  // Newest first
  tasks.sort((a, b) => b.startedAt - a.startedAt);
  return tasks;
}

/**
 * Mark all persisted "running" tasks as "failed".
 * Called on server start before listening — no agent can be running if the server just started.
 */
export function cleanupStaleTasks(): number {
  const staleTasks = listTasks({ status: "running" });
  for (const task of staleTasks) {
    task.status = "failed";
    task.completedAt = Date.now();
    saveTask(task);
    log.info({ taskId: task.id, workspaceId: task.workspaceId }, "marked stale task as failed");
  }
  if (staleTasks.length > 0) {
    log.info({ count: staleTasks.length }, "cleaned up stale tasks on startup");
  }
  return staleTasks.length;
}

/**
 * Mark a persisted task as "failed" by ID.
 * Returns the updated record, or null if not found or already not running.
 */
export function markTaskFailed(id: string): TaskRecord | null {
  const task = loadTask(id);
  if (!task || task.status !== "running") return null;
  task.status = "failed";
  task.completedAt = Date.now();
  saveTask(task);
  return task;
}

function matchesFilters(task: TaskRecord, filters?: TaskFilters): boolean {
  if (!filters) return true;
  if (filters.project && task.project !== filters.project) return false;
  if (filters.workspaceId && task.workspaceId !== filters.workspaceId) return false;
  if (filters.status && task.status !== filters.status) return false;
  return true;
}
