import {
  detectHookAgentType,
  hookSessionId,
  isHookSessionEnd,
  mapHookPayloadToStatus,
} from "@band-app/coding-agent";
import { toWorkspaceId } from "@band-app/shared/workspace-id";
import {
  type ProjectKind,
  ProjectQueries,
  type ProjectState,
  reconcileKindForProject,
  type WorktreeState,
} from "../infra/db/queries/projects";
import {
  bandHome,
  type CodingAgentDefinition,
  type LabelDefinition,
  type NotificationSettings,
  type Settings,
} from "../infra/db/queries/settings";
import {
  WorkspaceStatusQueries,
  WorkspaceStatusSourceQueries,
  type WorkspaceStatusSourceRow,
} from "../infra/db/queries/workspace-statuses";
import { type WorkspaceIdentity, WorkspaceQueries } from "../infra/db/queries/workspaces";
import {
  emit,
  subscribe,
  type TabAgentStatus,
  type WorkspaceAgentInfo,
  type WorkspaceStatusSnapshot,
} from "../infra/events/status-event-bus";
import { SettingsService, settingsService } from "./settings-service";

const workspaceStatusQueries = new WorkspaceStatusQueries();
const statusSourceQueries = new WorkspaceStatusSourceQueries();

// Workspace-identity resolution lives in the Infra tier now (issue #314,
// Phase 3 of the 3-tier refactor). The legacy private helper below
// delegates to it so the SQL exists in exactly one place; the long-form
// docstring lives on `WorkspaceQueries.findIdentity`.
const workspaceQueriesForIdentity = new WorkspaceQueries();

// Settings types live in the Infra layer (issue #312, Phase 1 of the
// 3-tier refactor). Re-exported here as a convenience so callers that
// already import from `services/state` get the types alongside the
// state-level helpers below. The canonical home is
// `server/infra/db/queries/settings`.
export type { CodingAgentDefinition, LabelDefinition, NotificationSettings, Settings };
export { bandHome };

// Project types + the kind reconciliation helper live in the Infra layer
// (issue #313, Phase 2 of the 3-tier refactor). Re-exported here as a
// convenience for callers (sync-state, branch-status-poller,
// workspace.ts, …) that already import from this module. The canonical
// home is `server/infra/db/queries/projects.ts`.
export type { ProjectKind, ProjectState, WorktreeState };
export { reconcileKindForProject };

// -----------------------------------------------------------------------------
// Project state — thin re-export surface over `ProjectQueries`.
//
// `ProjectQueries` (in `server/infra/db/queries/projects.ts`) owns the
// real CRUD for the `projects` + `worktrees` tables. The wrappers below
// preserve the legacy function-style call shape (`loadState()`,
// `saveState(state)`, `setProjectHasOrigin(name, flag)`) that the rest
// of the codebase still speaks. They're accepted as the long-term shape
// for these read paths — the doc lists `state.ts` under services as a
// legacy state-file shim — but new code should reach for
// `ProjectQueries` directly. The non-shim orchestration in this file
// (`upsertWorkspaceStatus`, `resetAgentStatuses`,
// `deleteWorkspaceStatus`) wraps `WorkspaceStatusQueries` with the
// service-tier identity self-heal + change-detection rules.
// -----------------------------------------------------------------------------

const projectQueries = new ProjectQueries();

export interface AppState {
  projects: ProjectState[];
}

// `AgentInfo` is the legacy alias for the workspace-agent snapshot used in
// the status event bus. The canonical type now lives in
// `infra/events/status-event-bus.ts::WorkspaceAgentInfo` — re-exported
// here so existing callers that import `AgentInfo` from `services/state`
// keep compiling unchanged.
export type AgentInfo = WorkspaceAgentInfo;
export type WorkspaceStatus = WorkspaceStatusSnapshot;

export function loadState(): AppState {
  return { projects: projectQueries.loadAll() };
}

/**
 * Targeted UPDATE for `projects.has_origin` only — does NOT go through
 * the whole-tree `saveState` rewrite. See `ProjectQueries.setHasOrigin`
 * for the full rationale.
 */
export function setProjectHasOrigin(name: string, hasOrigin: boolean): void {
  projectQueries.setHasOrigin(name, hasOrigin);
}

export function saveState(state: AppState): void {
  projectQueries.saveAll(state.projects);
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

export function worktreesDir(): string {
  return settingsService.worktreesDir();
}

/**
 * Read-side helpers over `WorkspaceStatusQueries` in the infra tier (issue
 * #535, follow-up 7). The query class owns the SQL + row → snapshot
 * mapping; these add each snapshot's `tabStatuses`, derived from the
 * workspace's rows in `workspace_status_sources`.
 */
export function loadCurrentStatuses(): WorkspaceStatus[] {
  const sourcesByWorkspace = new Map<string, WorkspaceStatusSourceRow[]>();
  for (const source of statusSourceQueries.listAll()) {
    const list = sourcesByWorkspace.get(source.workspaceId);
    if (list) list.push(source);
    else sourcesByWorkspace.set(source.workspaceId, [source]);
  }
  return workspaceStatusQueries.loadCurrent().map((status) => ({
    ...status,
    tabStatuses: toTabStatuses(sourcesByWorkspace.get(status.workspaceId) ?? []),
  }));
}

export function getWorkspaceStatus(workspaceId: string): WorkspaceStatus | null {
  const status = workspaceStatusQueries.getByWorkspaceId(workspaceId);
  if (!status) return null;
  return { ...status, tabStatuses: listTabStatuses(workspaceId) };
}

export function upsertWorkspaceStatus(
  workspaceId: string,
  agent: { status: string; lastActivity?: string; codingAgentId?: string },
): WorkspaceStatus {
  const existing = workspaceStatusQueries.findRow(workspaceId);

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
  let finalProject = existing?.project ?? "";
  let finalBranch = existing?.branch ?? "";
  let finalWorktreePath = existing?.worktreePath ?? "";

  if (existing) {
    // Self-heal stale rows whose identity fields are empty. Older rows
    // could be inserted with empty `project`/`branch`/`worktreePath`
    // when the agent started before the project's worktree was
    // persisted (or were left behind by a prior version of Band). The
    // desktop EditorPicker in the right sidepanel header is gated on a
    // non-empty `worktreePath` (DesktopTitleBar.tsx), so an empty value hides
    // the dropdown forever even though the worktree path is
    // recoverable from the projects/worktrees tables. Only overwrite
    // fields that are currently empty so we never clobber correct
    // data when the projects table is momentarily out of sync.
    const identityPatch: Partial<{ project: string; branch: string; worktreePath: string }> = {};
    if (!existing.project || !existing.branch || !existing.worktreePath) {
      const ws = resolveWorkspaceIdentity(workspaceId);
      if (ws) {
        if (!existing.project) {
          identityPatch.project = ws.project;
          finalProject = ws.project;
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
    // The poller calls `upsertWorkspaceStatus(_, { status: "waiting" })`
    // on every tick for every idle workspace; without this guard each
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
      identityPatch.project !== undefined ||
      identityPatch.branch !== undefined ||
      identityPatch.worktreePath !== undefined;

    if (agentChanged || identityChanged) {
      workspaceStatusQueries.update(workspaceId, {
        ...mergedAgent,
        ...identityPatch,
        updatedAt: now,
      });
    }
  } else {
    // For new rows, resolve workspace identity from the worktrees DB
    const ws = resolveWorkspaceIdentity(workspaceId);
    finalProject = ws?.project ?? "";
    finalBranch = ws?.branch ?? "";
    finalWorktreePath = ws?.worktreePath ?? "";
    workspaceStatusQueries.insert({
      workspaceId,
      project: finalProject,
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
    workspaceId,
    project: finalProject,
    branch: finalBranch,
    worktreePath: finalWorktreePath,
    agent: {
      name: mergedAgent.agentName,
      status: mergedAgent.agentStatus,
      lastActivity: mergedAgent.agentLastActivity,
      summary: mergedAgent.agentSummary ?? undefined,
      codingAgentId: mergedAgent.codingAgentId ?? undefined,
    },
    tabStatuses: listTabStatuses(workspaceId),
  };
}

/**
 * Map a working directory to the workspace it belongs to, or `null` if no
 * known worktree contains it. Used by the `statuses.resolve` and
 * `statuses.notify` procedures.
 */
export function resolveWorkspaceIdByCwd(cwd: string): string | null {
  const state = loadState();
  for (const proj of state.projects) {
    for (const wt of proj.worktrees) {
      if (cwd === wt.path || cwd.startsWith(`${wt.path}/`)) {
        return toWorkspaceId(proj.name, wt.name);
      }
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Status sources.
//
// Several agents can report into one workspace: every chat pane's ACP turns,
// and every hook-reporting CLI session (a Claude Code in a terminal). Each
// keeps its own row in `workspace_status_sources`, and the workspace's
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
  { sourceId, status, updatedAt }: WorkspaceStatusSourceRow,
  staleBefore: number,
): boolean {
  return sourceId.startsWith("hook:") && status === "working" && updatedAt < staleBefore;
}

function deriveWorkspaceStatus(workspaceId: string): string {
  const staleBefore = Date.now() - STALE_HOOK_WORKING_MS;
  let best: string | null = null;
  for (const source of statusSourceQueries.listForWorkspace(workspaceId)) {
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
function toTabStatuses(sources: WorkspaceStatusSourceRow[]): TabAgentStatus[] {
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

function listTabStatuses(workspaceId: string): TabAgentStatus[] {
  return toTabStatuses(statusSourceQueries.listForWorkspace(workspaceId));
}

/**
 * Record one source's status and write the workspace status derived from
 * every source. Returns the workspace snapshot to broadcast.
 */
export function setWorkspaceSourceStatus(
  workspaceId: string,
  sourceId: string,
  agent: { status: string; lastActivity?: string; terminalId?: string },
): WorkspaceStatus {
  statusSourceQueries.upsert({
    workspaceId,
    sourceId,
    status: agent.status,
    terminalId: agent.terminalId ?? null,
    updatedAt: Date.now(),
  });
  return upsertWorkspaceStatus(workspaceId, {
    status: deriveWorkspaceStatus(workspaceId),
    lastActivity: agent.lastActivity,
  });
}

/** Re-derive a workspace's status after sources went away. `null` when it has no row. */
function rederiveWorkspaceStatus(workspaceId: string): WorkspaceStatus | null {
  if (!workspaceStatusQueries.findRow(workspaceId)) return null;
  return upsertWorkspaceStatus(workspaceId, { status: deriveWorkspaceStatus(workspaceId) });
}

/**
 * Drop one source (its chat was removed, its session ended). Returns the
 * re-derived workspace snapshot, or `null` when nothing changed.
 */
export function removeWorkspaceSource(
  workspaceId: string,
  sourceId: string,
): WorkspaceStatus | null {
  if (!statusSourceQueries.remove(workspaceId, sourceId)) return null;
  return rederiveWorkspaceStatus(workspaceId);
}

/**
 * The user has seen the workspace: every source asking for attention goes
 * back to `waiting`, except the chats in `pendingChatIds`, whose agent still
 * waits on a permission or elicitation answer (answering it clears them).
 * Returns the workspace snapshot to broadcast, or `null` when it has none.
 */
export function acknowledgeWorkspaceAttention(
  workspaceId: string,
  pendingChatIds: string[],
): WorkspaceStatus | null {
  const existing = getWorkspaceStatus(workspaceId);
  if (existing?.agent?.status !== "needs_attention") return existing;
  statusSourceQueries.acknowledge(workspaceId, pendingChatIds.map(chatStatusSource), Date.now());
  return upsertWorkspaceStatus(workspaceId, { status: deriveWorkspaceStatus(workspaceId) });
}

/**
 * Drop sources whose chat or terminal goes away, and broadcast the
 * re-derived workspace status. Called once at boot.
 */
export function startStatusSourceCleanup(): () => void {
  return subscribe((event) => {
    const changed: WorkspaceStatus[] = [];
    if (event.kind === "chat-removed" && event.chatId && event.workspaceId) {
      const status = removeWorkspaceSource(event.workspaceId, chatStatusSource(event.chatId));
      if (status) changed.push(status);
    } else if (event.kind === "terminal-killed" && event.terminalId) {
      for (const workspaceId of statusSourceQueries.removeForTerminal(event.terminalId)) {
        const status = rederiveWorkspaceStatus(workspaceId);
        if (status) changed.push(status);
      }
    }
    for (const status of changed) emit({ kind: "update", status });
  });
}

/** A coding-agent hook forwarded by `band notify`. */
export interface HookNotification {
  /** Where the agent runs; picks the workspace. */
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
 * through `band notify`) to the workspace that owns `cwd`.
 *
 * The hook is read with the rules of the agent that sent it: the one the
 * hook command names, else the one its payload identifies, else the
 * workspace's configured agent. Each agent session is its own status source
 * (`hook:<session id>`). Returns the updated status snapshot, or `null` when
 * nothing changed: `cwd` maps to no known workspace (matching the
 * fire-and-forget hook contract), or the hook came from a chat pane's agent,
 * whose status its ACP turn already reports. The caller broadcasts the
 * returned snapshot.
 */
export async function applyHookNotification(
  notification: HookNotification,
): Promise<WorkspaceStatus | null> {
  const { payload } = notification;
  if (notification.dispatch === "chat") return null;
  const workspaceId = resolveWorkspaceIdByCwd(notification.cwd);
  if (!workspaceId) return null;

  const agentType =
    notification.agent ||
    detectHookAgentType(payload) ||
    settingsService.getAgentDefinition(getWorkspaceStatus(workspaceId)?.agent?.codingAgentId).type;
  const sourceId = `hook:${hookSessionId(payload) ?? agentType}`;

  if (isHookSessionEnd(agentType, payload)) {
    return removeWorkspaceSource(workspaceId, sourceId);
  }

  const status = await mapHookPayloadToStatus(agentType, payload);
  return setWorkspaceSourceStatus(workspaceId, sourceId, {
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
  return workspaceStatusQueries.resetActiveToWaiting(Date.now());
}

function resolveWorkspaceIdentity(workspaceId: string): WorkspaceIdentity | null {
  // Delegate to `WorkspaceQueries.findIdentity` so the SQL match
  // expression (`project || '-' || REPLACE(branch, '/', '-')`) lives in
  // exactly one place. See that method's docstring for the encoding
  // details and the non-injective-encoding TODO.
  return workspaceQueriesForIdentity.findIdentity(workspaceId);
}

export function deleteWorkspaceStatus(workspaceId: string): void {
  workspaceStatusQueries.remove(workspaceId);
  statusSourceQueries.removeForWorkspace(workspaceId);
}
