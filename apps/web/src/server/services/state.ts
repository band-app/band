import { mapHookPayloadToStatus } from "@band-app/coding-agent";
import { toWorkspaceId } from "@/dashboard";
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
import { WorkspaceStatusQueries } from "../infra/db/queries/workspace-statuses";
import { type WorkspaceIdentity, WorkspaceQueries } from "../infra/db/queries/workspaces";
import type { WorkspaceAgentInfo, WorkspaceStatusSnapshot } from "../infra/events/status-event-bus";
import { SettingsService, settingsService } from "./settings-service";

const workspaceStatusQueries = new WorkspaceStatusQueries();

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
 * Read-side helpers — thin delegates to `WorkspaceStatusQueries` in the
 * infra tier (issue #535, follow-up 7). The query class owns the SQL +
 * row → snapshot mapping; this module retains the legacy export surface
 * so callers don't churn paths.
 */
export function loadCurrentStatuses(): WorkspaceStatus[] {
  return workspaceStatusQueries.loadCurrent();
}

export function getWorkspaceStatus(workspaceId: string): WorkspaceStatus | null {
  return workspaceStatusQueries.getByWorkspaceId(workspaceId);
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
    // desktop title-bar EditorPicker is gated on a non-empty
    // `worktreePath` (DesktopTitleBar.tsx), so an empty value hides
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
        return toWorkspaceId(proj.name, wt.branch);
      }
    }
  }
  return null;
}

/**
 * Apply a coding-agent lifecycle notification (e.g. a Claude Code hook piped
 * through `band notify`) to the workspace that owns `cwd`.
 *
 * Resolves the workspace, looks up its configured coding agent, and dispatches
 * to that agent's adapter (`mapHookPayloadToStatus`) to translate the raw hook
 * payload into a status — keeping the per-agent mapping in the adapter so the
 * CLI stays agent-agnostic. Returns the updated status snapshot, or `null` when
 * `cwd` maps to no known workspace (a no-op, matching the fire-and-forget hook
 * contract). The caller is responsible for broadcasting the returned snapshot.
 */
export async function applyHookNotification(
  cwd: string,
  payload: Record<string, unknown>,
): Promise<WorkspaceStatus | null> {
  const workspaceId = resolveWorkspaceIdByCwd(cwd);
  if (!workspaceId) return null;

  const existing = getWorkspaceStatus(workspaceId);
  const agentDef = settingsService.getAgentDefinition(existing?.agent?.codingAgentId);
  const status = await mapHookPayloadToStatus(agentDef.type, payload);

  return upsertWorkspaceStatus(workspaceId, {
    status,
    lastActivity: new Date().toISOString(),
  });
}

/**
 * Reset stale agent statuses to "waiting".
 * Called on server startup — no agent can be running if the server just
 * started, and any pending input requests are lost so "needs_attention"
 * is also stale.
 */
export function resetAgentStatuses(): number {
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
}
