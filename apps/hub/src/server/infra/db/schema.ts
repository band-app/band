import type { PullRequestSummary } from "@band-app/host-local/git/git-client";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// A machine Band can run workspaces on. The `local` row is seeded by the
// migration and is the only one until remote hosts are registered. `host_id`
// columns elsewhere default to it, so existing rows need no backfill.
export const hosts = sqliteTable(
  "hosts",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    mode: text("mode", { enum: ["attached", "ephemeral"] })
      .notNull()
      .default("attached"),
    runner: text("runner"),
    labels: text("labels", { mode: "json" }).$type<string[]>().notNull().default([]),
    status: text("status", { enum: ["online", "offline", "lost", "disposed"] })
      .notNull()
      .default("online"),
    lastSeenAt: integer("last_seen_at"),
    info: text("info", { mode: "json" }).$type<Record<string, unknown>>(),
    version: text("version"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("hosts_created_at_idx").on(t.createdAt)],
);

const hostId = () => text("host_id").notNull().default("local");

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
  hostId: hostId(),
  updatedAt: integer("updated_at").notNull(),
});

// One row per agent reporting into a workspace: `chat:<chatId>` for a chat
// pane's ACP turns, `hook:<sessionId>` for a hook-reporting CLI session,
// `manual` for `statuses.update`. `workspace_statuses.agent_status` is
// derived from these rows (needs_attention > working > waiting).
// `terminal_id` is set when the hook came from a Band terminal, so closing
// that terminal drops the row.
export const workspaceStatusSources = sqliteTable(
  "workspace_status_sources",
  {
    workspaceId: text("workspace_id").notNull(),
    sourceId: text("source_id").notNull(),
    status: text("status").notNull(),
    terminalId: text("terminal_id"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.sourceId] }),
    index("workspace_status_sources_terminal_idx").on(t.terminalId),
  ],
);

export const branchStatuses = sqliteTable("branch_statuses", {
  workspaceId: text("workspace_id").primaryKey(),
  gitDirty: integer("git_dirty", { mode: "boolean" }).notNull(),
  gitConflict: integer("git_conflict", { mode: "boolean" }).notNull(),
  gitAhead: integer("git_ahead").notNull(),
  gitBehind: integer("git_behind").notNull(),
  gitSyncState: text("git_sync_state").notNull(),
  ciState: text("ci_state").notNull(),
  ciUrl: text("ci_url"),
  /** The branch's pull request, as JSON; null when it has none. */
  ciPr: text("ci_pr", { mode: "json" }).$type<PullRequestSummary>(),
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

// A project's checkout path on each host. `projects.path` stays the source
// that readers use and `ProjectQueries.saveAll` mirrors it here as the `local`
// row, so Phase 2 can add a row per remote host without a schema change.
export const projectHosts = sqliteTable(
  "project_hosts",
  {
    projectName: text("project_name")
      .notNull()
      .references(() => projects.name, { onDelete: "cascade" }),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectName, t.hostId] })],
);

export const worktrees = sqliteTable("worktrees", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectName: text("project_name")
    .notNull()
    .references(() => projects.name, { onDelete: "cascade" }),
  // Immutable workspace identity, set once at creation to the (slugified)
  // branch name. The workspace id is derived from this (`toWorkspaceId`),
  // NOT from `branch` — so switching the git branch inside the worktree
  // doesn't change the id (and everything keyed by it) or the projects-list
  // label. Sync updates `branch` to track git; it never touches `name`.
  // Backfilled to `branch` for pre-existing rows by the migration.
  name: text("name").notNull(),
  // Live git branch checked out in the worktree. Reconciled against git by
  // `syncWorktrees` and used as the target of git operations. Distinct from
  // `name` above once the branch is switched.
  branch: text("branch").notNull(),
  path: text("path").notNull(),
  head: text("head"),
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  hostId: hostId(),
});

// Worktrees on a remote host whose workspace was removed while the host was
// offline. The workspace is gone from the hub at once; the worker deletes the
// checkout the next time it connects (`WorkspaceService.finishPendingRemovals`).
export const pendingRemovals = sqliteTable(
  "pending_removals",
  {
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    worktreePath: text("worktree_path").notNull(),
    // The project's checkout on that host, which git runs the removal from.
    repoPath: text("repo_path").notNull(),
    // The branch to delete after the worktree, or null when there is none to delete.
    branch: text("branch"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.hostId, t.worktreePath] })],
);

// A workspace waiting for a host (plan step 3.3). `workspaces.create` with
// `placement` records one when no online host fits. A runner leases it
// (`leased_by`, `lease_expires_at`), starts a machine and fulfils it with the
// host id; the hub then finishes creating the workspace (`completed_at`). An
// expired lease makes the request leasable again. `input` is the create call
// to replay on the host.
export const hostRequests = sqliteTable(
  "host_requests",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    project: text("project").notNull(),
    branch: text("branch").notNull(),
    labels: text("labels", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
    requires: text("requires", { mode: "json" })
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    environment: text("environment", { mode: "json" }).$type<Record<string, unknown>>(),
    input: text("input", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text("status", { enum: ["pending", "leased", "fulfilled", "failed", "cancelled"] })
      .notNull()
      .default("pending"),
    leasedBy: text("leased_by"),
    leaseExpiresAt: integer("lease_expires_at"),
    hostId: text("host_id"),
    error: text("error"),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("host_requests_status_idx").on(t.status, t.createdAt),
    index("host_requests_workspace_idx").on(t.workspaceId),
  ],
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
  mode: text("mode"),
  model: text("model"),
  codingAgentId: text("coding_agent_id"),
  chatId: text("chat_id"),
});

// Chat event log (issue #648). One row per event on an agent session: the
// ACP `session/update` notifications the agent sends, the prompts Band
// sends, permission / elicitation requests and their answers, and turn
// boundaries. `id` is the gap-fill cursor the browser holds (the SSE
// `Last-Event-ID`); it only grows, across sessions and revisions.
//
// `revision` changes when Band rebuilds a session's log from an agent's
// `session/load` replay. Readers serve only the highest revision, and a
// client holding an older one gets a full reset instead of a gap-fill.
//
// `message_id` / `tool_call_id` are copied out of the payload so readers can
// merge consecutive text chunks of one message and find a tool call's rows
// without parsing JSON. `turn_start` marks the first row of a turn (a
// prompt, or a replayed user message) for turn-based paging.
export const chatEvents = sqliteTable(
  "chat_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: text("chat_id").notNull(),
    sessionId: text("session_id").notNull(),
    revision: integer("revision").notNull(),
    kind: text("kind").notNull(),
    // The `sessionUpdate` discriminator for `kind = 'update'` rows.
    updateKind: text("update_kind"),
    messageId: text("message_id"),
    toolCallId: text("tool_call_id"),
    turnStart: integer("turn_start", { mode: "boolean" }).notNull().default(false),
    payload: text("payload").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("chat_events_session_idx").on(t.sessionId, t.revision, t.id),
    // `latest()` lookups by event kind / update kind (session state on
    // every cold subscribe).
    index("chat_events_kind_idx").on(t.sessionId, t.revision, t.kind, t.id),
    index("chat_events_update_kind_idx").on(t.sessionId, t.revision, t.updateKind, t.id),
    // Turn-based paging (`readTurns`) finds the last N turn starts.
    index("chat_events_turn_start_idx").on(t.sessionId, t.revision, t.turnStart, t.id),
    index("chat_events_chat_idx").on(t.chatId),
  ],
);

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
  // Where a fire dispatches the prompt (issue #581): "chat" submits a task to
  // the workspace's cron chat pane (default, backward-compatible); "terminal"
  // spawns the agent's vendor CLI in a fresh self-closing PTY pane. Mirrors the
  // `via` discriminator on `workspaces.create` (#551).
  via: text("via", { enum: ["chat", "terminal"] })
    .notNull()
    .default("chat"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  lastRunAt: text("last_run_at"),
  lastRunStatus: text("last_run_status", { enum: ["completed", "failed", "skipped"] }),
  // For via="terminal" jobs, the id of the terminal spawned by the most recent
  // fire. Used as the overlap-check handle: if this PTY is still alive when the
  // next tick fires, the run is skipped rather than launching a second agent.
  lastTerminalId: text("last_terminal_id"),
  hostId: hostId(),
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
    hostId: hostId(),
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
    hostId: hostId(),
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

// Band browser profiles. Each profile is a separate Electron session
// partition in the desktop app (`persist:band-browser-profile-<id>`), so
// cookies and storage never leak between profiles. The built-in "Default"
// profile (the pre-existing `persist:band-browser` partition) has no row.
//
// Only metadata lives here. Cookie data stays in the desktop's partition
// and is never sent to the server.
export const browserProfiles = sqliteTable("browser_profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // Where the profile's cookies came from, e.g. "chrome". Null for an
  // empty profile.
  source: text("source"),
  createdAt: integer("created_at").notNull(),
});

// The browser profile each project opens new browser tabs with. Keyed by
// project name with no FK, because `ProjectQueries.saveAll` rewrites the
// `projects` table wholesale and a cascade would wipe this mapping. The
// projects router removes the row when a project is removed.
export const projectBrowserProfiles = sqliteTable("project_browser_profiles", {
  projectName: text("project_name").primaryKey(),
  profileId: text("profile_id").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Agent sessions (issue #682). One row per run of a coding agent, whichever
// way it is displayed: `gui` runs in a chat pane (`chat_id`), `tui` runs its
// vendor CLI in a terminal (`terminal_id`). `provider_session_id` is the
// agent's own session id (Claude's `session_id`, a chat's
// `activeSessionId`), null until the agent reports it. A session never
// changes mode; converting one ends it and starts a new row.
export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    agentDefinitionId: text("agent_definition_id").notNull(),
    providerSessionId: text("provider_session_id"),
    mode: text("mode", { enum: ["gui", "tui"] }).notNull(),
    chatId: text("chat_id"),
    terminalId: text("terminal_id"),
    state: text("state", { enum: ["starting", "running", "ended"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("agent_sessions_workspace_idx").on(t.workspaceId),
    index("agent_sessions_chat_idx").on(t.chatId),
    index("agent_sessions_terminal_idx").on(t.terminalId),
  ],
);

// Client state: small UI state the dashboard keeps on the server so every
// device shows the same thing (open center tabs, panel widths, drafts, …).
// `scope` is `all` for one value on every device, or `desktop` / `mobile` for
// a value per device type. `value` is JSON, NULL once the key is deleted: the
// row stays as a tombstone so its version keeps counting and a stale client
// can't recreate the key. `workspace_id` is null for a global key; the
// workspace delete path removes a workspace's rows.
export const clientState = sqliteTable(
  "client_state",
  {
    key: text("key").notNull(),
    scope: text("scope", { enum: ["all", "desktop", "mobile"] }).notNull(),
    workspaceId: text("workspace_id"),
    value: text("value"),
    version: integer("version").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.key, t.scope] }),
    index("client_state_workspace_idx").on(t.workspaceId),
  ],
);

// Subscriptions (plan step S.1): a chat asks to be woken when events for a
// key arrive (`github:pr:owner/repo#123`). `kinds` is a JSON array of event
// kinds, empty meaning every kind. `wakeups` counts delivered messages;
// the row is deleted at `max_wakeups` or `expires_at`. Rows go away with
// their chat or workspace.
export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    source: text("source").notNull(),
    kinds: text("kinds").notNull(),
    filterKey: text("filter_key").notNull(),
    coalesceSeconds: integer("coalesce_seconds").notNull(),
    maxWakeups: integer("max_wakeups").notNull(),
    wakeups: integer("wakeups").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdBy: text("created_by", { enum: ["agent", "coordinator", "user"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    // Source settings as JSON: a webhook's `secretHash`, a timer's `at` or `cron`.
    config: text("config").notNull().default("{}"),
  },
  (t) => [
    index("subscriptions_chat_idx").on(t.chatId),
    index("subscriptions_workspace_idx").on(t.workspaceId),
  ],
);

// One row per event routed to a subscription: the primary key is the event
// id, so a repeated delivery of the same event is ignored. `delivered_at`
// stays null until the coalesced message went out.
export const subscriptionEvents = sqliteTable(
  "subscription_events",
  {
    eventId: text("event_id").primaryKey(),
    subscriptionId: text("subscription_id").notNull(),
    receivedAt: integer("received_at").notNull(),
    deliveredAt: integer("delivered_at"),
    summary: text("summary").notNull(),
    // Why a guard kept the event from being delivered (`self`, `sender`); null otherwise.
    droppedReason: text("dropped_reason"),
  },
  (t) => [index("subscription_events_subscription_idx").on(t.subscriptionId)],
);

// Where the GitHub polling fallback stopped reading a subscribed PR: the
// newest comment or review timestamp it saw (ISO 8601). Rows go away with
// their subscription.
export const subscriptionCursors = sqliteTable("subscription_cursors", {
  subscriptionId: text("subscription_id").primaryKey(),
  cursor: text("cursor").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Head commits Band pushed from its workspaces. Subscriptions use them to
// tell their own agent's work from a human's.
export const pushedShas = sqliteTable("pushed_shas", {
  sha: text("sha").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  pushedAt: integer("pushed_at").notNull(),
});

// Revocable credentials, stored as a SHA-256 hash (hex) of the token, never
// the token. `device` tokens are for UIs and the CLI. A `worker_bootstrap`
// token is shown once, valid once, and exchanged for a `worker_session`
// token. For the two worker kinds `host_id` is the worker's id, which is also
// its `hosts` row. The shared `settings.tokenSecret` is the row with id
// `shared`, kept in step with settings at boot.
export const tokens = sqliteTable(
  "tokens",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["device", "worker_bootstrap", "worker_session"] }).notNull(),
    hash: text("hash").notNull(),
    hostId: text("host_id").references(() => hosts.id, { onDelete: "cascade" }),
    label: text("label").notNull().default(""),
    // Only an admin device token may call `tokens.*`. The shared token is one.
    admin: integer("admin", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at"),
    lastUsedAt: integer("last_used_at"),
    revokedAt: integer("revoked_at"),
  },
  (t) => [
    uniqueIndex("tokens_hash_idx").on(t.hash),
    index("tokens_host_idx").on(t.hostId),
    index("tokens_created_at_idx").on(t.createdAt),
  ],
);
