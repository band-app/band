import { eq, or } from "drizzle-orm";
import { getDb } from "../server/infra/db/connection";
import {
  type ProjectKind,
  ProjectQueries,
  type ProjectState,
  reconcileKindForProject,
  type WorktreeState,
} from "../server/infra/db/queries/projects";
import {
  bandHome,
  type CodingAgentDefinition,
  type LabelDefinition,
  type NotificationSettings,
  type Settings,
} from "../server/infra/db/queries/settings";
import { type WorkspaceIdentity, WorkspaceQueries } from "../server/infra/db/queries/workspaces";
import { workspaceStatuses as workspaceStatusesTable } from "../server/infra/db/schema";
import { SettingsService, settingsService } from "../server/services/settings-service";

// Workspace-identity resolution lives in the Infra tier now (issue #314,
// Phase 3 of the 3-tier refactor). The legacy private helper below
// delegates to it so the SQL exists in exactly one place; the long-form
// docstring lives on `WorkspaceQueries.findIdentity`.
const workspaceQueriesForIdentity = new WorkspaceQueries();

// Settings types live in the Infra layer now (issue #312, Phase 1 of the
// 3-tier refactor). Re-export them so existing callers that still import
// from `lib/state` keep compiling — subsequent phases will rewrite those
// callers to import directly from `server/services/settings-service` /
// `server/infra/db/queries/settings`.
export type { CodingAgentDefinition, LabelDefinition, NotificationSettings, Settings };
export { bandHome };

// Project types + the kind reconciliation helper live in the Infra layer
// now (issue #313, Phase 2 of the 3-tier refactor). Re-export from this
// module so existing callers (sync-state, branch-status-poller,
// workspace.ts, …) keep compiling. The real implementations live under
// `server/infra/db/queries/projects.ts`; subsequent refactor phases will
// rewrite each caller to import from there directly and this shim will
// go away.
export type { ProjectKind, ProjectState, WorktreeState };
export { reconcileKindForProject };

// -----------------------------------------------------------------------------
// Project state — back-compat shims around the new infra/service layer.
//
// `ProjectQueries` (in `server/infra/db/queries/projects.ts`) owns the
// real CRUD for the `projects` + `worktrees` tables. The wrappers below
// preserve the old `lib/state` import surface so unmigrated callers (the
// legacy tRPC router, sync-state, workspace.ts, …) keep compiling
// unchanged. Later refactor phases will migrate each caller to talk to
// the infra/service tiers directly and this section will be deleted.
// -----------------------------------------------------------------------------

const projectQueries = new ProjectQueries();

export interface AppState {
  projects: ProjectState[];
}

export interface AgentInfo {
  name: string;
  status: string;
  lastActivity: string;
  summary?: string;
  codingAgentId?: string;
}

export interface WorkspaceStatus {
  workspaceId: string;
  project: string;
  branch: string;
  worktreePath: string;
  agent?: AgentInfo;
}

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

export function loadCurrentStatuses(): WorkspaceStatus[] {
  const db = getDb();
  const rows = db.select().from(workspaceStatusesTable).all();
  return rows.map((row) => ({
    workspaceId: row.workspaceId,
    project: row.project,
    branch: row.branch,
    worktreePath: row.worktreePath,
    agent: row.agentName
      ? {
          name: row.agentName,
          status: row.agentStatus ?? "unknown",
          lastActivity: row.agentLastActivity ?? "",
          summary: row.agentSummary ?? undefined,
          codingAgentId: row.codingAgentId ?? undefined,
        }
      : undefined,
  }));
}

export function getWorkspaceStatus(workspaceId: string): WorkspaceStatus | null {
  const db = getDb();
  const row = db
    .select()
    .from(workspaceStatusesTable)
    .where(eq(workspaceStatusesTable.workspaceId, workspaceId))
    .get();
  if (!row) return null;
  return {
    workspaceId: row.workspaceId,
    project: row.project,
    branch: row.branch,
    worktreePath: row.worktreePath,
    agent: row.agentName
      ? {
          name: row.agentName,
          status: row.agentStatus ?? "unknown",
          lastActivity: row.agentLastActivity ?? "",
          summary: row.agentSummary ?? undefined,
          codingAgentId: row.codingAgentId ?? undefined,
        }
      : undefined,
  };
}

export function upsertWorkspaceStatus(
  workspaceId: string,
  agent: { status: string; lastActivity?: string; codingAgentId?: string },
): WorkspaceStatus {
  const db = getDb();

  // Read existing row to preserve fields
  const existing = db
    .select()
    .from(workspaceStatusesTable)
    .where(eq(workspaceStatusesTable.workspaceId, workspaceId))
    .get();

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
      db.update(workspaceStatusesTable)
        .set({ ...mergedAgent, ...identityPatch, updatedAt: now })
        .where(eq(workspaceStatusesTable.workspaceId, workspaceId))
        .run();
    }
  } else {
    // For new rows, resolve workspace identity from the worktrees DB
    const ws = resolveWorkspaceIdentity(workspaceId);
    finalProject = ws?.project ?? "";
    finalBranch = ws?.branch ?? "";
    finalWorktreePath = ws?.worktreePath ?? "";
    db.insert(workspaceStatusesTable)
      .values({
        workspaceId,
        project: finalProject,
        branch: finalBranch,
        worktreePath: finalWorktreePath,
        ...mergedAgent,
        updatedAt: now,
      })
      .run();
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
 * Reset stale agent statuses to "waiting".
 * Called on server startup — no agent can be running if the server just started,
 * and any pending input requests are lost so "needs_attention" is also stale.
 */
export function resetAgentStatuses(): number {
  const db = getDb();
  const result = db
    .update(workspaceStatusesTable)
    .set({ agentStatus: "waiting", updatedAt: Date.now() })
    .where(
      or(
        eq(workspaceStatusesTable.agentStatus, "working"),
        eq(workspaceStatusesTable.agentStatus, "needs_attention"),
      ),
    )
    .run();
  return result.changes;
}

function resolveWorkspaceIdentity(workspaceId: string): WorkspaceIdentity | null {
  // Delegate to `WorkspaceQueries.findIdentity` so the SQL match
  // expression (`project || '-' || REPLACE(branch, '/', '-')`) lives in
  // exactly one place. See that method's docstring for the encoding
  // details and the non-injective-encoding TODO.
  return workspaceQueriesForIdentity.findIdentity(workspaceId);
}

export function deleteWorkspaceStatus(workspaceId: string): void {
  const db = getDb();
  db.delete(workspaceStatusesTable)
    .where(eq(workspaceStatusesTable.workspaceId, workspaceId))
    .run();
}
