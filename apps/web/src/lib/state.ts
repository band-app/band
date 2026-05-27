import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { eq, or, sql } from "drizzle-orm";
import { toWorkspaceId } from "@/dashboard";
import { getDb } from "../server/infra/db/connection";
import {
  branchStatuses as branchStatusesTable,
  projects as projectsTable,
  workspaceStatuses as workspaceStatusesTable,
  worktrees as worktreesTable,
} from "../server/infra/db/schema";

export type ProjectKind = "git" | "plain";

/**
 * Re-detect `kind` from the filesystem and reconcile the in-memory
 * project row IN PLACE. The function always mutates `project.kind`
 * (and `project.worktrees` on a `git → plain` flip) when the
 * detected value disagrees with the stored one — the caller's only
 * decision is whether to flush the mutated row to disk.
 *
 * Today two call sites share this: `syncWorktrees` propagates the
 * return value into its `changed` flag and persists via `saveState`
 * at the end of the loop; the inline path in `projects.list`
 * discards the return value and lets the next sync tick persist.
 *
 * Returns `true` when the row was mutated, `false` otherwise.
 */
export function reconcileKindForProject(project: ProjectState): boolean {
  // Skip rows whose path no longer exists — leave kind alone rather
  // than synthesize a workspace under a missing directory.
  if (!existsSync(project.path)) return false;
  // `existsSync(.git)` returns true for both directories AND files. Git
  // submodules and secondary worktrees embed a `.git` file (rather
  // than a directory) that points at the parent repo — we want those
  // classified as "git" too.
  const detectedKind: ProjectKind = existsSync(join(project.path, ".git")) ? "git" : "plain";
  if (detectedKind === project.kind) return false;

  project.kind = detectedKind;
  // On a `git → plain` flip (`.git` disappeared from under us — e.g. a
  // `rm -rf .git` from a terminal), replace any existing worktree
  // rows with the implicit `{branch: "main", path: project.path}`
  // workspace. We do this unconditionally for `plain` (not only when
  // worktrees is empty) because a real git project flipping to plain
  // will still have its old `feat/foo` / `fix/bar` entries; leaving
  // them would orphan the rows (their worktree paths under
  // `worktreesDir/{project}/{branch}` are now broken git worktrees
  // with no `.git` to reach back to) and the flattened plain UI would
  // render the wrong branch label.
  if (detectedKind === "plain") {
    project.worktrees = [{ branch: "main", path: project.path, pinned: false }];
  }
  return true;
}

export interface ProjectState {
  name: string;
  path: string;
  defaultBranch: string;
  worktrees: WorktreeState[];
  label?: string;
  /**
   * "git" projects use git worktrees for per-workspace isolation.
   * "plain" projects have a single implicit workspace whose path equals the
   *  project path — no isolation, no branch, git-specific features disabled.
   */
  kind: ProjectKind;
  /**
   * Whether the project's git repo has an `origin` remote.
   *
   * Populated by `syncWorktrees` at the CI tick cadence and used by
   * `branch-status-poller` to skip the CI / `getRepoInfo` query for
   * origin-less repos — that's an expected steady state for some
   * projects and the query just produces log noise (issue #458).
   *
   * Defaults to `true` for plain (non-git) projects and for freshly
   * added projects that sync hasn't reached yet, so the first CI tick
   * after boot still issues the query. The real value lands on the
   * next sync pass and sticks until the remote configuration changes.
   */
  hasOrigin: boolean;
}

export interface WorktreeState {
  branch: string;
  path: string;
  head?: string;
  pinned: boolean;
}

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

export interface LabelDefinition {
  id: string;
  name: string;
  color: string;
}

export interface NotificationSettings {
  soundOnNeedsAttention?: boolean;
  sound?: string;
}

export interface CodingAgentDefinition {
  id: string;
  type: string;
  label: string;
  command?: string;
  model?: string;
}

export interface Settings {
  worktreesDir?: string;
  codingAgents?: CodingAgentDefinition[];
  defaultCodingAgent?: string;
  webServerPort?: number;
  notifications?: NotificationSettings;
  labels?: LabelDefinition[];
  tokenSecret?: string;
  autoStartTunnel?: boolean;
  /**
   * Maximum number of workspace dockview instances kept alive in memory at
   * once. Higher values speed up switching back to recent workspaces at the
   * cost of memory and background work. Defaults to 3 in the client.
   */
  maxCachedWorkspaces?: number;
  /**
   * Experimental: forward Claude Code's partial-message stream events
   * (SDK's `includePartialMessages`) so the chat bubble types in
   * token-by-token instead of in per-block bursts. Off by default.
   * See `docs/experiments/partial-messages.md`.
   */
  claudeCodePartialMessages?: boolean;
  /** Extra fields not explicitly modeled. Preserved across read/write. */
  [key: string]: unknown;
}

export function bandHome(): string {
  if (process.env.BAND_HOME) return process.env.BAND_HOME;
  return join(homedir(), ".band");
}

export function loadState(): AppState {
  const db = getDb();
  const projectRows = db.select().from(projectsTable).orderBy(projectsTable.sortOrder).all();

  const worktreeRows = db.select().from(worktreesTable).all();

  const wtByProject = new Map<string, WorktreeState[]>();
  for (const row of worktreeRows) {
    const list = wtByProject.get(row.projectName) ?? [];
    list.push({
      branch: row.branch,
      path: row.path,
      head: row.head ?? undefined,
      pinned: row.pinned,
    });
    wtByProject.set(row.projectName, list);
  }

  return {
    projects: projectRows.map((row) => ({
      name: row.name,
      path: row.path,
      defaultBranch: row.defaultBranch,
      label: row.label ?? undefined,
      kind: (row.kind ?? "git") as ProjectKind,
      hasOrigin: row.hasOrigin,
      worktrees: wtByProject.get(row.name) ?? [],
    })),
  };
}

/**
 * Targeted UPDATE for `projects.has_origin` only — does NOT go through
 * the whole-tree `saveState` rewrite.
 *
 * `saveState` deletes every row in `projects` + `worktrees` and re-inserts
 * from its in-memory snapshot. That's fine for the existing "worktrees /
 * defaultBranch changed" path (it carries the latest worktree list), but
 * it races badly with concurrent `workspaces.create` / `workspaces.remove`
 * traffic for the new "hasOrigin changed" path: a stale `syncWorktrees`
 * copy would clobber a just-saved worktree. Doing the hasOrigin update
 * as a focused single-column UPDATE sidesteps the issue — the worktrees
 * table is untouched. See issue #458.
 */
export function setProjectHasOrigin(name: string, hasOrigin: boolean): void {
  const db = getDb();
  db.update(projectsTable).set({ hasOrigin }).where(eq(projectsTable.name, name)).run();
}

export function saveState(state: AppState): void {
  const db = getDb();

  db.transaction((tx) => {
    tx.delete(worktreesTable).run();
    tx.delete(projectsTable).run();

    for (let i = 0; i < state.projects.length; i++) {
      const project = state.projects[i];
      tx.insert(projectsTable)
        .values({
          name: project.name,
          path: project.path,
          defaultBranch: project.defaultBranch,
          label: project.label ?? null,
          sortOrder: i,
          kind: project.kind,
          // Default to true for any caller that hasn't probed yet (e.g.
          // `projects.add` creating a brand-new row before the first
          // sync tick has run). The real value lands at the next sync.
          hasOrigin: project.hasOrigin ?? true,
        })
        .run();

      for (const wt of project.worktrees) {
        tx.insert(worktreesTable)
          .values({
            projectName: project.name,
            branch: wt.branch,
            path: wt.path,
            head: wt.head ?? null,
            pinned: wt.pinned,
          })
          .run();
      }
    }
  });
}

function settingsFile(): string {
  return join(bandHome(), "settings.json");
}

export function loadSettings(): Settings {
  try {
    const data = readFileSync(settingsFile(), "utf-8");
    return JSON.parse(data) as Settings;
  } catch {
    return {};
  }
}

/**
 * Resolve a coding agent definition by ID.
 * Falls back to the default agent, then the first in the list, then a built-in claude-code default.
 */
export function getAgentDefinition(settings: Settings, agentId?: string): CodingAgentDefinition {
  const agents = settings.codingAgents ?? [];
  if (agentId) {
    const found = agents.find((a) => a.id === agentId);
    if (found) return found;
  }
  if (settings.defaultCodingAgent) {
    const found = agents.find((a) => a.id === settings.defaultCodingAgent);
    if (found) return found;
  }
  if (agents.length > 0) return agents[0];
  return { id: "claude-code", type: "claude-code", label: "Claude Code" };
}

export function saveSettings(settings: Settings): void {
  const filePath = settingsFile();
  // Merge with existing file contents to preserve unknown fields (e.g. desktop-shell extras)
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    // File doesn't exist or is invalid — start fresh
  }
  const merged = { ...existing, ...settings };
  const data = `${JSON.stringify(merged, null, 2)}\n`;
  // Atomic write: write to temp file then rename
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, data, "utf-8");
  renameSync(tmpPath, filePath);
}

export function getOrCreateToken(): string {
  const settings = loadSettings();
  if (settings.tokenSecret) return settings.tokenSecret;
  const token = randomBytes(32).toString("hex");
  const current = loadSettings();
  current.tokenSecret = token;
  saveSettings(current);
  return token;
}

export function worktreesDir(): string {
  const settings = loadSettings();
  return settings.worktreesDir ?? join(bandHome(), "worktrees");
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

function resolveWorkspaceIdentity(
  workspaceId: string,
): { project: string; branch: string; worktreePath: string } | null {
  // Push the `toWorkspaceId` match down into SQL: scan the worktrees
  // table directly, filter server-side, and read at most one row. The
  // previous implementation called `loadState()`, which did
  // `SELECT * FROM projects` + `SELECT * FROM worktrees` and built the
  // full ProjectState[] tree just to find a single workspace.
  //
  // The match expression mirrors `toWorkspaceId(project, branch)`:
  //   `${project}-${branch.replaceAll("/", "-")}`
  // SQLite's `REPLACE(str, "/", "-")` is also a replace-all, so this
  // is bit-identical to the JS computation.
  //
  // TODO: `toWorkspaceId`'s encoding is not injective — project
  // `foo-bar` + branch `main` and project `foo` + branch `bar/main`
  // both serialize to `foo-bar-main`. `.get()` returns whichever row
  // SQLite finds first, and the sanity check below cannot
  // disambiguate (both candidates satisfy it). Fixing this requires
  // changing the workspace-id encoding, which is a cross-cutting
  // change tracked separately from this PR.
  const db = getDb();
  const row = db
    .select({
      project: worktreesTable.projectName,
      branch: worktreesTable.branch,
      worktreePath: worktreesTable.path,
    })
    .from(worktreesTable)
    .where(
      sql`${worktreesTable.projectName} || '-' || REPLACE(${worktreesTable.branch}, '/', '-') = ${workspaceId}`,
    )
    .get();
  // Use the `toWorkspaceId` helper as a runtime sanity check in case
  // the helper's encoding ever evolves to disagree with the SQL above.
  if (row && toWorkspaceId(row.project, row.branch) === workspaceId) {
    return { project: row.project, branch: row.branch, worktreePath: row.worktreePath };
  }
  return null;
}

export function deleteWorkspaceStatus(workspaceId: string): void {
  const db = getDb();
  db.delete(workspaceStatusesTable)
    .where(eq(workspaceStatusesTable.workspaceId, workspaceId))
    .run();
}

export function deleteBranchStatus(workspaceId: string): void {
  const db = getDb();
  db.delete(branchStatusesTable).where(eq(branchStatusesTable.workspaceId, workspaceId)).run();
}
