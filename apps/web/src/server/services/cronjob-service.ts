import { randomUUID } from "node:crypto";
import { createLogger } from "@band-app/logger";
import { Cron, type CronOptions } from "croner";
import { z } from "zod";
import { toWorkspaceId } from "@/dashboard";
import {
  type CronjobDefinition,
  CronjobQueries,
  generateCronjobId,
} from "../infra/db/queries/cronjobs";
// FRAGILE: `agentService`, `terminalService`, and `workspaceService` are
// imported at module load but referenced ONLY inside function bodies
// (`spawnCronTerminal` and friends). `workspace-service` already imports
// `cronjobService` from this file, so the two form an ESM cycle — the same
// live-binding constraint documented on the import block in
// `workspace-service.ts` applies: never capture these at module load
// (`const t = terminalService` at the top would get `undefined`), always
// dereference at call time. The `via` enum below is deliberately NOT imported
// from `workspace-service` for exactly this reason — see `cronjobVia`.
import { formatShellCommand } from "./_utils/format-shell-command";
import { agentService } from "./agent-service";
import { BAND_CRON_ID_LABEL, type ChatSession, chatService } from "./chat-service";
import { loadState } from "./state";
import { TaskConflictError, taskService } from "./task-service";
import { terminalService } from "./terminal-service";
import { emit } from "./watcher-service";
import { workspaceService } from "./workspace-service";

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
 * values as `workspaceVia` on `workspaces.create` (#551).
 *
 * Deliberately re-declared here rather than imported from
 * `workspace-service.ts`: that module and this one form an ESM cycle
 * (`workspace-service` imports `cronjobService`), and `workspaceVia` is a
 * module-load value — importing it across the cycle risks reading `undefined`
 * while `workspace-service` is still initialising (see the FRAGILE note on the
 * import block above). Keep the two enums in sync by convention.
 */
export const cronjobVia = z.enum(["chat", "terminal"]);
export type CronjobVia = z.infer<typeof cronjobVia>;

export const cronjobCreateInput = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  prompt: z.string().min(1),
  cronExpression: z.string().min(1),
  scope: z.enum(["project", "workspace"]),
  workspaceId: z.string().optional(),
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
  | { via: "chat"; taskId: string; workspaceId: string; chatId: string }
  | { via: "terminal"; terminalId: string; workspaceId: string };

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
      // Absent `via` means the web UI (or a pre-#581 caller) — default to chat
      // so existing cronjobs keep dispatching exactly as before.
      via: input.via ?? "chat",
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
    const [removed] = file.jobs.splice(index, 1);
    this.queries.saveFile(key, file);
    // Best-effort: tear down the terminal a via="terminal" job last spawned so
    // deleting the job doesn't leave a stray pane running the agent. No-op when
    // the id is unset or the PTY already exited. `kill()` emits `terminal-killed`
    // once — the pool suppresses the `cleanupOnExit` hook on an explicit kill
    // (it detects the session was already removed), so there's no double-emit.
    if (removed?.lastTerminalId) {
      terminalService.kill(removed.lastTerminalId);
    }
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
   *
   * Atomicity caveat: `getOrCreateCronjobChat` and `submitTask` are not run
   * inside a single transaction. If `createChat` succeeds but `submitTask`
   * later throws an unexpected (non-`TaskConflictError`) error, the
   * freshly-created chat remains in the workspace as an orphan with no
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

    const workspaceId = this.resolveWorkspaceId(job, key);
    if (!workspaceId) throw new CronjobProjectNotFoundError();

    // Terminal dispatch mirrors the scheduled fire. `spawnCronTerminal` throws
    // `TaskConflictError` when the previous pane is still alive (→ 409, same as
    // the chat path's running-task conflict) and returns `{ terminalId: null }`
    // when the agent has no vendor CLI, in which case we fall through to chat.
    if (job.via === "terminal") {
      const { terminalId } = await this.spawnCronTerminal(job, workspaceId, key);
      if (terminalId) {
        return { via: "terminal", terminalId, workspaceId };
      }
    }

    const cronChat = this.getOrCreateCronjobChat(workspaceId, job);
    const task = taskService.submitTask({ workspaceId, chatId: cronChat.id, prompt: job.prompt });
    return { via: "chat", taskId: task.id, workspaceId, chatId: cronChat.id };
  }

  // -------------------------------------------------------------------------
  // Lifecycle hooks for workspace/project removal
  // -------------------------------------------------------------------------

  /**
   * Stop all timers for jobs in `key` and remove the file rows.
   *
   * Called when a workspace or project is removed. Order matters: stop
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
   * because re-binding timers for a workspace that's mid-deletion is
   * worse than leaving them stopped: the workspace path is about to be
   * removed and any fire that races the removal would target a
   * non-existent worktree. Re-registration on the next reload is the
   * intentional recovery strategy; operators encountering a partial
   * failure on this path should expect the next reload to be a no-op
   * once the workspace removal completes and the rows are re-attempted.
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
    const existing = chatService.findByLabels(workspaceId, labelMatch);
    if (existing) return existing;
    return chatService.create(workspaceId, {
      name: job.name,
      labels: labelMatch,
      // Cronjob scheduler is a trusted server-side caller — it's allowed
      // to write the reserved `band:` prefix that user-facing surfaces
      // are blocked from touching.
      allowReservedLabels: true,
    });
  }

  /**
   * Dispatch a `via="terminal"` fire: spawn the agent's *headless* vendor CLI
   * in a fresh, self-closing PTY pane. Mirrors the `via=terminal` branch of
   * `WorkspaceService.create` (#551), but adapted for a recurring cron in two
   * important ways:
   *
   *   - **Headless, not interactive.** We use `adapter.cliHeadlessInvocation`
   *     (`claude -p`, `codex exec`, …), NOT the interactive `cliInvocation`
   *     that workspace-create uses. The interactive REPL never exits on its
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
   * the workspace can't be resolved), signalling the caller to fall back to
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
    workspaceId: string,
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
      const workspace = workspaceService.resolve(workspaceId);
      if (!workspace) {
        log.warn(
          { jobId: job.id, workspaceId },
          "workspace not resolvable for via=terminal cronjob; falling back to chat",
        );
        return { terminalId: null };
      }

      // Overlap guard: re-read the row (the scheduled path closes over a stale
      // `job` captured at schedule time) so we check the terminal the LAST fire
      // actually spawned. A live PTY means the previous headless run is still
      // working (a finished one has exited and self-closed).
      const prevTerminalId = this.findJob(fileKey, job.id)?.lastTerminalId;
      if (prevTerminalId && terminalService.getSession(prevTerminalId)) {
        throw new TaskConflictError(`Cronjob ${job.id} terminal run is still in progress`);
      }

      // Resolve the agent's HEADLESS CLI invocation on the request thread so we
      // can fall back to chat synchronously when it's unsupported (e.g.
      // cursor-cli). No `codingAgentId` on the cron row — use the workspace's
      // default agent.
      const adapter = await agentService.createWorkspaceAgent(workspace.worktree.path);
      const invocation = adapter.cliHeadlessInvocation?.(job.prompt);
      // Release the short-lived adapter. `cliHeadlessInvocation` returns pure
      // data and starts no session/subprocess, so this `abort` is a safe no-op
      // for every current adapter; it's kept as a belt-and-braces release in
      // case a future adapter allocates a handle on construction.
      adapter.abort?.();
      if (!invocation || invocation.unsupported) {
        const reason = invocation?.reason ?? "adapter does not expose cliHeadlessInvocation";
        log.warn(
          { jobId: job.id, workspaceId, reason },
          "via=terminal requested but agent has no headless CLI; falling back to chat",
        );
        return { terminalId: null };
      }

      // `\nexit` makes the pane self-close when the headless CLI returns: the
      // pool stages `<command>\n` into a temp file and runs it via the POSIX dot
      // builtin, so a trailing `exit` terminates the shell once the CLI exits.
      const command = `${formatShellCommand(invocation.command, invocation.args)}\nexit`;
      const terminalId = randomUUID();
      await terminalService.spawn(workspaceId, terminalId, { command }, { cleanupOnExit: true });
      // Persist the id BEFORE emitting so the next tick's overlap check sees it
      // even if the emit's subscribers race.
      this.queries.updateLastTerminal(job.id, terminalId);
      // Broadcast so an open dashboard adds the pane without a reload — same
      // pattern as `terminal.create` and the `via=terminal` workspace-create path.
      emit({ kind: "terminal-created", workspaceId, terminalId });
      return { terminalId };
    } finally {
      state.spawningTerminals.delete(job.id);
    }
  }

  /**
   * Resolve the workspace the cronjob fires into.
   *
   * Returns `null` for project-scoped jobs whose project no longer exists
   * (which the scheduled fire path treats as a soft failure — see
   * `executeCronjob`). The manual trigger route maps the same condition to
   * a `CronjobProjectNotFoundError`.
   *
   * Workspace-scoped jobs return `null` rather than falling through to the
   * project-resolution branch when `workspaceId` is somehow missing. The
   * `create` path already rejects this via `CronjobWorkspaceMissingError`,
   * but a workspace-scoped row written by an older server version could
   * theoretically reach here with a null `workspaceId`. Falling through
   * would silently misfire into the project's default branch; returning
   * `null` makes the failure explicit (logged + `lastRunStatus = "failed"`
   * for the scheduler; `CronjobProjectNotFoundError` for the manual
   * trigger path).
   */
  private resolveWorkspaceId(job: CronjobDefinition, fileKey: string): string | null {
    if (job.scope === "workspace") {
      return job.workspaceId ?? null;
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

    // Terminal dispatch (issue #581). `spawnCronTerminal` throws
    // `TaskConflictError` when the job's previous pane is still alive (record
    // "skipped", identical to the chat running-task conflict below) and returns
    // `{ terminalId: null }` when the agent has no vendor CLI — in which case we
    // fall through to the chat path so the fire still does something.
    if (job.via === "terminal") {
      try {
        const { terminalId } = await this.spawnCronTerminal(job, workspaceId, fileKey);
        if (terminalId) {
          log.info({ jobId: job.id, terminalId, workspaceId }, "cronjob terminal spawned");
          this.safeUpdateLastRun(job.id, "completed");
          return;
        }
        log.info(
          { jobId: job.id, workspaceId },
          "via=terminal not supported by agent; falling back to chat dispatch",
        );
      } catch (err) {
        if (err instanceof TaskConflictError) {
          log.info(
            { jobId: job.id, workspaceId },
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
      const chat = this.getOrCreateCronjobChat(workspaceId, job);
      const task = taskService.submitTask({ workspaceId, chatId: chat.id, prompt: job.prompt });
      // Log the resulting task id so operators auditing a scheduled fire
      // can correlate it back to the `tasks.list` row. Mirrors the
      // observability the manual `trigger()` path returns to its caller.
      log.info(
        { jobId: job.id, taskId: task.id, workspaceId, chatId: chat.id },
        "cronjob task submitted",
      );
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
