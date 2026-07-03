import type { CodingAgent, SessionUsageSnapshot } from "@band-app/coding-agent";
import { createLogger } from "@band-app/logger";
import { toWorkspaceId } from "@/dashboard";
import { createWorkspaceAgent } from "../agents/agent-pool";
import { ProjectQueries } from "../db/queries/projects";
import { SettingsQueries } from "../db/queries/settings";
import { UsageEventQueries } from "../db/queries/usage-events";
import { UsageScanStateQueries } from "../db/queries/usage-scan-state";

/** Hour in milliseconds — bucket size for the Reports usage table. */
const HOUR_MS = 60 * 60 * 1000;

/**
 * Snap an epoch-ms timestamp down to the start of its UTC hour.
 *
 * UTC is deliberate: the bucket key needs to be deterministic so the
 * scanner's `upsert` always lands on the same row regardless of the
 * server's local timezone. Day-grouped queries still render in the
 * user's local timezone via SQLite's `'localtime'` modifier — see
 * `UsageEventQueries.aggregate`. So users see local-day buckets in the
 * UI even though the storage timestamp is UTC-aligned.
 */
function hourStartUtc(epochMs: number): number {
  return Math.floor(epochMs / HOUR_MS) * HOUR_MS;
}

/**
 * Bucket the adapter's per-turn snapshot into one row per (hour-start,
 * model). Sums every metric column inside the bucket.
 *
 * The `externalKey` encodes the bucket coordinates verbatim
 * (`${provider}:${sessionId}:${hourStartMs}:${model}`) so the
 * `UsageEventQueries.upsert` always lands on the same row when the
 * scanner re-reads the session — the unique index handles the dedup.
 *
 * Exported so the integration tests can pin the bucketing logic
 * without booting the whole scanner.
 */
export interface SessionUsageBucket {
  externalKey: string;
  hourStartMs: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningOutputTokens: number;
  costUsd: number;
}

export function aggregateTurnsByHourAndModel(
  snap: SessionUsageSnapshot,
  provider: string,
): SessionUsageBucket[] {
  // Composite key inside the map is `${hourStartMs}|${model}` — the
  // `|` is illegal in both numeric timestamps and any model id we know
  // about, so it's a safe separator. The map preserves insertion
  // order, giving deterministic output for tests.
  const buckets = new Map<string, SessionUsageBucket>();
  for (const turn of snap.turns) {
    const model = turn.model ?? snap.modelFallback;
    const hourStartMs = hourStartUtc(turn.capturedAt);
    const key = `${hourStartMs}|${model}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        externalKey: `${provider}:${snap.sessionId}:${hourStartMs}:${model}`,
        hourStartMs,
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningOutputTokens: 0,
        costUsd: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.inputTokens += turn.inputTokens;
    bucket.outputTokens += turn.outputTokens;
    bucket.cacheReadTokens += turn.cacheReadTokens ?? 0;
    bucket.cacheCreationTokens += turn.cacheCreationTokens ?? 0;
    bucket.reasoningOutputTokens += turn.reasoningOutputTokens ?? 0;
    bucket.costUsd += turn.costUsd;
  }
  return Array.from(buckets.values());
}

const log = createLogger("usage-scanner");

/**
 * Reports usage scanner (issue #425).
 *
 * Per-tick: iterate every Band workspace × every installed coding agent.
 * For each pair, ask the adapter `listSessions(workspaceDir)` for the
 * sessions tied to that cwd, filter by `lastModified > watermark`, and
 * call `agent.getSessionUsage(sessionId, workspaceDir)` for the ones
 * that have changed. The returned per-turn snapshot is **bucketed by
 * (hour, model)** and one row per bucket is upserted into
 * `usage_events`, keyed by
 * `external_key = "${provider}:${sessionId}:${hourStartMs}:${model}"`.
 *
 * **Why hour buckets, not per-turn rows.** A single provider session
 * can produce dozens of turns; per-turn rows balloon the table without
 * adding signal to Reports' actual breakdowns (by-model / by-day /
 * by-workspace / by-agent / by-project, plus the daily cost-trend
 * chart). Hour-grain preserves sub-day resolution (time-of-day patterns,
 * "what spike happened at 3pm?") at one or two orders of magnitude
 * fewer rows. Cross-midnight sessions split cleanly because each
 * straddled hour gets its own row.
 *
 * **Why include model in the bucket key.** Codex supports switching
 * models mid-session; the by-model breakdown needs each model's
 * contribution attributed correctly. Splitting per model inside an
 * hour costs us a small row-count bump only on the rare sessions that
 * actually switch, and keeps the by-model SUM exact.
 *
 * Two design choices worth noting:
 *
 *   • **Adapter ownership.** Each adapter knows its provider's on-disk
 *     format and handles its own ratecard fallback (`pricing.ts`). This
 *     module is provider-agnostic — it sequences workspaces × agents,
 *     buckets the returned turns, and writes the resulting rows.
 *
 *   • **Watermark is per (workspace, agent).** A workspace with many
 *     agents installed but only one in use still scans cheaply: the
 *     unused agents return zero sessions and the watermark stays at 0
 *     forever, which is fine because the upsert is idempotent anyway.
 *
 * Lifecycle: `start()` runs one pass immediately, then re-runs every
 * `intervalMs` (default 30 s). `stop()` clears the timer. The
 * `reports.summary` tRPC handler also calls `tick()` on every read so
 * users get current data when they open the Reports dialog regardless
 * of the periodic schedule — that means there's no coupling from
 * `task-service` (or any other write path) into this module.
 *
 * Module-level singleton state keyed by `Symbol.for("band.usage-scanner")`
 * so HMR / module re-eval don't double-schedule the timer (same shape
 * as `task-prune-scheduler`).
 */

export interface UsageScannerDeps {
  usageEvents: UsageEventQueries;
  scanState: UsageScanStateQueries;
  /** Override for tests — defaults to enumerating every workspace from
   *  `ProjectQueries` and every installed agent from `SettingsQueries`. */
  listWorkspaces?: () => Array<{
    workspaceId: string;
    project: string;
    worktreePath: string;
  }>;
  /** Override for tests — defaults to enumerating settings.codingAgents
   *  and instantiating a workspace-rooted adapter for each one. */
  listAgents?: () => Array<{ agentId: string; agentType: string }>;
  /** Override for tests — defaults to the real agent pool. */
  createWorkspaceAgent?: (worktreePath: string, agentId: string) => Promise<CodingAgent>;
  /** Wall-clock — overridable for tests. */
  now?: () => number;
  /** Per-(workspace, agent) cap on sessions processed each tick.
   *  Defaults to `MAX_SESSIONS_PER_TICK` (100). Tests drop this to
   *  small values to exercise the multi-tick backfill path. */
  maxSessionsPerTick?: number;
  /**
   * Whether polling is enabled. Read fresh on every tick so a user
   * edit to `settings.usagePollingEnabled` takes effect on the next
   * scheduled tick (and on the next Reports dialog open) without a
   * server restart. Defaults to reading `settings.json` —
   * `undefined`/`true` enable polling, `false` disables it.
   */
  isPollingEnabled?: () => boolean;
}

const SCHEDULER_KEY = Symbol.for("band.usage-scanner");
const g = globalThis as unknown as Record<symbol, unknown>;

interface SchedulerState {
  timer: NodeJS.Timeout | null;
  /** In-flight tick promise — guarantees only one scan runs at a time even
   *  if the periodic timer overlaps with a one-shot prod. */
  inflight: Promise<void> | null;
}

if (!g[SCHEDULER_KEY]) {
  g[SCHEDULER_KEY] = { timer: null, inflight: null } satisfies SchedulerState;
}
const schedulerState = g[SCHEDULER_KEY] as SchedulerState;

/**
 * Default cadence for the periodic tick.
 *
 * Set to 5 minutes because:
 *
 *   • The Reports dialog is a cost dashboard, not a live-chat surface.
 *     Most users care about per-day / per-week spend, where a 5-minute
 *     stale window is invisible. Even "what did I just spend in this
 *     chat?" is covered separately — `reports.summary` fire-and-forget
 *     calls `tick()` on every open, so dialog freshness is bounded by
 *     the user's next refresh click, not this interval.
 *
 *   • At 30 s and a real-world inventory (~39 workspaces × 3 agents,
 *     each `listSessions` taking ~500 ms) the scanner saturates the
 *     event loop in steady state: one full tick takes ~30 s, so the
 *     next tick lands as soon as the previous one finishes. Bumping to
 *     5 min drops effective scanner pressure from ~100% to ~10% without
 *     changing the dialog's first-render experience.
 *
 *   • The `await yieldToEventLoop()` between sessions still keeps the
 *     server responsive during a tick, but stretching the cadence is
 *     the simplest way to claw back background CPU + subprocess churn.
 */
export const USAGE_SCAN_INTERVAL_MS = 5 * 60 * 1_000;

/**
 * Maximum sessions one (workspace, agent) pair processes per tick.
 *
 * Bounded so the very first scan after install doesn't synchronously
 * parse hundreds of MB of provider session JSONL in one go — each
 * `getSessionUsage` parse + DB upsert block is sync from Node's
 * perspective (node:sqlite writes don't yield). Capping at 100 means
 * the worst-case first-tick burst is `100 × ~25 ms ≈ 2.5 s` of
 * combined CPU spread across `await` boundaries, then the next tick
 * picks up where this one left off.
 *
 * The watermark logic guarantees progress: we sort `changed` sessions
 * by `lastModified` ASCENDING and process the oldest N, so the
 * watermark advances to the oldest-processed session's timestamp.
 * Unprocessed sessions (newer ones) still satisfy
 * `lastModified > watermark` on the next tick and get picked up.
 *
 * Exported so tests can drop the cap to demonstrate the chunking.
 */
export const MAX_SESSIONS_PER_TICK = 100;

/** ISO timestamp that's "always older than anything" — used as the
 *  initial watermark sentinel. */
const EPOCH_SENTINEL = 0;

/**
 * Yield to the event loop. Called between each session within a tick
 * so other I/O callbacks (incoming HTTP requests, the periodic
 * branch-status poll, agent SSE pings) get a chance to run between
 * synchronous JSONL parses.
 *
 * Cheaper than `setTimeout(0)` — `setImmediate` schedules at the end
 * of the current poll phase without an arbitrary 1 ms floor.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

export class UsageScannerService {
  private readonly usageEvents: UsageEventQueries;
  private readonly scanState: UsageScanStateQueries;
  private readonly listWorkspaces: NonNullable<UsageScannerDeps["listWorkspaces"]>;
  private readonly listAgents: NonNullable<UsageScannerDeps["listAgents"]>;
  private readonly createWorkspaceAgent: NonNullable<UsageScannerDeps["createWorkspaceAgent"]>;
  private readonly now: () => number;
  private readonly maxSessionsPerTick: number;
  private readonly isPollingEnabled: () => boolean;

  constructor(deps: UsageScannerDeps) {
    this.usageEvents = deps.usageEvents;
    this.scanState = deps.scanState;
    this.listWorkspaces = deps.listWorkspaces ?? defaultListWorkspaces;
    this.listAgents = deps.listAgents ?? defaultListAgents;
    this.createWorkspaceAgent = deps.createWorkspaceAgent ?? createWorkspaceAgent;
    this.now = deps.now ?? Date.now;
    this.maxSessionsPerTick = deps.maxSessionsPerTick ?? MAX_SESSIONS_PER_TICK;
    this.isPollingEnabled = deps.isPollingEnabled ?? defaultIsPollingEnabled;
  }

  /**
   * Run one full scan pass. Resolves when every (workspace, agent) pair
   * has been visited and its watermark advanced. Concurrent calls share
   * a single in-flight promise — the second caller awaits the first.
   *
   * Short-circuits to a no-op when `settings.usagePollingEnabled ===
   * false`. The check happens here (not on the timer or in the router)
   * so every entry point — periodic tick, `reports.summary`
   * fire-and-forget, integration-test direct calls — honours the
   * setting through a single gate.
   */
  async tick(): Promise<void> {
    if (!this.isPollingEnabled()) return;
    if (schedulerState.inflight) return schedulerState.inflight;
    const promise = this.runTick().finally(() => {
      schedulerState.inflight = null;
    });
    schedulerState.inflight = promise;
    return promise;
  }

  private async runTick(): Promise<void> {
    const started = this.now();
    const workspaces = this.listWorkspaces();
    const agents = this.listAgents();
    let totalRows = 0;

    for (const ws of workspaces) {
      for (const a of agents) {
        try {
          totalRows += await this.scanPair(ws, a);
        } catch (err) {
          log.warn(
            { err, workspaceId: ws.workspaceId, agentType: a.agentType },
            "usage scanner pair failed",
          );
        }
      }
    }

    log.debug(
      { durationMs: this.now() - started, workspaces: workspaces.length, rowsWritten: totalRows },
      "usage scanner tick complete",
    );
  }

  /**
   * Scan one (workspace, agent) pair. Returns the number of new rows
   * written so the caller can log a useful aggregate.
   *
   * **Three-step shape (one chunk per tick):**
   *
   *   1. List changed sessions (`lastModified > watermark`) and sort
   *      by `lastModified` ASCENDING. Sorting matters when we chunk:
   *      we process the *oldest* changed sessions first, so the
   *      watermark advance moves through history in order. Newer
   *      sessions get picked up on subsequent ticks without ever
   *      being skipped.
   *
   *   2. Slice to `MAX_SESSIONS_PER_TICK`. The first scan after
   *      install can find hundreds of historical sessions on disk;
   *      we cap the per-tick work so the server never freezes on
   *      a multi-second sync-parse burst.
   *
   *   3. For each session in the slice: yield to the event loop, ask
   *      the adapter for its usage snapshot, bucket the turns by
   *      (hour, model), and **upsert all of that session's buckets in
   *      one SQLite transaction**. One fsync per session instead of
   *      one per bucket.
   *
   * Defends against:
   *   • Adapter without `listSessions` or `getSessionUsage` (skip).
   *   • Agent definition pointing at a missing binary (instantiation
   *     throws — caught, watermark untouched, retried next tick).
   *   • A session listed but missing on disk (getSessionUsage returns
   *     null — we just skip without advancing).
   *
   * Watermark advance: only based on sessions we actually PROCESSED
   * in this tick. Any sessions we deferred to a future tick keep
   * `lastModified > watermark` and will be processed then.
   */
  private async scanPair(
    ws: { workspaceId: string; project: string; worktreePath: string },
    a: { agentId: string; agentType: string },
  ): Promise<number> {
    let agent: CodingAgent;
    try {
      agent = await this.createWorkspaceAgent(ws.worktreePath, a.agentId);
    } catch (err) {
      // Missing binary, broken config — log debug and bail; next tick
      // will retry. We don't punish all workspaces for one bad agent.
      log.debug({ err, agentId: a.agentId }, "failed to instantiate agent for scan");
      return 0;
    }

    if (!agent.listSessions || !agent.getSessionUsage) return 0;

    const watermark = this.scanState.get(ws.workspaceId, a.agentType) ?? EPOCH_SENTINEL;

    let sessions: Awaited<ReturnType<NonNullable<CodingAgent["listSessions"]>>>;
    try {
      sessions = await agent.listSessions(ws.worktreePath);
    } catch (err) {
      log.debug(
        { err, agentId: a.agentId, worktreePath: ws.worktreePath },
        "listSessions failed during usage scan",
      );
      return 0;
    }

    // Sort ascending so the oldest changed sessions are at the front
    // of the slice. Critical for chunked progress — see method doc.
    const changed = sessions
      .filter((s) => s.lastModified > watermark)
      .sort((x, y) => x.lastModified - y.lastModified);
    const slice = changed.slice(0, this.maxSessionsPerTick);

    let rowsWritten = 0;
    let maxObserved = watermark;

    for (const s of slice) {
      // Give other I/O callbacks (incoming HTTP requests, branch poll,
      // agent SSE) a chance to run between sync-blocking parses.
      await yieldToEventLoop();

      let snap: Awaited<ReturnType<NonNullable<CodingAgent["getSessionUsage"]>>>;
      try {
        snap = await agent.getSessionUsage(s.sessionId, ws.worktreePath);
      } catch (err) {
        log.debug(
          { err, sessionId: s.sessionId, agentType: a.agentType },
          "getSessionUsage failed",
        );
        // Still count the session as "processed" for watermark purposes —
        // a permanently broken session shouldn't block the watermark
        // forever. Next tick will retry only if the file is re-modified.
        maxObserved = Math.max(maxObserved, s.lastModified);
        continue;
      }
      if (!snap) {
        // listSessions claimed it existed but getSessionUsage returned
        // null (file was deleted between the two calls). Same
        // reasoning as the catch above — advance the watermark.
        maxObserved = Math.max(maxObserved, s.lastModified);
        continue;
      }

      // Group the session's turns into (hour, model) buckets. See the
      // class-level doc and `aggregateTurnsByHourAndModel` for the
      // bucket key rationale. Each tick re-aggregates the whole
      // session and `upsertBatch` REPLACES the bucket totals — that's
      // correct because the adapter's `getSessionUsage` returns the
      // canonical totals every time, not deltas.
      const buckets = aggregateTurnsByHourAndModel(snap, a.agentType);
      const records = buckets.map((bucket) => ({
        taskId: "",
        chatId: undefined,
        workspaceId: ws.workspaceId,
        project: ws.project,
        sessionId: snap.sessionId,
        codingAgentId: a.agentId,
        provider: a.agentType,
        model: bucket.model,
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        cacheReadTokens: bucket.cacheReadTokens,
        cacheCreationTokens: bucket.cacheCreationTokens,
        reasoningOutputTokens: bucket.reasoningOutputTokens,
        costUsd: bucket.costUsd,
        capturedAt: bucket.hourStartMs,
        externalKey: bucket.externalKey,
      }));
      this.usageEvents.upsertBatch(records);
      rowsWritten += records.length;
      maxObserved = Math.max(maxObserved, s.lastModified);
    }

    // Only advance the watermark when we actually processed something
    // newer than where we started. Defensive — listSessions on an empty
    // workspace returns `[]`, and bumping the watermark to "now" then
    // would silently swallow any future backfill from before that
    // timestamp (e.g. user restores `~/.claude/projects/` from backup).
    //
    // We deliberately advance ONLY based on processed sessions, not
    // the unprocessed tail. Any session deferred to a future tick keeps
    // `lastModified > maxObserved` so the next listing still surfaces
    // it.
    if (maxObserved > watermark) {
      this.scanState.set(ws.workspaceId, a.agentType, maxObserved);
    }

    if (changed.length > slice.length) {
      log.debug(
        {
          workspaceId: ws.workspaceId,
          agentType: a.agentType,
          processed: slice.length,
          remaining: changed.length - slice.length,
        },
        "deferred sessions to next tick (per-tick cap reached)",
      );
    }

    return rowsWritten;
  }
}

/** Default workspace lister — every worktree of every project.
 *  Walks `ProjectQueries.loadAll()` directly (the infra-tier query) so
 *  this module doesn't depend on the services tier. */
function defaultListWorkspaces(): ReturnType<NonNullable<UsageScannerDeps["listWorkspaces"]>> {
  const projects = new ProjectQueries().loadAll();
  const out: Array<{ workspaceId: string; project: string; worktreePath: string }> = [];
  for (const project of projects) {
    for (const worktree of project.worktrees) {
      out.push({
        workspaceId: toWorkspaceId(project.name, worktree.name),
        project: project.name,
        worktreePath: worktree.path,
      });
    }
  }
  return out;
}

/** Default agent lister — every agent installed in user settings.
 *  Reads `SettingsQueries.load()` directly so the scanner stays in the
 *  infra tier (no services-tier dependency). */
function defaultListAgents(): ReturnType<NonNullable<UsageScannerDeps["listAgents"]>> {
  const settings = new SettingsQueries().load();
  const codingAgents = settings.codingAgents ?? [];
  return codingAgents.map((def) => ({ agentId: def.id, agentType: def.type }));
}

/**
 * Default polling-enabled predicate — reads `usagePollingEnabled` from
 * the live `settings.json` (via the infra-tier `SettingsQueries`) and
 * treats `undefined` (or any non-boolean value) as enabled. Re-reading
 * each tick means a user toggling the setting in the dashboard takes
 * effect on the next tick without needing a server restart.
 */
function defaultIsPollingEnabled(): boolean {
  try {
    const settings = new SettingsQueries().load();
    return settings.usagePollingEnabled !== false;
  } catch {
    // Malformed settings file — fail open. The scanner running when
    // the user expected it off is the recoverable failure mode; the
    // opposite would leave them debugging "why isn't usage data
    // showing up?" with no UI to disable it from.
    return true;
  }
}

// ---------------------------------------------------------------------------
// Singleton + interval scheduler
// ---------------------------------------------------------------------------

let singleton: UsageScannerService | null = null;

/** Test seam — pass a constructed service to control the dependencies. */
export function setUsageScannerService(svc: UsageScannerService | null): void {
  singleton = svc;
}

export function getUsageScannerService(): UsageScannerService {
  if (!singleton) {
    singleton = new UsageScannerService({
      usageEvents: new UsageEventQueries(),
      scanState: new UsageScanStateQueries(),
    });
  }
  return singleton;
}

/**
 * Kick off the periodic scan. Runs one pass immediately then every
 * `intervalMs`. Idempotent — a second call is a no-op while the first
 * timer is alive. The timer is `unref()`'d so it doesn't keep the event
 * loop alive on shutdown.
 */
export function startUsageScanner(options: { intervalMs?: number } = {}): void {
  if (schedulerState.timer) return;

  const intervalMs = options.intervalMs ?? USAGE_SCAN_INTERVAL_MS;

  const svc = getUsageScannerService();

  // First pass kicked off immediately but not awaited — boot continues
  // without waiting for the (potentially slow) initial backfill.
  svc.tick().catch((err) => {
    log.warn({ err }, "initial usage scanner tick failed");
  });

  const timer = setInterval(() => {
    svc.tick().catch((err) => {
      log.warn({ err }, "scheduled usage scanner tick failed");
    });
  }, intervalMs);
  timer.unref();
  schedulerState.timer = timer;
}

/** Stop the periodic scan. Used on graceful shutdown and in tests. */
export function stopUsageScanner(): void {
  if (schedulerState.timer) {
    clearInterval(schedulerState.timer);
    schedulerState.timer = null;
  }
}
