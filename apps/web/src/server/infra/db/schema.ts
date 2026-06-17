import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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

export const worktrees = sqliteTable(
  "worktrees",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectName: text("project_name")
      .notNull()
      .references(() => projects.name, { onDelete: "cascade" }),
    branch: text("branch").notNull(),
    path: text("path").notNull(),
    head: text("head"),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    // Stable, opaque workspace identity. Minted once at worktree creation
    // (`toWorkspaceId(project, branch)`) and frozen thereafter — switching
    // the git branch inside the worktree must NOT re-key the workspace, or
    // every chat / task / cronjob / panel row bound to this id would orphan.
    // Existing rows are backfilled to the historical derived value by the
    // accompanying migration, so persisted references stay valid. Identity
    // is the worktree PATH; the branch is just a mutable label on top.
    workspaceId: text("workspace_id").notNull().default(""),
  },
  (table) => [uniqueIndex("worktrees_workspace_id_unique").on(table.workspaceId)],
);

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

// Persistent record of token usage and cost from coding-agent sessions
// (issue #425 — Reports page).
//
// One row per `UsageEvent` emitted by an adapter (token streams arrive per
// turn) PLUS one cost-only row per successful `session-result` when the
// adapter reports `costUsd > 0` (Claude Code today; Codex/Gemini/OpenCode
// report 0). The split keeps the SQL simple: `SUM` over each column still
// produces the right total because token-only and cost-only rows have
// zeros in the columns they don't carry.
//
// Pruned by the background sweep in `queries/usage-events.ts` on the same
// 30-day retention window as the tasks table. Indexes match the three
// primary aggregate filters (period range, drill-into-task,
// drill-into-workspace).
export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /**
     * Band's task id when the row came from a Band-driven session
     * (`tsk_*`); empty string for rows backfilled by the disk scanner
     * (issue #425) for sessions Band didn't own.
     */
    taskId: text("task_id").notNull(),
    chatId: text("chat_id"),
    workspaceId: text("workspace_id").notNull(),
    project: text("project").notNull(),
    sessionId: text("session_id"),
    codingAgentId: text("coding_agent_id"),
    // "claude" | "codex" | "gemini" | "opencode" | "cursor"
    provider: text("provider"),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    reasoningOutputTokens: integer("reasoning_output_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    capturedAt: integer("captured_at").notNull(),
    /**
     * Dedup key for the disk scanner — `${provider}:${sessionId}:${turnIndex}`.
     * Combined with the unique index below, lets the scanner re-read a
     * growing session each tick and only write new turns. Nullable so
     * rows captured before the scanner shipped don't all need a backfill.
     */
    externalKey: text("external_key"),
  },
  (t) => [
    index("usage_events_captured_at_idx").on(t.capturedAt),
    index("usage_events_task_idx").on(t.taskId),
    index("usage_events_workspace_idx").on(t.workspaceId),
    uniqueIndex("usage_events_external_key_uq").on(t.externalKey),
  ],
);

/**
 * Per-(workspace, agent) watermark for the Reports usage scanner
 * (issue #425). Tracks the highest `lastModified` timestamp the scanner
 * has already processed so each tick only re-reads sessions touched
 * since the previous run. Workspaces aren't a first-class DB row, so
 * cleanup on workspace removal is explicit (see `workspace-service`).
 */
export const usageScanState = sqliteTable(
  "usage_scan_state",
  {
    workspaceId: text("workspace_id").notNull(),
    agentType: text("agent_type").notNull(),
    lastScannedUpdatedAt: integer("last_scanned_updated_at").notNull(),
  },
  (t) => [uniqueIndex("usage_scan_state_pk").on(t.workspaceId, t.agentType)],
);

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
