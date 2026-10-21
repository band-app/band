import { randomUUID } from "node:crypto";
import { cliHeadlessInvocation } from "@band-app/coding-agent";
import { createLogger } from "@band-app/logger";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { Cron, type CronOptions } from "croner";
import { z } from "zod";
import {
  type CronjobDefinition,
  CronjobQueries,
  generateCronjobId,
} from "../infra/db/queries/cronjobs";
// FRAGILE: `terminalService` and `worktreeService` are
// imported at module load but referenced ONLY inside function bodies
// (`spawnCronTerminal` and friends). `worktree-service` already imports
// `cronjobService` from this file, so the two form an ESM cycle — the same
// live-binding constraint documented on the import block in
// `worktree-service.ts` applies: never capture these at module load
// (`const t = terminalService` at the top would get `undefined`), always
// dereference at call time. The `via` enum below is deliberately NOT imported
// from `worktree-service` for exactly this reason — see `cronjobVia`.
import { commandFor } from "./_utils/agent-command";
import { formatShellCommand } from "./_utils/format-shell-command";
import { listedMainHostOf } from "./_utils/repo-host-policy";
import { agentSessionService } from "./agent-session-service";
import { BAND_CRON_ID_LABEL, type ChatSession, chatService } from "./chat-service";
import { settingsService } from "./settings-service";
import { loadState } from "./state";
import { submitOrQueueTask, TaskConflictError } from "./task-service";
import { terminalService } from "./terminal-service";
import { emit } from "./watcher-service";
import { worktreeService } from "./worktree-service";

const log = createLogger("cronjob-service");

// ---------------------------------------------------------------------------
// Shared scheduler state
//
// The active `Cron` timers and the started/stopped flag live on a globalThis
// symbol so the service survives module reloads in dev (vite/HMR re-imports
// this file but keeps the same module-graph identity for `globalThis`). The
// alternative — a top-level `Map` — would silently re-register every job on
// reload and leak timers. Pattern mirrors `task-service.ts`.
// ---------------------------------------------------------------------------

interface SchedulerState {
  /** Map of cronjob id → active Cron instance */
  jobs: Map<string, Cron>;
  /** Whether the scheduler has been started */
  started: boolean;
  /**
   * Job ids with a `via="terminal"` dispatch currently mid-spawn. Held
   * synchronously across the `await`-heavy body of `spawnCronTerminal`
   * (resolve adapter → spawn PTY → persist `lastTerminalId`) so two
   * concurrent fires for the same job — a manual `trigger` racing a
   * scheduled tick, or a double-click — can't both pass the overlap check
   * before either commits its new terminal id and orphan a PTY. The
   * pool's own `spawning` map only dedupes identical `terminalId`s; this
   * guards the check-then-act at the job level.
   */
  spawningTerminals: Set<string>;
}

const SCHEDULER_KEY = Symbol.for("band.cronjob-scheduler");
const g = globalThis as unknown as Record<symbol, unknown>;

if (!g[SCHEDULER_KEY]) {
  g[SCHEDULER_KEY] = {
    jobs: new Map<string, Cron>(),
    started: false,
    spawningTerminals: new Set<string>(),
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

/**
 * Where a cronjob fire dispatches its prompt (issue #581) — the same two
 * values as `worktreeVia` on `worktrees.create` (#551).
 *
 * Deliberately re-declared here rather than imported from
 * `worktree-service.ts`: that module and this one form an ESM cycle
 * (`worktree-service` imports `cronjobService`), and `worktreeVia` is a
 * module-load value — importing it across the cycle risks reading `undefined`
 * while `worktree-service` is still initialising (see the FRAGILE note on the
 * import block above). Keep the two enums in sync by convention.
 */
export const cronjobVia = z.enum(["chat", "terminal"]);
export type CronjobVia = z.infer<typeof cronjobVia>;

export const cronjobCreateInput = z.object({
  key: z.string().min(1).optional(),
  name: z.string().min(1),
  prompt: z.string().min(1),
  cronExpression: z.string().min(1),
  // Every job belongs to one worktree. Both fields stay optional in the schema
  // so the service answers a repo scope or a missing worktree with its own
  // message instead of a generic validation error.
  worktreeId: z.string().optional(),
  scope: z.string().optional(),
  // Coding agent id from settings. Absent means the default agent.
  agent: z.string().min(1).optional(),
  // The agent's provider session id. Fires go to the chat that has it active.
  sessionId: z.string().min(1).optional(),
  // Dispatch target for scheduled + manual fires. Optional — absent defaults to
  // "chat" in `create()` so existing callers (the web UI) keep their behavior.
  via: cronjobVia.optional(),
  enabled: z.boolean().default(true),
});

export const cronjobUpdateInput = z.object({
  // `.min(1)` rejects the obviously invalid empty-string `key`/`id` at the
  // validator instead of letting it reach the service, which would
  // `loadFile("")` an empty result and 404 on `findIndex`. The legacy
  // router accepted bare `z.string()` here; the migration is the natural
  // moment to tighten the boundary so the create + update shapes stay
  // consistent (`cronjobCreateInput.key` already has `.min(1)`).
  key: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  cronExpression: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  // Moves the job to another worktree.
  worktreeId: z.string().min(1).optional(),
  // `null` clears the field.
  agent: z.string().min(1).nullable().optional(),
  sessionId: z.string().min(1).nullable().optional(),
  via: cronjobVia.optional(),
});

/**
 * `{ key, id }` lookup shape shared by `get`, `delete`, and `trigger`.
 *
 * Each of those endpoints previously inlined `z.object({ key: z.string(), id:
 * z.string() })` in the router, which is wrong for the same reason
 * `cronjobUpdateInput` calls out above: an empty `key` reaches
 * `queries.loadFile("")`, returns an empty `jobs` array, and the handler
 * throws `CronjobNotFoundError` (-> 404) instead of a clean `BAD_REQUEST`.
 * Centralising the shape in the service tier (same place
 * `cronjobCreateInput` / `cronjobUpdateInput` live) keeps the three
 * endpoints consistent — adding a field here lights up the router and
 * service signatures together.
 */
export const cronjobByIdInput = z.object({
  key: z.string().min(1),
  id: z.string().min(1),
});

export type CronjobCreateInput = z.infer<typeof cronjobCreateInput>;
export type CronjobUpdateInput = z.infer<typeof cronjobUpdateInput>;
export type CronjobByIdInput = z.infer<typeof cronjobByIdInput>;

/**
 * Result of a manual `trigger`, discriminated on the dispatch target.
 *
 *   - `chat` — a task was submitted to the cron chat pane (returns the task +
 *     chat ids, preserving the pre-#581 response fields).
 *   - `terminal` — a fresh self-closing PTY pane was spawned (returns its id).
 *
 * A `via="terminal"` job whose agent has no vendor CLI silently falls back to
 * the chat shape, so callers can always rely on `via` to know what happened.
 */
export type CronjobTriggerResult =
  | {
      via: "chat";
      worktreeId: string;
      chatId: string;
      /** Set when the prompt started a turn now. */
      taskId?: string;
      /** Set when the chat was mid-turn and the prompt joined its queue. */
      queuedMessageId?: string;
    }
  | { via: "terminal"; terminalId: string; worktreeId: string };

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

export class CronjobWorktreeMissingError extends Error {
  constructor(message = "A cronjob belongs to a worktree: pass worktreeId") {
    super(message);
    this.name = "CronjobWorktreeMissingError";
  }
}

/** A create or update the service refuses (bad agent, session with a terminal job, agent mismatch). */
export class CronjobInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronjobInvalidError";
  }
}

/** A fire that could not reach its chat. The message is recorded as the run's reason. */
export class CronjobDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronjobDispatchError";
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
   * List the jobs of one worktree, or — without `worktreeId` — every cronjob.
   *
   * Mirrors the legacy tRPC `cronjobs.list` shape so the router stays a
   * straight delegate. The "all" branch returns `fileKey` on each row
   * because callers (the dashboard's cronjob settings page) need both
   * pieces to render the repo/worktree breadcrumbs.
   */
  list(filter?: { worktreeId?: string }): {
    jobs: (CronjobDefinition & { fileKey: string })[];
  } {
    if (filter?.worktreeId) {
      const { worktreeId } = filter;
      const file = this.queries.loadFile(worktreeId);
      return {
        jobs: file.jobs.map((j) => ({ ...j, fileKey: worktreeId })),
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
   * `CronjobWorktreeMissingError` when a worktree-scoped job is missing
   * its `worktreeId`.
   */
  create(input: CronjobCreateInput): { job: CronjobDefinition } {
    this.assertValidCron(input.cronExpression);
    if (input.scope === "repo") {
      throw new CronjobWorktreeMissingError(
        "Repo-scoped cronjobs are gone: a cronjob belongs to a worktree, so pass worktreeId (the default-branch worktree works for a repo's main)",
      );
    }
    if (!input.worktreeId) throw new CronjobWorktreeMissingError();
    const { worktreeId } = input;
    this.assertWorktreeExists(worktreeId);
    const via = input.via ?? "chat";
    this.assertTarget({ worktreeId, via, agent: input.agent, sessionId: input.sessionId });

    const file = this.queries.loadFile(worktreeId);
    const job: CronjobDefinition = {
      id: generateCronjobId(),
      name: input.name,
      prompt: input.prompt,
      cronExpression: input.cronExpression,
      scope: "worktree",
      worktreeId,
      agent: input.agent,
      sessionId: input.sessionId,
      // Absent `via` means the web UI (or a pre-#581 caller) — default to chat
      // so existing cronjobs keep dispatching exactly as before.
      via,
      enabled: input.enabled,
      createdAt: new Date().toISOString(),
    };
    file.jobs.push(job);
    this.queries.saveFile(worktreeId, file);
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
    if (input.cronExpression !== undefined) {
      this.assertValidCron(input.cronExpression);
    }

    const file = this.queries.loadFile(input.key);
    const job = file.jobs.find((j) => j.id === input.id);
    if (!job) throw new CronjobNotFoundError();

    if (input.name !== undefined) job.name = input.name;
    if (input.prompt !== undefined) job.prompt = input.prompt;
    if (input.cronExpression !== undefined) job.cronExpression = input.cronExpression;
    if (input.enabled !== undefined) job.enabled = input.enabled;
    if (input.via !== undefined) job.via = input.via;
    if (input.agent !== undefined) job.agent = input.agent ?? undefined;
    if (input.sessionId !== undefined) job.sessionId = input.sessionId ?? undefined;
    let key = input.key;
    if (input.worktreeId !== undefined && input.worktreeId !== job.worktreeId) {
      this.assertWorktreeExists(input.worktreeId);
      job.worktreeId = input.worktreeId;
      key = input.worktreeId;
    }
    this.assertTarget({
      worktreeId: job.worktreeId ?? key,
      via: job.via,
      agent: job.agent,
      sessionId: job.sessionId,
    });

    if (key === input.key) {
      this.queries.saveFile(key, file);
    } else {
      // Moved to another worktree: the job leaves this key's file and joins the new one.
      file.jobs = file.jobs.filter((j) => j.id !== job.id);
      this.queries.saveFile(input.key, file);
      const target = this.queries.loadFile(key);
      target.jobs.push(job);
      this.queries.saveFile(key, target);
    }
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
    const [removed] = file.jobs.splice(index, 1);
    this.queries.saveFile(key, file);
    // Best-effort: tear down the terminal a via="terminal" job last spawned so
    // deleting the job doesn't leave a stray pane running the agent. No-op when
    // the id is unset or the PTY already exited. `kill()` emits `terminal-killed`
    // once — the exit event of an explicit kill is flagged `killed`, which the
    // service's `cleanupOnExit` handling skips, so there's no double-emit.
    // Fire-and-forget: the kill may hop to the terminal daemon, and deleting
    // the job must not wait on (or fail because of) the pane.
    if (removed?.lastTerminalId) {
      const terminalId = removed.lastTerminalId;
      void terminalService.kill(terminalId).catch((err) => {
        log.warn({ jobId: id, terminalId, err }, "failed to kill the job's terminal");
      });
    }
    this.reloadSchedules();
    return { ok: true };
  }

  /**
   * Fire a cronjob synchronously (manual "run now" path).
   *
   * Goes to the same chat as the scheduled fire (see `dispatchToChat`) so the
   * user sees both paths converge on a single conversation. A terminal job
   * that is still running throws `TaskConflictError`, which the API tier
   * translates into a 409 Conflict response. A chat that is mid-turn queues
   * the prompt instead.
   *
   * Atomicity caveat: `getOrCreateCronjobChat` and `submitOrQueueTask` are not
   * run inside a single transaction. If `createChat` succeeds but the submit
   * later throws an unexpected error, the
   * freshly-created chat remains in the worktree as an orphan with no
   * task ever attached. The next manual `trigger` (or scheduled fire)
   * reuses that chat via its `band:cronId` label, so the orphan
   * self-heals — but the user may briefly see an empty chat pane. The
   * legacy implementation had the same gap; preserved here to match
   * existing behavior. If this ever needs to be tightened, the fix is
   * either (a) wrap both calls in a try/catch that deletes the chat on
   * unexpected failure, or (b) defer `createChat` until `submitTask`
   * succeeds (which would require buffering the chat name/labels on the
   * task row).
   */
  async trigger(key: string, id: string): Promise<CronjobTriggerResult> {
    const job = this.findJob(key, id);
    if (!job) throw new CronjobNotFoundError();

    const worktreeId = this.resolveWorktreeId(job);
    if (!worktreeId) throw new CronjobWorktreeMissingError(`Cronjob ${id} has no worktree`);

    // Terminal dispatch mirrors the scheduled fire. `spawnCronTerminal` throws
    // `TaskConflictError` when the previous pane is still alive (→ 409, same as
    // the chat path's running-task conflict) and returns `{ terminalId: null }`
    // when the agent has no vendor CLI, in which case we fall through to chat.
    if (job.via === "terminal") {
      const { terminalId } = await this.spawnCronTerminal(job, worktreeId, key);
      if (terminalId) {
        return { via: "terminal", terminalId, worktreeId };
      }
    }

    try {
      const sent = await this.dispatchToChat(job, worktreeId);
      return { via: "chat", worktreeId, ...sent };
    } catch (err) {
      if (err instanceof CronjobDispatchError)
        this.safeUpdateLastRun(job.id, "failed", err.message);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle hooks for worktree/repo removal
  // -------------------------------------------------------------------------

  /**
   * Stop all timers for jobs in `key` and remove the file rows.
   *
   * Called when a worktree or repo is removed. Order matters: stop
   * timers first so no further fires queue up between the timer-stop and
   * the row-delete. An in-flight fire is already safe in either order
   * because `executeCronjob` operates on closed-over `job`/`fileKey` (it
   * never re-reads the row) and `safeUpdateLastRun` swallows the
   * row-missing case. The two steps were previously two separate calls
   * (`stopJobsForKey` + `deleteCronjobFile`) at every call site — the
   * legacy callers always invoked them in pairs, so they're collapsed
   * here to make the contract harder to misuse.
   *
   * Partial-failure recovery: if `deleteFile` throws (e.g. a transient DB
   * lock), the timers are already stopped but the rows remain in the DB.
   * The next `reloadSchedules()` call — triggered by any subsequent
   * cronjob mutation, or by a server restart — re-reads the rows from the
   * DB and re-registers the timers, so the orphaned rows self-heal
   * without manual intervention. We do NOT roll back the `stop()` calls
   * because re-binding timers for a worktree that's mid-deletion is
   * worse than leaving them stopped: the worktree path is about to be
   * removed and any fire that races the removal would target a
   * non-existent worktree. Re-registration on the next reload is the
   * intentional recovery strategy; operators encountering a partial
   * failure on this path should expect the next reload to be a no-op
   * once the worktree removal completes and the rows are re-attempted.
   */
  removeForKey(key: string): void {
    this.stopJobsForKey(key);
    this.queries.deleteFile(key);
  }

  /**
   * Remove the jobs of every worktree a repo has, plus any repo-keyed job the
   * boot migration has not moved yet. Call before the repo's rows go away.
   */
  removeForRepo(repoName: string): void {
    const repo = loadState().repos.find((r) => r.name === repoName);
    for (const wt of repo?.worktrees ?? []) {
      this.removeForKey(toWorktreeId(repoName, wt.branch, wt.hostId));
    }
    this.removeForKey(repoName);
  }

  // -------------------------------------------------------------------------
  // Scheduler lifecycle
  // -------------------------------------------------------------------------

  /**
   * Turn each repo-scoped job (written before jobs were tied to a worktree)
   * into a job of the repo's listed default-branch worktree, on the host that
   * lists it. The job keeps its id, schedule, prompt, `via`, enabled flag and
   * `band:cronId` chat. A job with nowhere to go is disabled with the reason in
   * `lastRunMessage`. Nothing is deleted, and a second run changes nothing.
   * Runs at boot after the worktree sync and before `start()`.
   */
  migrateRepoJobs(): void {
    const legacy = this.queries.listRepoScoped();
    if (legacy.length === 0) return;
    const repos = loadState().repos;
    for (const job of legacy) {
      const repo = repos.find((r) => r.name === job.fileKey);
      if (!repo) {
        this.queries.disableWithReason(job.id, `Repo ${job.fileKey} no longer exists`);
        log.warn({ jobId: job.id, repo: job.fileKey }, "repo of a repo-scoped cronjob is gone");
        continue;
      }
      const hostId = listedMainHostOf(repo);
      if (!hostId) {
        this.queries.disableWithReason(
          job.id,
          `The default branch ${repo.defaultBranch} of ${repo.name} is not checked out on any worker`,
        );
        log.warn({ jobId: job.id, repo: repo.name }, "no default-branch worktree for cronjob");
        continue;
      }
      const worktreeId = toWorktreeId(repo.name, repo.defaultBranch, hostId);
      this.queries.moveToWorktree(job.id, worktreeId);
      log.info({ jobId: job.id, worktreeId }, "moved repo-scoped cronjob to its worktree");
    }
  }

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
   * Stop all scheduled jobs for a key (e.g. when a worktree is removed).
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
   * Issue #520: each cronjob owns its own chat in the worktree, looked up
   * by the canonical `band:cronId` label. First call creates the chat;
   * subsequent calls reuse it. If the user deletes the chat, the next call
   * recreates it (intentional soft reset). This replaces the old
   * `getOrCreateDefaultChat` dispatch, which silently latched onto whatever
   * chat the user happened to be focused on. Shared between the scheduled
   * fire path (`executeCronjob` below) and the manual `trigger` route so
   * both stay aligned.
   */
  private getOrCreateCronjobChat(
    worktreeId: string,
    job: Pick<CronjobDefinition, "id" | "name" | "agent">,
  ): ChatSession {
    const labelMatch = { [BAND_CRON_ID_LABEL]: job.id };
    const existing = chatService.findByLabels(worktreeId, labelMatch);
    if (existing) return existing;
    return chatService.create(worktreeId, {
      name: job.name,
      agent: job.agent,
      labels: labelMatch,
      // Cronjob scheduler is a trusted server-side caller — it's allowed
      // to write the reserved `band:` prefix that user-facing surfaces
      // are blocked from touching.
      allowReservedLabels: true,
    });
  }

  /**
   * Send the job's prompt to its chat.
   *
   * Without a session id the chat is the job's own `band:cronId` chat. With
   * one, it is the chat in the worktree whose active session is that id. When
   * no chat has it, a new chat opens on that session through `session/resume`
   * or `session/load`. A session the agent cannot open fails the fire and no
   * fresh session starts in its place. A chat that is mid-turn queues the
   * prompt behind the running turn.
   */
  private async dispatchToChat(
    job: CronjobDefinition,
    worktreeId: string,
  ): Promise<{ chatId: string; taskId?: string; queuedMessageId?: string }> {
    if (!job.sessionId) {
      const chat = this.getOrCreateCronjobChat(worktreeId, job);
      const sent = submitOrQueueTask({
        worktreeId,
        chatId: chat.id,
        prompt: job.prompt,
        codingAgentId: job.agent,
      });
      return sent.queued
        ? { chatId: chat.id, queuedMessageId: sent.queuedMessageId }
        : { chatId: chat.id, taskId: sent.task.id };
    }

    const { sessionId } = job;
    const found = chatService.list(worktreeId).find((c) => c.activeSessionId === sessionId);
    if (found && job.agent && found.agent !== job.agent) {
      throw new CronjobDispatchError(
        `Session ${sessionId} belongs to a chat that runs ${found.agent}, but the job asks for ${job.agent}`,
      );
    }
    const created = !found;
    const chat =
      found ??
      chatService.create(worktreeId, {
        name: job.name,
        agent: job.agent,
        labels: { [BAND_CRON_ID_LABEL]: job.id },
        allowReservedLabels: true,
      });
    if (created) chatService.updateActiveSession(chat.id, sessionId);

    // Attach strictly before the prompt goes out, so a session that cannot be
    // reopened fails here instead of being replaced by a fresh one.
    if (!chat.ownerHostId) {
      try {
        await agentSessionService.ensureSession(chat.id, "prompt", { strictSession: true });
      } catch (err) {
        if (created) chatService.remove(chat.id);
        const reason = err instanceof Error ? err.message : String(err);
        throw new CronjobDispatchError(`Could not open session ${sessionId}: ${reason}`);
      }
    }
    const sent = submitOrQueueTask({ worktreeId, chatId: chat.id, prompt: job.prompt });
    return sent.queued
      ? { chatId: chat.id, queuedMessageId: sent.queuedMessageId }
      : { chatId: chat.id, taskId: sent.task.id };
  }

  /**
   * Dispatch a `via="terminal"` fire: spawn the agent's *headless* vendor CLI
   * in a fresh, self-closing PTY pane. Mirrors the `via=terminal` branch of
   * `WorktreeService.create` (#551), but adapted for a recurring cron in two
   * important ways:
   *
   *   - **Headless, not interactive.** We use `cliHeadlessInvocation`
   *     (`claude -p`, `codex exec`, …), NOT the interactive `cliInvocation`
   *     that worktree-create uses. The interactive REPL never exits on its
   *     own, so the pane would stay parked after the turn — the shell's `exit`
   *     would never run and the overlap guard below would treat "idle at the
   *     REPL" as "still running", blocking every subsequent tick (issue #581
   *     follow-up). The headless form runs the prompt and exits, which is what
   *     makes both the self-close and the overlap guard actually work.
   *   - **Overlap guard.** If the terminal spawned by this job's previous fire
   *     is still alive, throw `TaskConflictError` instead of launching a second
   *     agent — the caller records "skipped" (scheduled) or surfaces 409
   *     (manual trigger), exactly like the chat running-task conflict. Because
   *     the headless process exits when the turn completes, a live PTY reliably
   *     means the previous run is genuinely still working.
   *   - **Self-closing pane.** The command is `<headless-cli>\nexit`, staged
   *     and sourced by the pool via `.`, so the shell exits the moment the
   *     headless CLI returns. Combined with `cleanupOnExit`, the finished pane
   *     removes itself from the layout and emits `terminal-killed` — bounding a
   *     frequent cron to ~1 pane and keeping the next tick's liveness check
   *     accurate.
   *
   * Returns `{ terminalId: null }` when the agent exposes no headless CLI (or
   * the worktree can't be resolved), signalling the caller to fall back to
   * chat. Spawn failures propagate (recorded as "failed").
   *
   * Edge case: if `terminalService.spawn` throws *after* the PTY is forked but
   * before `updateLastTerminal` runs, `lastTerminalId` stays unset for this
   * fire, so the next tick's overlap guard won't see that (now likely dead)
   * PTY. This is acceptable — a spawn that rejects has almost certainly failed
   * to produce a usable pane, and the synchronous in-process lock above still
   * prevents a *concurrent* double-spawn; only a subsequent, well-separated
   * tick could add a second pane, which is the same at-most-transient
   * duplication the self-close bound already tolerates.
   */
  private async spawnCronTerminal(
    job: CronjobDefinition,
    worktreeId: string,
    fileKey: string,
  ): Promise<{ terminalId: string | null }> {
    const state = schedulerState();
    // Close the check-then-act TOCTOU window (PR #627 review): the live-PTY
    // overlap guard below reads `lastTerminalId`, then this method `await`s an
    // adapter resolve + PTY spawn before persisting a NEW id. Two concurrent
    // fires for the same job (a manual `trigger` racing a scheduled tick, a
    // double-click) could both pass the guard before either commits, spawn two
    // PTYs, and orphan the first. A synchronous check-and-add BEFORE any await
    // rejects the second caller with the same `TaskConflictError` the overlap
    // guard uses (→ scheduled "skipped" / manual 409). Released in `finally`.
    if (state.spawningTerminals.has(job.id)) {
      throw new TaskConflictError(`Cronjob ${job.id} terminal run is already being spawned`);
    }
    state.spawningTerminals.add(job.id);
    try {
      const worktree = worktreeService.resolve(worktreeId);
      if (!worktree) {
        log.warn(
          { jobId: job.id, worktreeId },
          "worktree not resolvable for via=terminal cronjob; falling back to chat",
        );
        return { terminalId: null };
      }

      // Overlap guard: re-read the row (the scheduled path closes over a stale
      // `job` captured at schedule time) so we check the terminal the LAST fire
      // actually spawned. A live PTY means the previous headless run is still
      // working (a finished one has exited and self-closed).
      const prevTerminalId = this.findJob(fileKey, job.id)?.lastTerminalId;
      if (prevTerminalId && (await terminalService.info(prevTerminalId))) {
        throw new TaskConflictError(`Cronjob ${job.id} terminal run is still in progress`);
      }

      // Resolve the agent's HEADLESS CLI invocation on the request thread so we
      // can fall back to chat synchronously when it's unsupported (e.g.
      // cursor-cli). The job's own agent when it names one, else the default.
      const agentDef = settingsService.getAgentDefinition(job.agent);
      const invocation = cliHeadlessInvocation(agentDef.type, job.prompt, {
        command: commandFor(worktree.host.id, agentDef),
      });
      if (invocation.unsupported) {
        log.warn(
          { jobId: job.id, worktreeId, reason: invocation.reason },
          "via=terminal requested but agent has no headless CLI; falling back to chat",
        );
        return { terminalId: null };
      }

      // `\nexit` makes the pane self-close when the headless CLI returns: the
      // pool stages `<command>\n` into a temp file and runs it via the POSIX dot
      // builtin, so a trailing `exit` terminates the shell once the CLI exits.
      const command = `${formatShellCommand(invocation.command, invocation.args)}\nexit`;
      const terminalId = randomUUID();
      await terminalService.spawn(worktreeId, terminalId, { command }, { cleanupOnExit: true });
      // Persist the id BEFORE emitting so the next tick's overlap check sees it
      // even if the emit's subscribers race.
      this.queries.updateLastTerminal(job.id, terminalId);
      // Broadcast so an open dashboard adds the pane without a reload — same
      // pattern as `terminal.create` and the `via=terminal` worktree-create path.
      emit({ kind: "terminal-created", worktreeId, terminalId });
      return { terminalId };
    } finally {
      state.spawningTerminals.delete(job.id);
    }
  }

  /** The worktree the cronjob fires into, or null for a row that has none. */
  private resolveWorktreeId(job: CronjobDefinition): string | null {
    return job.worktreeId ?? null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private assertWorktreeExists(worktreeId: string): void {
    if (!worktreeService.resolve(worktreeId)) {
      throw new CronjobWorktreeMissingError(`Worktree not found: ${worktreeId}`);
    }
  }

  /** Refuse an agent that is not configured, a session on a terminal job, and an agent that contradicts the session's chat. */
  private assertTarget(target: {
    worktreeId: string;
    via: CronjobVia;
    agent?: string;
    sessionId?: string;
  }): void {
    if (target.agent) {
      const known = (settingsService.get().codingAgents ?? []).map((a) => a.id);
      if (!known.includes(target.agent)) {
        throw new CronjobInvalidError(
          `Unknown agent "${target.agent}". Configured agents: ${known.join(", ") || "none"}`,
        );
      }
    }
    if (!target.sessionId) return;
    if (target.via === "terminal") {
      throw new CronjobInvalidError(
        "A session id works only with via=chat: a terminal job starts a new headless run each time",
      );
    }
    const chat = chatService
      .list(target.worktreeId)
      .find((c) => c.activeSessionId === target.sessionId);
    if (chat && target.agent && chat.agent !== target.agent) {
      throw new CronjobInvalidError(
        `Session ${target.sessionId} belongs to a chat that runs ${chat.agent}, but the job asks for ${target.agent}`,
      );
    }
  }

  private findJob(key: string, id: string): CronjobDefinition | undefined {
    const file = this.queries.loadFile(key);
    return file.jobs.find((j) => j.id === id);
  }

  private assertValidCron(expression: string): void {
    try {
      // Construct-and-discard: `Cron` throws on a malformed expression at
      // construction time, and we never need the instance. `maxRuns: 0`
      // makes the no-execute intent explicit; `void` flags the
      // side-effect-only construction. The `CronOptions` annotation pins
      // the `Cron(pattern, options)` overload — `croner` also exposes
      // `Cron(pattern, handler)`, so if a future version reshapes
      // overload resolution this fails at compile time rather than
      // silently turning the options object into a callback and
      // regressing validation.
      const options: CronOptions = { maxRuns: 0 };
      void new Cron(expression, options);
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
      // `Cron(pattern, handler)` is the deliberately chosen overload here:
      // this is the "schedule for real" path, and the handler shape is the
      // whole point of the call. `assertValidCron` above uses the
      // `Cron(pattern, options)` overload because it never wants a handler
      // and pins `maxRuns: 0` — that comment explains its overload choice.
      // The two sites use different overloads intentionally; documenting it
      // here so a future reader doesn't try to "harmonise" them by
      // wrapping this in an options object (which would force `croner` to
      // pick the wrong overload and silently drop the handler).
      const cronInstance = new Cron(job.cronExpression, () => {
        this.executeCronjob(job, fileKey).catch((err) => {
          log.error({ jobId: job.id, err }, "unhandled error in cronjob execution");
        });
      });

      state.jobs.set(job.id, cronInstance);
      log.info(
        { jobId: job.id, name: job.name, cron: job.cronExpression, worktreeId: job.worktreeId },
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
    const worktreeId = this.resolveWorktreeId(job);
    if (!worktreeId) {
      log.warn({ jobId: job.id, fileKey }, "cronjob has no worktree, skipping");
      this.safeUpdateLastRun(job.id, "failed", "The job has no worktree");
      return;
    }

    log.info({ jobId: job.id, name: job.name, worktreeId }, "executing cronjob");

    // Terminal dispatch (issue #581). `spawnCronTerminal` throws
    // `TaskConflictError` when the job's previous pane is still alive (record
    // "skipped", identical to the chat running-task conflict below) and returns
    // `{ terminalId: null }` when the agent has no vendor CLI — in which case we
    // fall through to the chat path so the fire still does something.
    if (job.via === "terminal") {
      try {
        const { terminalId } = await this.spawnCronTerminal(job, worktreeId, fileKey);
        if (terminalId) {
          log.info({ jobId: job.id, terminalId, worktreeId }, "cronjob terminal spawned");
          this.safeUpdateLastRun(job.id, "completed");
          return;
        }
        log.info(
          { jobId: job.id, worktreeId },
          "via=terminal not supported by agent; falling back to chat dispatch",
        );
      } catch (err) {
        if (err instanceof TaskConflictError) {
          log.info(
            { jobId: job.id, worktreeId },
            "previous terminal run still active, skipping cronjob execution",
          );
          this.safeUpdateLastRun(job.id, "skipped");
          return;
        }
        log.error({ jobId: job.id, err }, "cronjob terminal dispatch failed");
        this.safeUpdateLastRun(job.id, "failed");
        return;
      }
    }

    try {
      const sent = await this.dispatchToChat(job, worktreeId);
      // Log the resulting task id so operators auditing a scheduled fire
      // can correlate it back to the `tasks.list` row. Mirrors the
      // observability the manual `trigger()` path returns to its caller.
      log.info({ jobId: job.id, worktreeId, ...sent }, "cronjob prompt sent");
      this.safeUpdateLastRun(job.id, "completed");
    } catch (err) {
      if (err instanceof CronjobDispatchError) {
        log.warn({ jobId: job.id, worktreeId }, err.message);
        this.safeUpdateLastRun(job.id, "failed", err.message);
        return;
      }
      if (err instanceof TaskConflictError) {
        log.info({ jobId: job.id, worktreeId }, "task already running, skipping cronjob execution");
        this.safeUpdateLastRun(job.id, "skipped");
        return;
      }
      log.error({ jobId: job.id, err }, "cronjob execution failed");
      this.safeUpdateLastRun(job.id, "failed", err instanceof Error ? err.message : String(err));
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
  private safeUpdateLastRun(
    jobId: string,
    status: "completed" | "failed" | "skipped",
    message?: string,
  ): void {
    try {
      this.queries.updateLastRun(jobId, status, message);
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
 * the server bootstrap (`start-server.ts`), and the repo/worktree removal
 * paths in the legacy `trpc/router.ts`. `CronjobService` holds its scheduler
 * state on a `globalThis`-keyed symbol so re-instantiating it is harmless,
 * but centralising the instance here keeps the call sites tidy.
 */
export const cronjobService = new CronjobService();
