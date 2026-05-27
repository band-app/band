import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const workspaceStatuses = sqliteTable("workspace_statuses", {
  workspaceId: text("workspace_id").primaryKey(),
  project: text("project").notNull(),
  branch: text("branch").notNull(),
  worktreePath: text("worktree_path").notNull(),
  agentName: text("agent_name"),
  agentStatus: text("agent_status"),
  agentLastActivity: text("agent_last_activity"),
  agentSummary: text("agent_summary"),
  codingAgentId: text("coding_agent_id"),
  updatedAt: integer("updated_at").notNull(),
});

export const branchStatuses = sqliteTable("branch_statuses", {
  workspaceId: text("workspace_id").primaryKey(),
  gitDirty: integer("git_dirty", { mode: "boolean" }).notNull(),
  gitConflict: integer("git_conflict", { mode: "boolean" }).notNull(),
  gitAhead: integer("git_ahead").notNull(),
  gitBehind: integer("git_behind").notNull(),
  gitSyncState: text("git_sync_state").notNull(),
  ciState: text("ci_state").notNull(),
  ciUrl: text("ci_url"),
  updatedAt: integer("updated_at").notNull(),
});

export const projects = sqliteTable("projects", {
  name: text("name").primaryKey(),
  path: text("path").notNull(),
  defaultBranch: text("default_branch").notNull(),
  label: text("label"),
  sortOrder: integer("sort_order").notNull(),
  // Discriminates between git-backed projects (worktree-per-workspace,
  // branches, PR/CI features) and plain folders (single implicit workspace,
  // no isolation, git features disabled). Defaults to "git" so existing
  // rows keep their behavior unchanged after migration.
  kind: text("kind", { enum: ["git", "plain"] })
    .notNull()
    .default("git"),
  // Whether the project's git repo has an `origin` remote we can use for
  // CI / PR queries. Populated by `syncWorktrees` (see `sync-state.ts`) at
  // the CI tick cadence — `null` means "not yet probed" and is treated as
  // `true` (best-effort) so the first poll after a fresh boot still issues
  // the CI query before sync has had a chance to write the real value.
  // Defaults to 1 (true) so existing rows behave the same after migration.
  // See issue #458.
  hasOrigin: integer("has_origin", { mode: "boolean" }).notNull().default(true),
});

export const worktrees = sqliteTable("worktrees", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectName: text("project_name")
    .notNull()
    .references(() => projects.name, { onDelete: "cascade" }),
  branch: text("branch").notNull(),
  path: text("path").notNull(),
  head: text("head"),
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  project: text("project").notNull(),
  branch: text("branch").notNull(),
  prompt: text("prompt").notNull(),
  status: text("status", { enum: ["running", "completed", "failed"] }).notNull(),
  sessionId: text("session_id"),
  startedAt: integer("started_at").notNull(),
  completedAt: integer("completed_at"),
  maxTurns: integer("max_turns"),
  mode: text("mode"),
  model: text("model"),
  codingAgentId: text("coding_agent_id"),
  chatId: text("chat_id"),
});

export const panelStates = sqliteTable("panel_states", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  panelType: text("panel_type").notNull(),
  state: text("state").notNull(), // JSON blob — panel-type-specific
  // Free-form labels for taxonomy and dispatch lookups (issue #520). JSON-encoded
  // `Record<string, string>`. Nullable: existing rows migrate to NULL and are
  // treated as `{}` by the reader. The `band:` key prefix is reserved for
  // server-internal use (e.g. `band:cronId` set by the cronjob scheduler).
  labels: text("labels"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const cronjobs = sqliteTable("cronjobs", {
  id: text("id").primaryKey(),
  fileKey: text("file_key").notNull(),
  name: text("name").notNull(),
  prompt: text("prompt").notNull(),
  cronExpression: text("cron_expression").notNull(),
  scope: text("scope", { enum: ["project", "workspace"] }).notNull(),
  workspaceId: text("workspace_id"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  lastRunAt: text("last_run_at"),
  lastRunStatus: text("last_run_status", { enum: ["completed", "failed", "skipped"] }),
});

// Persistent browser pane history (per-workspace).
//
// One row per (workspaceId, url): revisiting a URL bumps `visitCount` and
// `lastVisitedAt` rather than inserting a duplicate row. Keeps storage
// bounded and makes frecency a single SQL expression
// (`visit_count / (1 + age_days)`).
export const browserHistory = sqliteTable(
  "browser_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: text("workspace_id").notNull(),
    url: text("url").notNull(),
    title: text("title"),
    faviconUrl: text("favicon_url"),
    lastVisitedAt: integer("last_visited_at").notNull(),
    visitCount: integer("visit_count").notNull().default(1),
  },
  (t) => [
    uniqueIndex("browser_history_workspace_url_uq").on(t.workspaceId, t.url),
    index("browser_history_workspace_visited_idx").on(t.workspaceId, t.lastVisitedAt),
  ],
);
