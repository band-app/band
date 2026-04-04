import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaceStatuses = sqliteTable("workspace_statuses", {
  workspaceId: text("workspace_id").primaryKey(),
  project: text("project").notNull(),
  branch: text("branch").notNull(),
  worktreePath: text("worktree_path").notNull(),
  ide: text("ide").notNull(),
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
});

export const worktrees = sqliteTable("worktrees", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectName: text("project_name")
    .notNull()
    .references(() => projects.name, { onDelete: "cascade" }),
  branch: text("branch").notNull(),
  path: text("path").notNull(),
  head: text("head"),
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
