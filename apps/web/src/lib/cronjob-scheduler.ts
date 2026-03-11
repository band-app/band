import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toWorkspaceId } from "@band/dashboard-core";
import { createLogger } from "@band/logger";
import { watch } from "chokidar";
import { Cron } from "croner";
import { cronjobsDir, loadCronjobFile, saveCronjobFile } from "./cronjob-store";
import type { CronjobDefinition, CronjobFile } from "./cronjob-types";
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
  /** Chokidar watcher on ~/.band/cronjobs/ */
  watcher: ReturnType<typeof watch> | null;
  /** Whether the scheduler has been started */
  started: boolean;
}

if (!g[SCHEDULER_KEY]) {
  g[SCHEDULER_KEY] = {
    jobs: new Map<string, Cron>(),
    watcher: null,
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
      updateLastRun(job.id, fileKey, "failed");
      return;
    }
    workspaceId = toWorkspaceId(project.name, project.defaultBranch);
  }

  log.info({ jobId: job.id, name: job.name, workspaceId }, "executing cronjob");

  try {
    submitTask(workspaceId, job.prompt);
    updateLastRun(job.id, fileKey, "completed");
  } catch (err) {
    if (err instanceof TaskConflictError) {
      log.info({ jobId: job.id, workspaceId }, "task already running, skipping cronjob execution");
      updateLastRun(job.id, fileKey, "skipped");
      return;
    }
    log.error({ jobId: job.id, err }, "cronjob execution failed");
    updateLastRun(job.id, fileKey, "failed");
  }
}

function updateLastRun(
  jobId: string,
  fileKey: string,
  status: "completed" | "failed" | "skipped",
): void {
  try {
    const file = loadCronjobFile(fileKey);
    const job = file.jobs.find((j) => j.id === jobId);
    if (job) {
      job.lastRunAt = new Date().toISOString();
      job.lastRunStatus = status;
      saveCronjobFile(fileKey, file);
    }
  } catch (err) {
    log.warn({ jobId, fileKey, err }, "failed to update lastRun on cronjob");
  }
}

function loadAndScheduleAll(): void {
  // Stop all existing cron instances
  for (const [, cron] of state.jobs) {
    cron.stop();
  }
  state.jobs.clear();

  const dir = cronjobsDir();
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const key = file.replace(".json", "");
      try {
        const data = readFileSync(join(dir, file), "utf-8");
        const cronjobFile = JSON.parse(data) as CronjobFile;
        for (const job of cronjobFile.jobs) {
          scheduleJob(job, key);
        }
      } catch (err) {
        log.warn({ file, err }, "skipping invalid cronjob file");
      }
    }
  } catch {
    // Dir may not exist yet
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

  const dir = cronjobsDir();
  mkdirSync(dir, { recursive: true });

  loadAndScheduleAll();

  // Watch for file changes in cronjobs dir
  state.watcher = watch(dir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  state.watcher.on("add", () => loadAndScheduleAll());
  state.watcher.on("change", () => loadAndScheduleAll());
  state.watcher.on("unlink", () => loadAndScheduleAll());

  log.info("cronjob scheduler started");
}

/** Stop the cronjob scheduler. Called on graceful shutdown. */
export function stopCronjobScheduler(): void {
  for (const [, cron] of state.jobs) {
    cron.stop();
  }
  state.jobs.clear();

  if (state.watcher) {
    state.watcher.close();
    state.watcher = null;
  }

  state.started = false;
  log.info("cronjob scheduler stopped");
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
