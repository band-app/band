import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { toWorkspaceId } from "@band-app/dashboard-core";
import { eq, or } from "drizzle-orm";
import { getDb } from "./db/connection";
import {
  branchStatuses as branchStatusesTable,
  projects as projectsTable,
  workspaceStatuses as workspaceStatusesTable,
  worktrees as worktreesTable,
} from "./db/schema";

export type ProjectKind = "git" | "plain";

/**
 * Re-detect `kind` from the filesystem and reconcile the in-memory
 * project row. Shared between the read-only inline re-detection in
 * `projects.list` (which doesn't persist — queries shouldn't write)
 * and the persistence path in `syncWorktrees` (which calls
 * `saveState` when `changed === true`). Centralising the logic keeps
 * the two callers from drifting.
 *
 * Returns `true` when the row was mutated, so the caller can decide
 * whether to persist.
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
      worktrees: wtByProject.get(row.name) ?? [],
    })),
  };
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

  if (existing) {
    db.update(workspaceStatusesTable)
      .set({ ...mergedAgent, updatedAt: now })
      .where(eq(workspaceStatusesTable.workspaceId, workspaceId))
      .run();
  } else {
    // For new rows, resolve workspace identity from the worktrees DB
    const ws = resolveWorkspaceIdentity(workspaceId);
    db.insert(workspaceStatusesTable)
      .values({
        workspaceId,
        project: ws?.project ?? "",
        branch: ws?.branch ?? "",
        worktreePath: ws?.worktreePath ?? "",
        ...mergedAgent,
        updatedAt: now,
      })
      .run();
  }

  return getWorkspaceStatus(workspaceId)!;
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
  const state = loadState();
  for (const proj of state.projects) {
    for (const wt of proj.worktrees) {
      if (toWorkspaceId(proj.name, wt.branch) === workspaceId) {
        return { project: proj.name, branch: wt.branch, worktreePath: wt.path };
      }
    }
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
