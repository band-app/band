import type { AgentMode } from "@band-app/shared/agent-sessions";

export type { FormatFileResult } from "@band-app/shared/format-file-result";
export type {
  TerminalLayoutNode,
  TerminalPaneConfig,
  WorktreeTerminalConfig,
} from "@band-app/shared/terminal-config";

export type AgentStatusType = "working" | "needs_attention" | "waiting";

export interface AgentInfo {
  name: string;
  status: AgentStatusType;
  lastActivity: string;
  codingAgentId?: string;
}

/** One chat's or terminal's agent status, shown on its center tab. */
export interface TabAgentStatus {
  chatId?: string;
  terminalId?: string;
  status: "working" | "needs_attention";
}

export interface WorktreeStatus {
  worktreeId: string;
  repo: string;
  branch: string;
  worktreePath: string;
  agent?: AgentInfo;
  /** Chats and terminals whose agent is working or needs attention. */
  tabStatuses?: TabAgentStatus[];
}

/**
 * "git" repos use git worktrees for per-worktree isolation and have
 * branch/PR/CI features enabled. "plain" repos have a single implicit
 * worktree whose path equals the repo path — no isolation, no branch,
 * git-specific UI hidden. Plain repos can be promoted to "git" via
 * `repos.promoteToGit`.
 */
export type RepoKind = "git" | "plain";

export interface RepoInfo {
  name: string;
  path: string;
  defaultBranch: string;
  worktrees: WorktreeInfo[];
  label?: string;
  /**
   * Required: the server always sets it (migration defaults pre-existing
   * rows to "git"), and the web adapter normalises any older API
   * response that might omit it back to "git" at the response boundary.
   * UI consumers can therefore branch on `kind` without `?? "git"` guards.
   */
  kind: RepoKind;
  /**
   * The GitHub owner's avatar when the repo's `origin` is on GitHub,
   * served from Band's cache (`/api/repo-avatar/<name>`). `null` or
   * absent for plain repos, non-GitHub remotes, no remote, and owners
   * GitHub has no avatar for; the UI then shows its folder icon.
   */
  avatar?: RepoAvatarInfo | null;
}

export interface RepoAvatarInfo {
  /** Same-origin image URL. */
  src: string;
  /** `owner/repo`, used as alt text. */
  label: string;
}

export interface WorktreeInfo {
  /**
   * Immutable worktree identity — the branch name captured at creation.
   * The worktree id derives from this (`toWorktreeId`) and it's shown as
   * the worktree label, so both stay stable across git branch switches.
   * Never changes once set; `branch` below tracks the live git branch.
   */
  name: string;
  branch: string;
  path: string;
  head?: string;
  hasSetup?: boolean;
  hasTeardown?: boolean;
  /** True when the user has pinned this worktree to the top of the tree.
   *  The DB column is `NOT NULL DEFAULT false`, so the value is always
   *  defined when the worktree comes through `repos.list`. */
  pinned: boolean;
  /** Set while the worktree's ephemeral worker has exited (`sleeping`) or is being started again (`waking`). */
  lifecycle?: "sleeping" | "waking";
}

export type GitSyncState = "synced" | "ahead" | "behind" | "diverged";

export interface GitStatus {
  dirty: boolean;
  conflict: boolean;
  ahead: number;
  behind: number;
  sync_state: GitSyncState;
}

export type CIState =
  | "none"
  | "pending"
  | "running"
  | "success"
  | "failure"
  | "cancelled"
  | "merged";

/** A worktree branch's pull request, found by the branch-status poller. */
export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  state: "open" | "merged" | "closed";
  isDraft: boolean;
}

export interface CIStatus {
  state: CIState;
  url?: string;
  /** The branch's PR: open, else the latest merged, else the latest closed. */
  pr?: PullRequestSummary | null;
}

export interface WorktreeBranchStatus {
  git: GitStatus;
  ci: CIStatus;
}

export type SetupState = "running" | "completed" | "failed";

export interface SetupStatus {
  state: SetupState;
  /** Which `.band/config.json` command the state is for. */
  script: "setup" | "teardown";
  error?: string;
}

export type CodingAgentType = "claude-code" | "codex" | "gemini-cli" | "cursor-cli" | "opencode";

export interface CodingAgentConfig {
  type: CodingAgentType;
  command?: string;
}

export interface CodingAgentDefinition {
  id: string;
  type: CodingAgentType;
  label: string;
  command?: string;
  model?: string;
  /**
   * Cached models reported by the agent's SDK / binary, persisted in
   * `~/.band/settings.json`. Populated by `ModelRefreshService.refresh()`
   * (boot-time fire-and-forget, plus the Settings UI's "Refresh models"
   * button). Settings + Chat read from this directly so the picker stays
   * populated across server restarts and fresh chats. When absent
   * (fresh install or older settings.json), the server falls back to the
   * adapter's built-in default list.
   */
  cachedModels?: CachedAgentModel[];
  /** Epoch ms when `cachedModels` was last refreshed. */
  cachedModelsUpdatedAt?: number;
}

export interface CachedAgentModel {
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
}

export interface NotificationSettings {
  soundOnNeedsAttention?: boolean;
  sound?: string;
}

export interface LabelDefinition {
  id: string;
  name: string;
  color: string;
}

export type Theme = "system" | "light" | "dark";

export interface Settings {
  worktreesDir: string | null;
  codingAgents?: CodingAgentDefinition[];
  defaultCodingAgent?: string;
  /**
   * Agent preferences (issue #682). `defaultMode` is how agents start when
   * the caller has no device mode of its own (the CLI, cronjobs, MCP).
   * Browsers use their per-device mode (`dashboard/lib/agent-mode.ts`).
   */
  agents?: { defaultMode?: AgentMode };
  webServerPort?: number;
  notifications?: NotificationSettings;
  labels?: LabelDefinition[];
  tokenSecret?: string;
  autoStartTunnel?: boolean;
  enableLSP?: boolean;
  /**
   * When true (default), single-clicking a file in the tree opens it in a
   * shared "preview" tab slot (italic title) that is replaced by the next
   * single-click. Double-click or editing pins the tab. When false, every
   * single-click opens the file as a pinned tab (pre-PR behavior).
   * @default true
   */
  enableFilePreviewTabs?: boolean;
  theme?: Theme;
  /**
   * Let the blurred desktop show through the repo-list sidebar (macOS
   * vibrancy). Only takes effect in the macOS desktop app; the browser build
   * always paints the sidebar solid.
   * @default true
   */
  translucentSidebar?: boolean;
  /**
   * Use the GPU-accelerated WebGL renderer for terminal panels. Enables
   * `customGlyphs` (continuous box-drawing / powerline / block art) and
   * lets the panel use iTerm-style row spacing (`lineHeight: 1.2`). When
   * disabled, falls back to xterm.js's DOM renderer with default spacing.
   * The WebGL renderer requires a working WebGL2 context — on systems
   * where the context fails to initialize, the terminal silently falls
   * back to DOM regardless of this setting.
   * @default true
   */
  useWebGLTerminalRenderer?: boolean;
  /**
   * Web Browser pane CDP screencast (experimental). When enabled, the
   * desktop opens a chromium debug port and exposes its browser tabs
   * to web clients via JPEG screencast; when disabled, the web Browser
   * pane shows a "desktop only" fallback and the desktop doesn't open
   * the debug port (saving the per-tab compositor cost). Treat
   * undefined as the default.
   * @default false
   */
  webBrowserCdpEnabled?: boolean;
  /**
   * Retention window, in days, for the Reports `usage_events` table
   * (issue #425). Bounded by the server-side Zod schema to [1, 3650].
   * When unset, the prune sweep falls back to 365 days.
   * @default 365
   */
  usageRetentionDays?: number;
  /**
   * Whether the Reports usage scanner polls for new data (issue #425).
   * When `false`, the scanner is silent — the Reports dialog still
   * renders whatever's already in `usage_events`, but no new sessions
   * are picked up until the user re-enables polling. Treat `undefined`
   * as the default.
   * @default true
   */
  usagePollingEnabled?: boolean;
}

export interface HooksStatus {
  installed: boolean;
  other_hooks_exist: boolean;
}

export type CliStatus =
  | "Installed"
  | "NotInstalled"
  | "ConflictingBinary"
  | "DirNotFound"
  | "NotWritable";

export interface DeleteDialogInfo {
  repoName: string;
  /** Worktree identity (immutable `name`), used both as the delete target
   *  and as the label shown in the confirmation dialog. */
  name: string;
  isUnmerged: boolean;
  isDirty: boolean;
  hasUnpushedCommits: boolean;
}

/** `A`dded, `M`odified, `D`eleted, `R`enamed, `C`opied, `U`ntracked. */
export type FileStatus = "A" | "M" | "D" | "R" | "C" | "U";

/**
 * A section of the Changes view, as in orca's source control panel:
 * merge conflicts, unstaged and staged changes, untracked files, and the
 * files committed on the branch since it forked from the compare branch.
 */
export type ChangeSection = "conflicts" | "unstaged" | "staged" | "untracked" | "branch";

/** How the two sides of a merge conflict touched the file. */
export type ConflictKind =
  | "both_modified"
  | "both_added"
  | "both_deleted"
  | "added_by_us"
  | "added_by_them"
  | "deleted_by_us"
  | "deleted_by_them";

export interface ChangeEntry {
  path: string;
  /** The path before a rename or copy. */
  oldPath?: string;
  status: FileStatus;
  /** Lines added / deleted; unset for binary files. */
  additions?: number;
  deletions?: number;
  /** Set on `conflicts` entries only. */
  conflict?: ConflictKind;
}

/** Why the `branch` section is empty when it isn't `ready`. */
export type BranchCompareStatus = "ready" | "invalid-base" | "no-merge-base" | "unborn-head";

export interface WorktreeChanges {
  headBranch: string;
  defaultBranch: string;
  /** The branch the `branch` section compares against. */
  compareBranch: string;
  /** Where HEAD forked from `compareBranch`; null unless `branchStatus` is ready. */
  mergeBase: string | null;
  branchStatus: BranchCompareStatus;
  conflicts: ChangeEntry[];
  unstaged: ChangeEntry[];
  staged: ChangeEntry[];
  untracked: ChangeEntry[];
  branch: ChangeEntry[];
}

export type DiffMode = "uncommitted" | "branch";

export interface ListWorktreeBranchesResult {
  /** Matching branch names, local (`feature/x`) and remote (`origin/feature/x`). */
  branches: string[];
  /** The repo's default branch (e.g. `main`). */
  defaultBranch: string;
  /** The worktree's current branch; `defaultBranch` when HEAD is detached or unborn. */
  headBranch: string;
  /** More branches matched than the requested limit. */
  truncated: boolean;
}

export interface WorktreeDiff {
  diff: string;
  stats: { filesChanged: number; insertions: number; deletions: number };
  /** Branch the diff was computed against — user's pick, or defaults to `defaultBranch`. */
  compareBranch: string;
  /** The repo's default branch (e.g. `main`). Always present, regardless of `compareBranch`. */
  defaultBranch: string;
  headBranch: string;
  fileStatuses: Record<string, FileStatus>;
}

export interface FileEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
}

export interface FileListResult {
  entries: FileEntry[];
  path: string;
}

export interface FileContentResult {
  content?: string;
  binary?: boolean;
  tooLarge?: boolean;
  size: number;
  language?: string;
}

export interface ContentSearchMatch {
  file: string;
  line: number;
  content: string;
}

/**
 * A Band browser profile: its own cookie jar for browser-pane tabs. The
 * built-in Default profile has no entry and is `null` wherever a profile id
 * is expected.
 */
export interface BrowserProfileInfo {
  id: string;
  name: string;
  /** Where its cookies came from, e.g. `"chrome"`. `null` for an empty profile. */
  source: string | null;
  createdAt: number;
}
