import {
  type AgentHookStatus,
  detectHookAgentType,
  foldSubagents,
  hookSessionId,
  isHookSessionEnd,
  mapHookPayloadToStatus,
  type SubagentHold,
} from "@band-app/coding-agent";
import type { AgentSessionRecord } from "@band-app/shared/agent-sessions";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import {
  type RepoKind,
  RepoQueries,
  type RepoState,
  reconcileKindForRepo,
  type WorktreeState,
} from "../infra/db/queries/repos";
import {
  bandHome,
  type CodingAgentDefinition,
  type NotificationSettings,
  type Settings,
} from "../infra/db/queries/settings";
import {
  WorktreeStatusQueries,
  WorktreeStatusSourceQueries,
} from "../infra/db/queries/worktree-statuses";
import { type WorktreeIdentity, WorktreeQueries } from "../infra/db/queries/worktrees";
import {
  emit,
  subscribe,
  type TabAgentStatus,
  type TerminalAgent,
  type WorktreeAgentInfo,
  type WorktreeStatusSnapshot,
} from "../infra/events/status-event-bus";
import { agentSessionRegistry } from "./agent-session-registry-service";
import { SettingsService, settingsService } from "./settings-service";

const worktreeStatusQueries = new WorktreeStatusQueries();
const statusSourceQueries = new WorktreeStatusSourceQueries();

// Worktree-identity resolution lives in the Infra tier now (issue #314,
// Phase 3 of the 3-tier refactor). The legacy private helper below
// delegates to it so the SQL exists in exactly one place; the long-form
// docstring lives on `WorktreeQueries.findIdentity`.
const worktreeQueriesForIdentity = new WorktreeQueries();

// Settings types live in the Infra layer (issue #312, Phase 1 of the
// 3-tier refactor). Re-exported here as a convenience so callers that
// already import from `services/state` get the types alongside the
// state-level helpers below. The canonical home is
// `server/infra/db/queries/settings`.
export type { CodingAgentDefinition, NotificationSettings, Settings };
export { bandHome };

// Repo types + the kind reconciliation helper live in the Infra layer
// (issue #313, Phase 2 of the 3-tier refactor). Re-exported here as a
// convenience for callers (sync-state, branch-status-poller,
// worktree.ts, …) that already import from this module. The canonical
// home is `server/infra/db/queries/repos.ts`.
export type { RepoKind, RepoState, WorktreeState };
export { reconcileKindForRepo };

// -----------------------------------------------------------------------------
// Repo state — thin re-export surface over `RepoQueries`.
//
// `RepoQueries` (in `server/infra/db/queries/repos.ts`) owns the
// real CRUD for the `repos` + `worktrees` tables. The wrappers below
// preserve the legacy function-style call shape (`loadState()`,
// `saveState(state)`, `setRepoHasOrigin(name, flag)`) that the rest
// of the codebase still speaks. They're accepted as the long-term shape
// for these read paths — the doc lists `state.ts` under services as a
// legacy state-file shim — but new code should reach for
// `RepoQueries` directly. The non-shim orchestration in this file
// (`upsertWorktreeStatus`, `resetAgentStatuses`,
// `deleteWorktreeStatus`) wraps `WorktreeStatusQueries` with the
// service-tier identity self-heal + change-detection rules.
// -----------------------------------------------------------------------------

const repoQueries = new RepoQueries();

export interface AppState {
  repos: RepoState[];
}

// `AgentInfo` is the legacy alias for the worktree-agent snapshot used in
// the status event bus. The canonical type now lives in
// `infra/events/status-event-bus.ts::WorktreeAgentInfo` — re-exported
// here so existing callers that import `AgentInfo` from `services/state`
// keep compiling unchanged.
export type AgentInfo = WorktreeAgentInfo;
export type WorktreeStatus = WorktreeStatusSnapshot;

export function loadState(): AppState {
  return { repos: repoQueries.loadAll() };
}

/**
 * Targeted UPDATE for `repos.has_origin` only — does NOT go through
 * the whole-tree `saveState` rewrite. See `RepoQueries.setHasOrigin`
 * for the full rationale.
 */
export function setRepoHasOrigin(name: string, hasOrigin: boolean): void {
  repoQueries.setHasOrigin(name, hasOrigin);
}

export function saveState(state: AppState): void {
  repoQueries.saveAll(state.repos);
}

// -----------------------------------------------------------------------------
// Settings — re-exported from the new 3-tier infra/service layer.
//
// The real implementations live under `server/infra/db/queries/settings.ts`
// (file I/O) and `server/services/settings-service.ts` (business logic).
// These wrappers preserve the old `lib/state` import surface so the rest of
// the codebase (chat-manager, agent-pool, setup, …) keeps compiling while
// later refactor phases move each caller to import the service directly.
// -----------------------------------------------------------------------------

export function loadSettings(): Settings {
  return settingsService.get();
}

export function saveSettings(settings: Settings): void {
  settingsService.update(settings);
}

/**
 * Resolve a coding agent definition by ID.
 * Falls back to the default agent, then the first in the list, then a built-in claude-code default.
 *
 * Back-compat shim around `SettingsService.resolveAgent` — preserves the
 * legacy `(settings, agentId)` signature so existing callers that have
 * already loaded a settings snapshot can keep passing it in without a
 * second file read. The fallback logic itself lives in the service so
 * this wrapper stays a one-line delegate (no logic duplication / drift).
 * Later phases of the 3-tier refactor (issue #312 onward) will rewrite
 * each caller to use the service directly and delete this shim.
 */
export function getAgentDefinition(settings: Settings, agentId?: string): CodingAgentDefinition {
  return SettingsService.resolveAgent(settings, agentId);
}

export function getOrCreateToken(): string {
  return settingsService.getOrCreateToken();
}

export function resolveAdminToken(envToken?: string): { token: string; generated: boolean } {
  return settingsService.resolveAdminToken(envToken);
}

export function worktreesDir(): string {
  return settingsService.worktreesDir();
}

/**
 * Read-side helpers over `WorktreeStatusQueries` in the infra tier (issue
 * #535, follow-up 7). The query class owns the SQL + row → snapshot
 * mapping; these add each snapshot's `tabStatuses`, derived from the
 * worktree's rows in `worktree_status_sources`.
 */
export function loadCurrentStatuses(): WorktreeStatus[] {
  const sessionsByWorktree = new Map<string, AgentSessionRecord[]>();
  for (const session of agentSessionRegistry.openWithStatus()) {
    const list = sessionsByWorktree.get(session.worktreeId);
    if (list) list.push(session);
    else sessionsByWorktree.set(session.worktreeId, [session]);
  }
  return worktreeStatusQueries.loadCurrent().map((status) => {
    const sessions = sessionsByWorktree.get(status.worktreeId) ?? [];
    return {
      ...status,
      tabStatuses: toTabStatuses(sessions),
      terminalAgents: toTerminalAgents(sessions),
    };
  });
}

export function getWorktreeStatus(worktreeId: string): WorktreeStatus | null {
  const status = worktreeStatusQueries.getByWorktreeId(worktreeId);
  if (!status) return null;
  return {
    ...status,
    tabStatuses: listTabStatuses(worktreeId),
    terminalAgents: listTerminalAgents(worktreeId),
  };
}

export function upsertWorktreeStatus(
  worktreeId: string,
  agent: { status: string; lastActivity?: string; codingAgentId?: string },
): WorktreeStatus {
  const existing = worktreeStatusQueries.findRow(worktreeId);

  const now = Date.now();
  const mergedAgent = {
    agentName: existing?.agentName ?? "claude-code",
    agentStatus: agent.status,
    agentLastActivity: agent.lastActivity ?? existing?.agentLastActivity ?? "",
    agentSummary: existing?.agentSummary ?? null,
    codingAgentId: agent.codingAgentId ?? existing?.codingAgentId ?? null,
  };

  // Final identity to return. Starts from `existing` (UPDATE) or empty
  // (INSERT); may be overridden by the patch / freshly-resolved values
  // below so we can build the return value in-memory without a third
  // round-trip to the DB.
  let finalRepo = existing?.repo ?? "";
  let finalBranch = existing?.branch ?? "";
  let finalWorktreePath = existing?.worktreePath ?? "";

  if (existing) {
    // Self-heal stale rows whose identity fields are empty. Older rows
    // could be inserted with empty `repo`/`branch`/`worktreePath`
    // when the agent started before the repo's worktree was
    // persisted (or were left behind by a prior version of Band). The
    // desktop EditorPicker in the right sidepanel header is gated on a
    // non-empty `worktreePath` (DesktopTitleBar.tsx), so an empty value hides
    // the dropdown forever even though the worktree path is
    // recoverable from the repos/worktrees tables. Only overwrite
    // fields that are currently empty so we never clobber correct
    // data when the repos table is momentarily out of sync.
    const identityPatch: Partial<{ repo: string; branch: string; worktreePath: string }> = {};
    if (!existing.repo || !existing.branch || !existing.worktreePath) {
      const ws = resolveWorktreeIdentity(worktreeId);
      if (ws) {
        if (!existing.repo) {
          identityPatch.repo = ws.repo;
          finalRepo = ws.repo;
        }
        if (!existing.branch) {
          identityPatch.branch = ws.branch;
          finalBranch = ws.branch;
        }
        if (!existing.worktreePath) {
          identityPatch.worktreePath = ws.worktreePath;
          finalWorktreePath = ws.worktreePath;
        }
      }
    }

    // Skip the write when the row is already in the desired state.
    // The poller calls `upsertWorktreeStatus(_, { status: "idle" })`
    // on every tick for every idle worktree; without this guard each
    // tick produces a WAL frame just to bump `updatedAt`, which nothing
    // reads. `agentName`/`agentSummary` are computed from `existing`
    // and only differ on legacy rows where they were null, so we
    // include them in the comparison too.
    const agentChanged =
      existing.agentName !== mergedAgent.agentName ||
      existing.agentStatus !== mergedAgent.agentStatus ||
      existing.agentLastActivity !== mergedAgent.agentLastActivity ||
      existing.agentSummary !== mergedAgent.agentSummary ||
      existing.codingAgentId !== mergedAgent.codingAgentId;
    const identityChanged =
      identityPatch.repo !== undefined ||
      identityPatch.branch !== undefined ||
      identityPatch.worktreePath !== undefined;

    if (agentChanged || identityChanged) {
      worktreeStatusQueries.update(worktreeId, {
        ...mergedAgent,
        ...identityPatch,
        updatedAt: now,
      });
    }
  } else {
    // For new rows, resolve worktree identity from the worktrees DB
    const ws = resolveWorktreeIdentity(worktreeId);
    finalRepo = ws?.repo ?? "";
    finalBranch = ws?.branch ?? "";
    finalWorktreePath = ws?.worktreePath ?? "";
    worktreeStatusQueries.insert({
      worktreeId,
      repo: finalRepo,
      branch: finalBranch,
      worktreePath: finalWorktreePath,
      ...mergedAgent,
      updatedAt: now,
    });
  }

  // Build the return value in-memory — avoids a third SELECT after
  // the write. `agentName` is always set (defaulted to "claude-code"),
  // so the agent field is always populated after upsert.
  return {
    worktreeId,
    repo: finalRepo,
    branch: finalBranch,
    worktreePath: finalWorktreePath,
    agent: {
      name: mergedAgent.agentName,
      status: mergedAgent.agentStatus,
      lastActivity: mergedAgent.agentLastActivity,
      summary: mergedAgent.agentSummary ?? undefined,
      codingAgentId: mergedAgent.codingAgentId ?? undefined,
    },
    tabStatuses: listTabStatuses(worktreeId),
    terminalAgents: listTerminalAgents(worktreeId),
  };
}

/**
 * Map a working directory to the worktree it belongs to, or `null` if no
 * known worktree contains it. Used by the `statuses.resolve` and
 * `statuses.notify` procedures.
 *
 * With a `hostId`, only worktrees on that host match, because two hosts can hold
 * a worktree at one path. Without one, any host matches and the hub's own
 * machine wins a tie.
 */
export function resolveWorktreeIdByCwd(cwd: string, hostId?: string): string | null {
  const state = loadState();
  let other: string | null = null;
  for (const proj of state.repos) {
    for (const wt of proj.worktrees) {
      const wtHost = wt.hostId ?? LOCAL_HOST_ID;
      if (hostId !== undefined && wtHost !== hostId) continue;
      if (cwd !== wt.path && !cwd.startsWith(`${wt.path}/`)) continue;
      const id = toWorktreeId(proj.name, wt.name, wt.hostId);
      if (wtHost === LOCAL_HOST_ID) return id;
      other ??= id;
    }
  }
  return other;
}

// -----------------------------------------------------------------------------
// Agent status.
//
// Every agent in a worktree is an agent session (`agent_sessions`), a chat
// pane's or a terminal's, and each carries its own `status`. The worktree's
// `agent_status` is derived from its open sessions plus the manual source
// (`statuses.update`, the only row left in `worktree_status_sources`), so
// one agent finishing never overwrites another that is still working or
// waiting on the user.
//
// A terminal agent can vanish without saying so: Claude Code runs no hook
// when the user interrupts a turn, and one killed or running outside a Band
// terminal sends no `SessionEnd`. So a terminal session that has said
// `working` and then gone quiet for `STALE_HOOK_WORKING_MS` stops counting.
// A live Claude Code reports every tool call, and its longest tool call (a
// Bash command) times out after 10 minutes.
// -----------------------------------------------------------------------------

const STALE_HOOK_WORKING_MS = 15 * 60_000;

const LOCAL_HOST_ID = "local";

/** Higher wins when sources disagree; statuses not listed rank lowest. */
const STATUS_PRIORITY: Record<string, number> = {
  question: 6,
  failed: 5,
  working: 4,
  monitoring: 3,
  done: 2,
  idle: 1,
};

/** Source id of `statuses.update`, which sets a status by hand. */
export const MANUAL_STATUS_SOURCE = "manual";

/** A terminal session that said `working` and then went quiet stops counting. */
function isStaleSession(session: AgentSessionRecord, staleBefore: number): boolean {
  return (
    session.mode === "tui" && session.status === "working" && session.statusUpdatedAt < staleBefore
  );
}

function deriveWorktreeStatus(worktreeId: string): string {
  const staleBefore = Date.now() - STALE_HOOK_WORKING_MS;
  let best: string | null = null;
  const consider = (status: string) => {
    if (best === null || (STATUS_PRIORITY[status] ?? 0) > (STATUS_PRIORITY[best] ?? 0)) {
      best = status;
    }
  };
  for (const source of statusSourceQueries.listForWorktree(worktreeId)) consider(source.status);
  for (const session of agentSessionRegistry.listOpen(worktreeId)) {
    if (!isStaleSession(session, staleBefore)) consider(session.status);
  }
  return best ?? "idle";
}

/**
 * The status each chat and terminal shows on its tab: its open session's.
 * Idle sessions are left out.
 */
function toTabStatuses(sessions: AgentSessionRecord[]): TabAgentStatus[] {
  const staleBefore = Date.now() - STALE_HOOK_WORKING_MS;
  const byTab = new Map<string, TabAgentStatus>();
  for (const session of sessions) {
    const { status } = session;
    if (status === "idle" || !(status in STATUS_PRIORITY)) continue;
    if (isStaleSession(session, staleBefore)) continue;
    const tabStatus = status as TabAgentStatus["status"];
    let tab: TabAgentStatus;
    if (session.chatId) tab = { chatId: session.chatId, status: tabStatus };
    else if (session.terminalId) tab = { terminalId: session.terminalId, status: tabStatus };
    else continue;
    const key = tab.chatId ? `chat:${tab.chatId}` : `terminal:${tab.terminalId}`;
    const prev = byTab.get(key);
    if (!prev || STATUS_PRIORITY[status] > STATUS_PRIORITY[prev.status]) byTab.set(key, tab);
  }
  return [...byTab.values()];
}

/**
 * The agent behind each terminal that has an open session, idle or not, so a
 * terminal tab shows the agent's icon from the moment it starts.
 */
function toTerminalAgents(sessions: AgentSessionRecord[]): TerminalAgent[] {
  if (!sessions.some((s) => s.terminalId)) return [];
  const agents = settingsService.get().codingAgents ?? [];
  const out: TerminalAgent[] = [];
  for (const session of sessions) {
    if (!session.terminalId) continue;
    const agentType =
      agents.find((a) => a.id === session.agentDefinitionId)?.type ?? session.agentDefinitionId;
    out.push({ terminalId: session.terminalId, agentType });
  }
  return out;
}

function listTerminalAgents(worktreeId: string): TerminalAgent[] {
  return toTerminalAgents(agentSessionRegistry.listOpen(worktreeId));
}

function listTabStatuses(worktreeId: string): TabAgentStatus[] {
  return toTabStatuses(agentSessionRegistry.listOpen(worktreeId));
}

/**
 * Record the manual status and write the worktree status derived from every
 * agent session and the manual source. Returns the worktree snapshot to
 * broadcast.
 */
export function setManualStatus(
  worktreeId: string,
  agent: { status: string; lastActivity?: string },
): WorktreeStatus {
  statusSourceQueries.upsert({
    worktreeId,
    sourceId: MANUAL_STATUS_SOURCE,
    status: agent.status,
    terminalId: null,
    updatedAt: Date.now(),
  });
  return upsertWorktreeStatus(worktreeId, {
    status: deriveWorktreeStatus(worktreeId),
    lastActivity: agent.lastActivity,
  });
}

/**
 * Record one agent session's status and write the worktree status derived
 * from every session. Returns the worktree snapshot to broadcast, or `null`
 * when the session is gone.
 */
export function setSessionStatus(
  sessionId: string,
  status: string,
  lastActivity?: string,
): WorktreeStatus | null {
  const session = agentSessionRegistry.setStatus(sessionId, status);
  if (!session) return null;
  return upsertWorktreeStatus(session.worktreeId, {
    status: deriveWorktreeStatus(session.worktreeId),
    lastActivity,
  });
}

/** Re-derive a worktree's status after sessions went away. `null` when it has no row. */
function rederiveWorktreeStatus(worktreeId: string): WorktreeStatus | null {
  if (!worktreeStatusQueries.findRow(worktreeId)) return null;
  return upsertWorktreeStatus(worktreeId, { status: deriveWorktreeStatus(worktreeId) });
}

/**
 * The user has seen the worktree: every source and session that finished
 * (`done` or `failed`) goes back to `idle`. A `question` stays until it is
 * answered. Returns the worktree snapshot to broadcast, or `null` when it
 * has none.
 */
export function acknowledgeWorktreeAttention(worktreeId: string): WorktreeStatus | null {
  const existing = getWorktreeStatus(worktreeId);
  if (!existing) return null;
  const changed =
    statusSourceQueries.acknowledge(worktreeId, Date.now()) +
    agentSessionRegistry.acknowledge(worktreeId);
  if (changed === 0) return existing;
  return upsertWorktreeStatus(worktreeId, { status: deriveWorktreeStatus(worktreeId) });
}

/**
 * Re-derive and broadcast a worktree's status when one of its sessions ends
 * (its chat or terminal went away, `SessionEnd`), and drop the session's
 * subagent hold. Called once at boot.
 */
export function startStatusSourceCleanup(): () => void {
  return subscribe((event) => {
    if (event.kind !== "agent-session-ended" || !event.agentSession) return;
    dropSubagentHold(event.agentSession.id);
    const status = rederiveWorktreeStatus(event.agentSession.worktreeId);
    if (status) emit({ kind: "update", status });
  });
}

/** A coding-agent hook forwarded by `band notify`. */
export interface HookNotification {
  /** Where the agent runs; picks the worktree. */
  cwd: string;
  /** The raw hook payload. */
  payload: Record<string, unknown>;
  /** Agent type named by the hook command (`band notify --agent <type>`). */
  agent?: string;
  /** `BAND_DISPATCH` of the agent's process: `chat` or `terminal`. */
  dispatch?: string;
  /** The Band terminal the agent runs in (`BAND_TERMINAL_ID`). */
  terminalId?: string;
  /** The host the agent runs on (`BAND_HOST_ID`); `local` when absent. */
  hostId?: string;
  /** `BAND_AGENT_LAUNCH_TOKEN` of a `band agents launch --mode tui` agent. */
  launchToken?: string;
}

/** Subagents an agent session still runs, by agent session id. */
const subagentHolds = new Map<string, SubagentHold>();

function subagentHold(sessionId: string): SubagentHold {
  let hold = subagentHolds.get(sessionId);
  if (!hold) {
    hold = { running: new Set(), deferred: null };
    subagentHolds.set(sessionId, hold);
  }
  return hold;
}

function dropSubagentHold(sessionId: string): void {
  subagentHolds.delete(sessionId);
}

/** The configured agent definition of a type, else the type itself. */
function agentDefinitionIdFor(agentType: string): string {
  const agents = settingsService.get().codingAgents ?? [];
  return agents.find((agent) => agent.type === agentType)?.id ?? agentType;
}

/**
 * Apply a coding-agent lifecycle notification (e.g. a Claude Code hook piped
 * through `band notify`) to the worktree that owns `cwd`.
 *
 * The hook is read with the rules of the agent that sent it: the one the
 * hook command names, else the one its payload identifies, else the
 * worktree's configured agent. The hook belongs to an agent session: the
 * terminal's (`BAND_TERMINAL_ID`), or, outside a Band terminal, the one
 * keyed by the agent's own session id. Its status is the session's. Returns
 * the updated status snapshot, or `null` when nothing changed: `cwd` maps
 * to no known worktree (matching the fire-and-forget hook contract), or the
 * hook came from a chat pane's agent, whose status its ACP turn already
 * reports. The caller broadcasts the returned snapshot.
 */
export async function applyHookNotification(
  notification: HookNotification,
): Promise<WorktreeStatus | null> {
  const { payload } = notification;
  if (notification.dispatch === "chat") return null;
  const worktreeId = resolveWorktreeIdByCwd(notification.cwd, notification.hostId ?? LOCAL_HOST_ID);
  if (!worktreeId) return null;

  const agentType =
    notification.agent ||
    detectHookAgentType(payload) ||
    settingsService.getAgentDefinition(getWorktreeStatus(worktreeId)?.agent?.codingAgentId).type;

  const sessionEnd = isHookSessionEnd(agentType, payload);
  const session = agentSessionRegistry.recordTerminalHook({
    worktreeId,
    terminalId: notification.terminalId,
    agentDefinitionId: agentDefinitionIdFor(agentType),
    providerSessionId: hookSessionId(payload),
    launchToken: notification.launchToken,
    sessionEnd,
  });
  // `SessionEnd` ended the session, and its listener re-derived the status.
  if (sessionEnd) return rederiveWorktreeStatus(worktreeId);
  if (!session) return null;

  let status: AgentHookStatus = await mapHookPayloadToStatus(agentType, payload);
  if (agentType === "claude-code") {
    status = foldSubagents(subagentHold(session.id), payload, status);
  }
  return setSessionStatus(session.id, status, new Date().toISOString());
}

/**
 * Reset stale agent statuses to "idle". Called on server startup: no agent
 * can be running if the server just started, and any pending input requests
 * are lost, so `working`, `monitoring` and `question` are stale. `done` and
 * `failed` stay, so a restart does not hide that something finished. A CLI
 * session that outlived the restart reports again with its next hook.
 */
export function resetAgentStatuses(): number {
  subagentHolds.clear();
  statusSourceQueries.removeAllButSettled();
  agentSessionRegistry.resetOnBoot();
  return worktreeStatusQueries.resetActiveToIdle(Date.now());
}

function resolveWorktreeIdentity(worktreeId: string): WorktreeIdentity | null {
  // Delegate to `WorktreeQueries.findIdentity` so the SQL match
  // expression (`repo || '-' || REPLACE(branch, '/', '-')`) lives in
  // exactly one place. See that method's docstring for the encoding
  // details and the non-injective-encoding TODO.
  return worktreeQueriesForIdentity.findIdentity(worktreeId);
}

export function deleteWorktreeStatus(worktreeId: string): void {
  worktreeStatusQueries.remove(worktreeId);
  statusSourceQueries.removeForWorktree(worktreeId);
}
