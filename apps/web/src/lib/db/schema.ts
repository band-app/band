import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
