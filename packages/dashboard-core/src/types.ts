export type AgentStatusType = "working" | "needs_attention" | "waiting";

export interface AgentInfo {
  name: string;
  status: AgentStatusType;
  lastActivity: string;
  codingAgentId?: string;
}

export interface WorkspaceStatus {
  workspaceId: string;
  project: string;
  branch: string;
  worktreePath: string;
  agent?: AgentInfo;
}

/**
 * "git" projects use git worktrees for per-workspace isolation and have
 * branch/PR/CI features enabled. "plain" projects have a single implicit
 * workspace whose path equals the project path — no isolation, no branch,
 * git-specific UI hidden. Plain projects can be promoted to "git" via
 * `projects.promoteToGit`.
 */
export type ProjectKind = "git" | "plain";

export interface ProjectInfo {
  name: string;
  path: string;
  defaultBranch: string;
  worktrees: WorktreeInfo[];
  label?: string;
  /** Defaults to "git" for backward compatibility with older adapters. */
  kind?: ProjectKind;
}

export interface WorktreeInfo {
  branch: string;
  path: string;
  head?: string;
  hasSetup?: boolean;
  hasTeardown?: boolean;
  /** True when the user has pinned this workspace to the top of the tree.
   *  The DB column is `NOT NULL DEFAULT false`, so the value is always
   *  defined when the worktree comes through `projects.list`. */
  pinned: boolean;
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

export interface CIStatus {
  state: CIState;
  url?: string;
}

export interface WorkspaceBranchStatus {
  git: GitStatus;
  ci: CIStatus;
}

export type SetupState = "running" | "completed" | "failed";

export interface SetupStatus {
  state: SetupState;
  error?: string;
}

// ---------------------------------------------------------------------------
// Workspace terminal configuration (recursive split-tree layout)
// ---------------------------------------------------------------------------

export interface TerminalPaneConfig {
  name?: string;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  focus?: boolean;
}

export type TerminalLayoutNode =
  | { pane: TerminalPaneConfig }
  | {
      direction: "horizontal" | "vertical";
      split?: number;
      children: [TerminalLayoutNode, TerminalLayoutNode];
    };

export interface WorkspaceTerminalConfig {
  layout: TerminalLayoutNode;
}

// ---------------------------------------------------------------------------
// Format-file result returned by `adapter.formatWorkspaceFile`
// ---------------------------------------------------------------------------
//
// Mirrors the discriminated-union shape returned by the `workspace.formatFile`
// tRPC procedure. The procedure is pure: the client passes in editor content
// and gets back the formatted string. Disk persistence is the caller's
// responsibility (typically via the existing save flow).
//
// `skipped: true` means Prettier has no parser for the file (or it's covered
// by `.prettierignore`) — editors fire format-on-shortcut regardless of file
// type, so unsupported files are a soft no-op rather than an error.
// `skipped: false` reports the parser used, the formatted content, and a
// `changed` flag so the caller can decide whether to bother updating its
// editor buffer.

export type FormatFileResult =
  | {
      skipped: true;
      file: string;
      reason: string;
      durationMs: number;
    }
  | {
      skipped: false;
      file: string;
      parser: string;
      formatted: string;
      changed: boolean;
      durationMs: number;
    };

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
   * Maximum number of workspace dockview instances kept alive in memory at
   * once for instant switching. Higher values use more memory but make
   * switching back to recent workspaces faster.
   * @default 3
   */
  maxCachedWorkspaces?: number;
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
   * Experimental: forward Claude Code's partial-message stream events
   * (SDK's `includePartialMessages`) so the chat bubble types in
   * token-by-token instead of in per-block bursts. Off by default.
   * See `docs/experiments/partial-messages.md`.
   */
  claudeCodePartialMessages?: boolean;
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
  projectName: string;
  branch: string;
  isUnmerged: boolean;
  isDirty: boolean;
  hasUnpushedCommits: boolean;
}

export type FileStatus = "A" | "M" | "D" | "R" | "U";

export type DiffMode = "uncommitted" | "branch";

export interface WorkspaceDiff {
  diff: string;
  stats: { filesChanged: number; insertions: number; deletions: number };
  /** Branch the diff was computed against — user's pick, or defaults to `defaultBranch`. */
  compareBranch: string;
  /** The project's default branch (e.g. `main`). Always present, regardless of `compareBranch`. */
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

export interface WorkspaceDiffSummary {
  stats: { filesChanged: number; insertions: number; deletions: number };
  /** Branch the diff was computed against — user's pick, or defaults to `defaultBranch`. */
  compareBranch: string;
  /** The project's default branch (e.g. `main`). Always present, regardless of `compareBranch`. */
  defaultBranch: string;
  headBranch: string;
  fileStatuses: Record<string, FileStatus>;
  mergeBase: string;
}

export interface FileDiffResult {
  diff: string;
}

export interface ContentSearchMatch {
  file: string;
  line: number;
  content: string;
}
