import {
  detectHookAgentType,
  hookSessionId,
  isHookSessionEnd,
  mapHookPayloadToStatus,
} from "@band-app/coding-agent";
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
  type LabelDefinition,
  type NotificationSettings,
  type Settings,
} from "../infra/db/queries/settings";
import {
  WorktreeStatusQueries,
  WorktreeStatusSourceQueries,
  type WorktreeStatusSourceRow,
} from "../infra/db/queries/worktree-statuses";
import { type WorktreeIdentity, WorktreeQueries } from "../infra/db/queries/worktrees";
import {
  emit,
  subscribe,
  type TabAgentStatus,
  type WorktreeAgentInfo,
  type WorktreeStatusSnapshot,
} from "../infra/events/status-event-bus";
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
export type { CodingAgentDefinition, LabelDefinition, NotificationSettings, Settings };
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
  const sourcesByWorktree = new Map<string, WorktreeStatusSourceRow[]>();
  for (const source of statusSourceQueries.listAll()) {
    const list = sourcesByWorktree.get(source.worktreeId);
    if (list) list.push(source);
    else sourcesByWorktree.set(source.worktreeId, [source]);
  }
  return worktreeStatusQueries.loadCurrent().map((status) => ({
    ...status,
    tabStatuses: toTabStatuses(sourcesByWorktree.get(status.worktreeId) ?? []),
  }));
}

export function getWorktreeStatus(worktreeId: string): WorktreeStatus | null {
  const status = worktreeStatusQueries.getByWorktreeId(worktreeId);
  if (!status) return null;
  return { ...status, tabStatuses: listTabStatuses(worktreeId) };
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
    // The poller calls `upsertWorktreeStatus(_, { status: "waiting" })`
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
  };
}

/**
 * Map a working directory to the worktree it belongs to, or `null` if no
 * known worktree contains it. Used by the `statuses.resolve` and
 * `statuses.notify` procedures.
 */
export function resolveWorktreeIdByCwd(cwd: string): string | null {
  const state = loadState();
  for (const proj of state.repos) {
    for (const wt of proj.worktrees) {
      if (cwd === wt.path || cwd.startsWith(`${wt.path}/`)) {
        return toWorktreeId(proj.name, wt.name);
      }
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Status sources.
//
// Several agents can report into one worktree: every chat pane's ACP turns,
// and every hook-reporting CLI session (a Claude Code in a terminal). Each
// keeps its own row in `worktree_status_sources`, and the worktree's
// `agent_status` is derived from all of them, so one agent finishing never
// overwrites another that is still working or waiting on the user.
//
// A hook session can vanish without saying so: Claude Code runs no hook when
// the user interrupts a turn, and one killed or running outside a Band
// terminal sends no `SessionEnd`. So a hook source that has said `working`
// and then gone quiet for `STALE_HOOK_WORKING_MS` stops counting. A live
// Claude Code reports every tool call, and its longest tool call (a Bash
// command) times out after 10 minutes.
// -----------------------------------------------------------------------------

const STALE_HOOK_WORKING_MS = 15 * 60_000;

/** Higher wins when sources disagree; statuses not listed rank lowest. */
const STATUS_PRIORITY: Record<string, number> = { needs_attention: 3, working: 2, waiting: 1 };

const CHAT_SOURCE_PREFIX = "chat:";

/** Source id of a chat pane's ACP turns. */
export function chatStatusSource(chatId: string): string {
  return `${CHAT_SOURCE_PREFIX}${chatId}`;
}

/** Source id of `statuses.update`, which sets a status by hand. */
export const MANUAL_STATUS_SOURCE = "manual";

/** A hook source that said `working` and then went quiet stops counting. */
function isStaleSource(
  { sourceId, status, updatedAt }: WorktreeStatusSourceRow,
  staleBefore: number,
): boolean {
  return sourceId.startsWith("hook:") && status === "working" && updatedAt < staleBefore;
}

function deriveWorktreeStatus(worktreeId: string): string {
  const staleBefore = Date.now() - STALE_HOOK_WORKING_MS;
  let best: string | null = null;
  for (const source of statusSourceQueries.listForWorktree(worktreeId)) {
    if (isStaleSource(source, staleBefore)) continue;
    const { status } = source;
    if (best === null || (STATUS_PRIORITY[status] ?? 0) > (STATUS_PRIORITY[best] ?? 0)) {
      best = status;
    }
  }
  return best ?? "waiting";
}

/**
 * The status each chat and terminal shows on its tab: a chat's own ACP
 * source, and every hook session reported from a Band terminal (the
 * higher-priority status when a terminal has several). Idle sources are
 * left out.
 */
function toTabStatuses(sources: WorktreeStatusSourceRow[]): TabAgentStatus[] {
  const staleBefore = Date.now() - STALE_HOOK_WORKING_MS;
  const byTab = new Map<string, TabAgentStatus>();
  for (const source of sources) {
    const { status } = source;
    if (status !== "working" && status !== "needs_attention") continue;
    if (isStaleSource(source, staleBefore)) continue;
    let tab: TabAgentStatus;
    if (source.sourceId.startsWith(CHAT_SOURCE_PREFIX)) {
      tab = { chatId: source.sourceId.slice(CHAT_SOURCE_PREFIX.length), status };
    } else if (source.terminalId) {
      tab = { terminalId: source.terminalId, status };
    } else {
      continue;
    }
    const key = tab.chatId ? `chat:${tab.chatId}` : `terminal:${tab.terminalId}`;
    const prev = byTab.get(key);
    if (!prev || STATUS_PRIORITY[status] > STATUS_PRIORITY[prev.status]) byTab.set(key, tab);
  }
  return [...byTab.values()];
}

function listTabStatuses(worktreeId: string): TabAgentStatus[] {
  return toTabStatuses(statusSourceQueries.listForWorktree(worktreeId));
}

/**
 * Record one source's status and write the worktree status derived from
 * every source. Returns the worktree snapshot to broadcast.
 */
export function setWorktreeSourceStatus(
  worktreeId: string,
  sourceId: string,
  agent: { status: string; lastActivity?: string; terminalId?: string },
): WorktreeStatus {
  statusSourceQueries.upsert({
    worktreeId,
    sourceId,
    status: agent.status,
    terminalId: agent.terminalId ?? null,
    updatedAt: Date.now(),
  });
  return upsertWorktreeStatus(worktreeId, {
    status: deriveWorktreeStatus(worktreeId),
    lastActivity: agent.lastActivity,
  });
}

/** Re-derive a worktree's status after sources went away. `null` when it has no row. */
function rederiveWorktreeStatus(worktreeId: string): WorktreeStatus | null {
  if (!worktreeStatusQueries.findRow(worktreeId)) return null;
  return upsertWorktreeStatus(worktreeId, { status: deriveWorktreeStatus(worktreeId) });
}

/**
 * Drop one source (its chat was removed, its session ended). Returns the
 * re-derived worktree snapshot, or `null` when nothing changed.
 */
export function removeWorktreeSource(worktreeId: string, sourceId: string): WorktreeStatus | null {
  if (!statusSourceQueries.remove(worktreeId, sourceId)) return null;
  return rederiveWorktreeStatus(worktreeId);
}

/**
 * The user has seen the worktree: every source asking for attention goes
 * back to `waiting`, except the chats in `pendingChatIds`, whose agent still
 * waits on a permission or elicitation answer (answering it clears them).
 * Returns the worktree snapshot to broadcast, or `null` when it has none.
 */
export function acknowledgeWorktreeAttention(
  worktreeId: string,
  pendingChatIds: string[],
): WorktreeStatus | null {
  const existing = getWorktreeStatus(worktreeId);
  if (existing?.agent?.status !== "needs_attention") return existing;
  statusSourceQueries.acknowledge(worktreeId, pendingChatIds.map(chatStatusSource), Date.now());
  return upsertWorktreeStatus(worktreeId, { status: deriveWorktreeStatus(worktreeId) });
}

/**
 * Drop sources whose chat or terminal goes away, and broadcast the
 * re-derived worktree status. Called once at boot.
 */
export function startStatusSourceCleanup(): () => void {
  return subscribe((event) => {
    const changed: WorktreeStatus[] = [];
    if (event.kind === "chat-removed" && event.chatId && event.worktreeId) {
      const status = removeWorktreeSource(event.worktreeId, chatStatusSource(event.chatId));
      if (status) changed.push(status);
    } else if (event.kind === "terminal-killed" && event.terminalId) {
      for (const worktreeId of statusSourceQueries.removeForTerminal(event.terminalId)) {
        const status = rederiveWorktreeStatus(worktreeId);
        if (status) changed.push(status);
      }
    }
    for (const status of changed) emit({ kind: "update", status });
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
}

/**
 * Apply a coding-agent lifecycle notification (e.g. a Claude Code hook piped
 * through `band notify`) to the worktree that owns `cwd`.
 *
 * The hook is read with the rules of the agent that sent it: the one the
 * hook command names, else the one its payload identifies, else the
 * worktree's configured agent. Each agent session is its own status source
 * (`hook:<session id>`). Returns the updated status snapshot, or `null` when
 * nothing changed: `cwd` maps to no known worktree (matching the
 * fire-and-forget hook contract), or the hook came from a chat pane's agent,
 * whose status its ACP turn already reports. The caller broadcasts the
 * returned snapshot.
 */
export async function applyHookNotification(
  notification: HookNotification,
): Promise<WorktreeStatus | null> {
  const { payload } = notification;
  if (notification.dispatch === "chat") return null;
  const worktreeId = resolveWorktreeIdByCwd(notification.cwd);
  if (!worktreeId) return null;

  const agentType =
    notification.agent ||
    detectHookAgentType(payload) ||
    settingsService.getAgentDefinition(getWorktreeStatus(worktreeId)?.agent?.codingAgentId).type;
  const sourceId = `hook:${hookSessionId(payload) ?? agentType}`;

  if (isHookSessionEnd(agentType, payload)) {
    return removeWorktreeSource(worktreeId, sourceId);
  }

  const status = await mapHookPayloadToStatus(agentType, payload);
  return setWorktreeSourceStatus(worktreeId, sourceId, {
    status,
    lastActivity: new Date().toISOString(),
    terminalId: notification.terminalId,
  });
}

/**
 * Reset stale agent statuses to "waiting" and drop every status source.
 * Called on server startup — no agent can be running if the server just
 * started, and any pending input requests are lost so "needs_attention"
 * is also stale. A CLI session that outlived the restart reports again
 * with its next hook.
 */
export function resetAgentStatuses(): number {
  statusSourceQueries.removeAll();
  return worktreeStatusQueries.resetActiveToWaiting(Date.now());
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
