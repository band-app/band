export type CronjobScope = "project" | "workspace";

export interface CronjobDefinition {
  /** Unique identifier, e.g. "cj_1710000000000" */
  id: string;
  /** Human-readable name for the job */
  name: string;
  /** The prompt sent to the coding agent */
  prompt: string;
  /** Standard cron expression (5-field format) */
  cronExpression: string;
  /** Whether this runs on the project's main branch or a specific workspace */
  scope: CronjobScope;
  /** For workspace-scoped jobs, the workspace ID (project-branch) */
  workspaceId?: string;
  /** Whether the job is enabled */
  enabled: boolean;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last execution (if any) */
  lastRunAt?: string;
  /** Status of the last execution */
  lastRunStatus?: "completed" | "failed" | "skipped";
}

export interface CronjobFile {
  jobs: CronjobDefinition[];
}
