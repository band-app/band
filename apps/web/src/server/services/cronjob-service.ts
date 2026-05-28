import { createLogger } from "@band-app/logger";
import { Cron } from "croner";
import { z } from "zod";
import { toWorkspaceId } from "@/dashboard";
import {
  BAND_CRON_ID_LABEL,
  type ChatSession,
  createChat,
  findChatByLabels,
} from "../../lib/chat-manager";
import { loadState } from "../../lib/state";
import { submitTask, TaskConflictError } from "../../lib/task-runner";
import {
  type CronjobDefinition,
  CronjobQueries,
  generateCronjobId,
} from "../infra/db/queries/cronjobs";

const log = createLogger("cronjob-service");

// ---------------------------------------------------------------------------
// Shared scheduler state
//
// The active `Cron` timers and the started/stopped flag live on a globalThis
// symbol so the service survives module reloads in dev (vite/HMR re-imports
// this file but keeps the same module-graph identity for `globalThis`). The
// alternative — a top-level `Map` — would silently re-register every job on
// reload and leak timers. Pattern mirrors `task-runner.ts`.
// ---------------------------------------------------------------------------

interface SchedulerState {
  /** Map of cronjob id → active Cron instance */
  jobs: Map<string, Cron>;
  /** Whether the scheduler has been started */
  started: boolean;
}

const SCHEDULER_KEY = Symbol.for("band.cronjob-scheduler");
const g = globalThis as unknown as Record<symbol, unknown>;

if (!g[SCHEDULER_KEY]) {
  g[SCHEDULER_KEY] = {
    jobs: new Map<string, Cron>(),
    started: false,
  } satisfies SchedulerState;
}

function schedulerState(): SchedulerState {
  return g[SCHEDULER_KEY] as SchedulerState;
}

// ---------------------------------------------------------------------------
// Input schemas
//
// Defined in the service tier (not the API router) so the router and any
// future non-tRPC entry points (CLI, scripts, internal callers) share a
// single source of truth for the accepted shape — mirrors the pattern used
// by `SettingsService` in Phase 1. The tRPC router imports these schemas
// directly as its `.input(...)` validators; the service methods accept the
// inferred types, so adding/removing a field in the schema is a compile
// error at every call site instead of silent drift.
// ---------------------------------------------------------------------------

export const cronjobCreateInput = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  prompt: z.string().min(1),
  cronExpression: z.string().min(1),
  scope: z.enum(["project", "workspace"]),
  workspaceId: z.string().optional(),
  enabled: z.boolean().default(true),
});

export const cronjobUpdateInput = z.object({
  key: z.string(),
  id: z.string(),
  name: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  cronExpression: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

export type CronjobCreateInput = z.infer<typeof cronjobCreateInput>;
export type CronjobUpdateInput = z.infer<typeof cronjobUpdateInput>;

// ---------------------------------------------------------------------------
// Service-level error types
//
// Surface conditions the API tier needs to translate into HTTP/tRPC error
// codes (`NOT_FOUND`, `BAD_REQUEST`, `CONFLICT`) without letting the service
// import the tRPC types directly — `services/` is a layer below `api/` and
// must stay framework-agnostic.
// ---------------------------------------------------------------------------

export class CronjobNotFoundError extends Error {
  constructor(message = "Cronjob not found") {
    super(message);
    this.name = "CronjobNotFoundError";
  }
}

export class InvalidCronExpressionError extends Error {
  constructor(message = "Invalid cron expression") {
    super(message);
    this.name = "InvalidCronExpressionError";
  }
}

export class CronjobWorkspaceMissingError extends Error {
  constructor(message = "workspaceId is required for workspace-scoped cronjobs") {
    super(message);
    this.name = "CronjobWorkspaceMissingError";
  }
}

export class CronjobProjectNotFoundError extends Error {
  constructor(message = "Project not found") {
    super(message);
    this.name = "CronjobProjectNotFoundError";
  }
}

/**
 * Business logic + scheduler lifecycle for cronjobs.
 *
 * Absorbs the legacy `lib/cronjob-store.ts` (persistence) and
 * `lib/cronjob-scheduler.ts` (timer management + chat routing) into a single
 * service. Per `docs/web-architecture.md`, the API tier (`server/api/cronjobs/`)
 * delegates here; the Infra tier (`CronjobQueries`) handles the actual SQL.
 *
 * The service holds the scheduler state externally on a `globalThis`-keyed
 * symbol (see `SCHEDULER_KEY` above) because:
 *   - `cronjobService.start()` is called once from `start-server.ts` and the
 *     service instance must not be tied to a single request lifecycle.
 *   - Dev reloads re-import this module without resetting `globalThis`, so
 *     timers survive HMR rather than orphaning.
 */
export class CronjobService {
  constructor(private readonly queries: CronjobQueries = new CronjobQueries()) {}

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  /**
   * List jobs for a key, or — if neither `project` nor `workspaceId` is
   * provided — every cronjob across every key.
   *
   * Mirrors the legacy tRPC `cronjobs.list` shape so the router stays a
   * straight delegate. The "all" branch returns `fileKey` on each row
   * because callers (the dashboard's cronjob settings page) need both
   * pieces to render the project/workspace breadcrumbs.
   */
  list(filter?: { project?: string; workspaceId?: string }): {
    jobs: (CronjobDefinition & { fileKey: string })[];
  } {
    if (filter?.project) {
      const { project } = filter;
      const file = this.queries.loadFile(project);
      return { jobs: file.jobs.map((j) => ({ ...j, fileKey: project })) };
    }
    if (filter?.workspaceId) {
      const { workspaceId } = filter;
      const file = this.queries.loadFile(workspaceId);
      return {
        jobs: file.jobs.map((j) => ({ ...j, fileKey: workspaceId })),
      };
    }
    return { jobs: this.queries.listAll() };
  }

  /** Get a single job by `key` + `id`. Throws `CronjobNotFoundError` if absent. */
  get(key: string, id: string): { job: CronjobDefinition } {
    const job = this.findJob(key, id);
    if (!job) throw new CronjobNotFoundError();
    return { job };
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /**
   * Create a new cronjob and re-bind the scheduler.
   *
   * Validates the cron expression by attempting to construct a `Cron` with
   * `maxRuns: 0` (parses without scheduling). Throws
   * `InvalidCronExpressionError` for a bad expression and
   * `CronjobWorkspaceMissingError` when a workspace-scoped job is missing
   * its `workspaceId`.
   */
  create(input: CronjobCreateInput): { job: CronjobDefinition } {
    this.assertValidCron(input.cronExpression);
    if (input.scope === "workspace" && !input.workspaceId) {
      throw new CronjobWorkspaceMissingError();
    }

    const file = this.queries.loadFile(input.key);
    const job: CronjobDefinition = {
      id: generateCronjobId(),
      name: input.name,
      prompt: input.prompt,
      cronExpression: input.cronExpression,
      scope: input.scope,
      workspaceId: input.workspaceId,
      enabled: input.enabled,
      createdAt: new Date().toISOString(),
    };
    file.jobs.push(job);
    this.queries.saveFile(input.key, file);
    this.reloadSchedules();
    return { job };
  }

  /**
   * Partially update an existing cronjob.
   *
   * Each optional field is applied only when present, matching the legacy
   * router behavior. If `cronExpression` is supplied it's validated before
   * the write. Throws `CronjobNotFoundError` if no job matches `key`+`id`.
   */
  update(input: CronjobUpdateInput): { job: CronjobDefinition } {
    if (input.cronExpression) {
      this.assertValidCron(input.cronExpression);
    }

    const file = this.queries.loadFile(input.key);
    const job = file.jobs.find((j) => j.id === input.id);
    if (!job) throw new CronjobNotFoundError();

    if (input.name !== undefined) job.name = input.name;
    if (input.prompt !== undefined) job.prompt = input.prompt;
    if (input.cronExpression !== undefined) job.cronExpression = input.cronExpression;
    if (input.enabled !== undefined) job.enabled = input.enabled;

    this.queries.saveFile(input.key, file);
    this.reloadSchedules();
    return { job };
  }

  /**
   * Delete a cronjob and re-bind the scheduler.
   *
   * Throws `CronjobNotFoundError` if the job is already gone.
   */
  delete(key: string, id: string): { ok: true } {
    const file = this.queries.loadFile(key);
    const index = file.jobs.findIndex((j) => j.id === id);
    if (index === -1) throw new CronjobNotFoundError();
    file.jobs.splice(index, 1);
    this.queries.saveFile(key, file);
    this.reloadSchedules();
    return { ok: true };
  }

  /**
   * Fire a cronjob synchronously (manual "run now" path).
   *
   * Uses the same `band:cronId`-labeled chat as the scheduled fire so the
   * user sees both paths converge on a single dedicated conversation
   * (issue #520). `submitTask` may throw `TaskConflictError`, which the API
   * tier translates into a 409 Conflict response.
   */
  trigger(key: string, id: string): { taskId: string; workspaceId: string; chatId: string } {
    const job = this.findJob(key, id);
    if (!job) throw new CronjobNotFoundError();

    const workspaceId = this.resolveWorkspaceId(job, key);
    if (!workspaceId) throw new CronjobProjectNotFoundError();

    const cronChat = this.getOrCreateCronjobChat(workspaceId, job);
    const task = submitTask({ workspaceId, chatId: cronChat.id, prompt: job.prompt });
    return { taskId: task.id, workspaceId, chatId: cronChat.id };
  }

  // -------------------------------------------------------------------------
  // Lifecycle hooks for workspace/project removal
  // -------------------------------------------------------------------------

  /**
   * Stop all timers for jobs in `key` and remove the file rows.
   *
   * Called when a workspace or project is removed. Order matters: stop
   * timers first so a still-pending fire doesn't observe its row missing
   * from the database and crash the scheduler tick. The two steps were
   * previously two separate calls (`stopJobsForKey` + `deleteCronjobFile`)
   * at every call site — the legacy callers always invoked them in pairs,
   * so they're collapsed here to make the contract harder to misuse.
   */
  removeForKey(key: string): void {
    this.stopJobsForKey(key);
    this.queries.deleteFile(key);
  }

  // -------------------------------------------------------------------------
  // Scheduler lifecycle
  // -------------------------------------------------------------------------

  /** Start the cronjob scheduler. Called once on server boot. */
  start(): void {
    const state = schedulerState();
    if (state.started) return;
    state.started = true;
    this.loadAndScheduleAll();
    log.info("cronjob scheduler started");
  }

  /** Stop the cronjob scheduler. Called on graceful shutdown. */
  stop(): void {
    const state = schedulerState();
    for (const [, cron] of state.jobs) {
      cron.stop();
    }
    state.jobs.clear();
    state.started = false;
    log.info("cronjob scheduler stopped");
  }

  /** Reload all schedules from the database. Call after cronjob mutations. */
  reloadSchedules(): void {
    if (!schedulerState().started) return;
    this.loadAndScheduleAll();
  }

  /**
   * Stop all scheduled jobs for a key (e.g. when a workspace is removed).
   *
   * Private because the only correct call site is `removeForKey` above:
   * stopping the timers without also dropping the rows would re-schedule
   * the same jobs on the next `reloadSchedules()` tick. Keeping it
   * accessible only through `removeForKey` prevents future callers from
   * accidentally invoking just one half of the pair.
   */
  private stopJobsForKey(key: string): void {
    const state = schedulerState();
    const file = this.queries.loadFile(key);
    for (const job of file.jobs) {
      const cron = state.jobs.get(job.id);
      if (cron) {
        cron.stop();
        state.jobs.delete(job.id);
        log.info({ jobId: job.id, key }, "stopped cronjob");
      }
    }
  }

  // -------------------------------------------------------------------------
  // Shared resolution helpers (used by both the API + the scheduled fire path)
  // -------------------------------------------------------------------------

  /**
   * Find — or create — the dedicated chat this cronjob writes into.
   *
   * Issue #520: each cronjob owns its own chat in the workspace, looked up
   * by the canonical `band:cronId` label. First call creates the chat;
   * subsequent calls reuse it. If the user deletes the chat, the next call
   * recreates it (intentional soft reset). This replaces the old
   * `getOrCreateDefaultChat` dispatch, which silently latched onto whatever
   * chat the user happened to be focused on. Shared between the scheduled
   * fire path (`executeCronjob` below) and the manual `trigger` route so
   * both stay aligned.
   */
  private getOrCreateCronjobChat(
    workspaceId: string,
    job: Pick<CronjobDefinition, "id" | "name">,
  ): ChatSession {
    const labelMatch = { [BAND_CRON_ID_LABEL]: job.id };
    const existing = findChatByLabels(workspaceId, labelMatch);
    if (existing) return existing;
    return createChat(workspaceId, {
      name: job.name,
      labels: labelMatch,
      // Cronjob scheduler is a trusted server-side caller — it's allowed
      // to write the reserved `band:` prefix that user-facing surfaces
      // are blocked from touching.
      allowReservedLabels: true,
    });
  }

  /**
   * Resolve the workspace the cronjob fires into.
   *
   * Returns `null` for project-scoped jobs whose project no longer exists
   * (which the scheduled fire path treats as a soft failure — see
   * `executeCronjob`). The manual trigger route maps the same condition to
   * a `CronjobProjectNotFoundError`.
   */
  private resolveWorkspaceId(job: CronjobDefinition, fileKey: string): string | null {
    if (job.scope === "workspace" && job.workspaceId) {
      return job.workspaceId;
    }
    const appState = loadState();
    const project = appState.projects.find((p) => p.name === fileKey);
    if (!project) return null;
    return toWorkspaceId(project.name, project.defaultBranch);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private findJob(key: string, id: string): CronjobDefinition | undefined {
    const file = this.queries.loadFile(key);
    return file.jobs.find((j) => j.id === id);
  }

  private assertValidCron(expression: string): void {
    try {
      // eslint-disable-next-line no-new
      new Cron(expression, { maxRuns: 0 });
    } catch {
      throw new InvalidCronExpressionError();
    }
  }

  private scheduleJob(job: CronjobDefinition, fileKey: string): void {
    const state = schedulerState();
    // Stop existing if re-scheduling
    const existing = state.jobs.get(job.id);
    if (existing) {
      existing.stop();
      state.jobs.delete(job.id);
    }

    if (!job.enabled) return;

    try {
      const cronInstance = new Cron(job.cronExpression, () => {
        this.executeCronjob(job, fileKey).catch((err) => {
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

  private async executeCronjob(job: CronjobDefinition, fileKey: string): Promise<void> {
    const workspaceId = this.resolveWorkspaceId(job, fileKey);
    if (!workspaceId) {
      log.warn({ jobId: job.id, fileKey }, "project not found for cronjob, skipping");
      this.safeUpdateLastRun(job.id, "failed");
      return;
    }

    log.info({ jobId: job.id, name: job.name, workspaceId }, "executing cronjob");

    try {
      const chat = this.getOrCreateCronjobChat(workspaceId, job);
      submitTask({ workspaceId, chatId: chat.id, prompt: job.prompt });
      this.safeUpdateLastRun(job.id, "completed");
    } catch (err) {
      if (err instanceof TaskConflictError) {
        log.info(
          { jobId: job.id, workspaceId },
          "task already running, skipping cronjob execution",
        );
        this.safeUpdateLastRun(job.id, "skipped");
        return;
      }
      log.error({ jobId: job.id, err }, "cronjob execution failed");
      this.safeUpdateLastRun(job.id, "failed");
    }
  }

  /**
   * Update `lastRunAt`/`lastRunStatus`, swallowing DB errors.
   *
   * Errors here are diagnostic noise during the fire path — the cronjob
   * already executed (or failed/skipped), and we don't want a transient
   * DB lock to mask the real outcome by re-raising. The legacy
   * implementation logged at `warn` and moved on; preserved here.
   */
  private safeUpdateLastRun(jobId: string, status: "completed" | "failed" | "skipped"): void {
    try {
      this.queries.updateLastRun(jobId, status);
    } catch (err) {
      log.warn({ jobId, err }, "failed to update lastRun on cronjob");
    }
  }

  private loadAndScheduleAll(): void {
    const state = schedulerState();
    // Stop all existing cron instances
    for (const [, cron] of state.jobs) {
      cron.stop();
    }
    state.jobs.clear();

    for (const job of this.queries.listAll()) {
      this.scheduleJob(job, job.fileKey);
    }

    log.info({ count: state.jobs.size }, "loaded cronjob schedules");
  }
}

/**
 * Shared singleton consumed by the API tier (`server/api/cronjobs/router.ts`),
 * the server bootstrap (`start-server.ts`), and the project/workspace removal
 * paths in the legacy `trpc/router.ts`. `CronjobService` holds its scheduler
 * state on a `globalThis`-keyed symbol so re-instantiating it is harmless,
 * but centralising the instance here keeps the call sites tidy.
 */
export const cronjobService = new CronjobService();
