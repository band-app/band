import { toWorkspaceId } from "@band-app/dashboard-core";
import { createLogger } from "@band-app/logger";
import { Cron } from "croner";
import { eq } from "drizzle-orm";
import { getOrCreateDefaultChat } from "./chat-manager";
import { listAllCronjobs, loadCronjobFile } from "./cronjob-store";
import type { CronjobDefinition } from "./cronjob-types";
import { getDb } from "./db/connection";
import { cronjobs } from "./db/schema";
import { loadState } from "./state";
import { submitTask, TaskConflictError } from "./task-runner";

const log = createLogger("cronjob-scheduler");

// ---------------------------------------------------------------------------
// Shared state (globalThis symbol pattern — same as task-runner.ts)
// ---------------------------------------------------------------------------

const SCHEDULER_KEY = Symbol.for("band.cronjob-scheduler");
const g = globalThis as unknown as Record<symbol, unknown>;

interface SchedulerState {
  /** Map of cronjob id → active Cron instance */
  jobs: Map<string, Cron>;
  /** Whether the scheduler has been started */
  started: boolean;
}

if (!g[SCHEDULER_KEY]) {
  g[SCHEDULER_KEY] = {
    jobs: new Map<string, Cron>(),
    started: false,
  } satisfies SchedulerState;
}

const state = g[SCHEDULER_KEY] as SchedulerState;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function scheduleJob(job: CronjobDefinition, fileKey: string): void {
  // Stop existing if re-scheduling
  const existing = state.jobs.get(job.id);
  if (existing) {
    existing.stop();
    state.jobs.delete(job.id);
  }

  if (!job.enabled) return;

  try {
    const cronInstance = new Cron(job.cronExpression, () => {
      executeCronjob(job, fileKey).catch((err) => {
        log.error({ jobId: job.id, err }, "unhandled error in cronjob execution");
      });
    });

    state.jobs.set(job.id, cronInstance);
    log.info(
      { jobId: job.id, name: job.name, cron: job.cronExpression, scope: job.scope },
      "scheduled cronjob",
    );
  } catch (err) {
    log.error(
      { jobId: job.id, cronExpression: job.cronExpression, err },
      "invalid cron expression, skipping job",
    );
  }
}

async function executeCronjob(job: CronjobDefinition, fileKey: string): Promise<void> {
  let workspaceId: string;

  if (job.scope === "workspace" && job.workspaceId) {
    workspaceId = job.workspaceId;
  } else {
    // Project-scoped: find the project and use its default branch
    const appState = loadState();
    const project = appState.projects.find((p) => p.name === fileKey);
    if (!project) {
      log.warn({ jobId: job.id, fileKey }, "project not found for cronjob, skipping");
      updateLastRun(job.id, "failed");
      return;
    }
    workspaceId = toWorkspaceId(project.name, project.defaultBranch);
  }

  log.info({ jobId: job.id, name: job.name, workspaceId }, "executing cronjob");

  try {
    const chat = getOrCreateDefaultChat(workspaceId);
    submitTask({ workspaceId, chatId: chat.id, prompt: job.prompt });
    updateLastRun(job.id, "completed");
  } catch (err) {
    if (err instanceof TaskConflictError) {
      log.info({ jobId: job.id, workspaceId }, "task already running, skipping cronjob execution");
      updateLastRun(job.id, "skipped");
      return;
    }
    log.error({ jobId: job.id, err }, "cronjob execution failed");
    updateLastRun(job.id, "failed");
  }
}

function updateLastRun(jobId: string, status: "completed" | "failed" | "skipped"): void {
  try {
    const db = getDb();
    db.update(cronjobs)
      .set({ lastRunAt: new Date().toISOString(), lastRunStatus: status })
      .where(eq(cronjobs.id, jobId))
      .run();
  } catch (err) {
    log.warn({ jobId, err }, "failed to update lastRun on cronjob");
  }
}

function loadAndScheduleAll(): void {
  // Stop all existing cron instances
  for (const [, cron] of state.jobs) {
    cron.stop();
  }
  state.jobs.clear();

  for (const job of listAllCronjobs()) {
    scheduleJob(job, job.fileKey);
  }

  log.info({ count: state.jobs.size }, "loaded cronjob schedules");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Start the cronjob scheduler. Called once on server boot. */
export function startCronjobScheduler(): void {
  if (state.started) return;
  state.started = true;

  loadAndScheduleAll();

  log.info("cronjob scheduler started");
}

/** Stop the cronjob scheduler. Called on graceful shutdown. */
export function stopCronjobScheduler(): void {
  for (const [, cron] of state.jobs) {
    cron.stop();
  }
  state.jobs.clear();

  state.started = false;
  log.info("cronjob scheduler stopped");
}

/** Reload all schedules from the database. Call after cronjob mutations. */
export function reloadSchedules(): void {
  if (!state.started) return;
  loadAndScheduleAll();
}

/** Stop all scheduled jobs for a specific file key (workspace or project removal). */
export function stopJobsForKey(key: string): void {
  const file = loadCronjobFile(key);
  for (const job of file.jobs) {
    const cron = state.jobs.get(job.id);
    if (cron) {
      cron.stop();
      state.jobs.delete(job.id);
      log.info({ jobId: job.id, key }, "stopped cronjob");
    }
  }
}
