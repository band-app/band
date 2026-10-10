// Types

export {
  type FileLocation,
  formatFileLocation,
  parseFileLocation,
} from "@band-app/shared/file-location";
export { toWorktreeId } from "@band-app/shared/worktree-id";
// Adapter
export type { DashboardAdapter, PlatformCapabilities, Unsubscribe } from "./adapter";
// Components
export { AgentStatusIndicator } from "./components/AgentStatusIndicator";
export { AgentIcon, ClaudeIcon, CodexIcon } from "./components/agent-icons";
export { ChangesFileTree, type ChangesTreeAction } from "./components/ChangesFileTree";
export { CIStatusIndicator } from "./components/CIStatusIndicator";
export { CodeMirrorEditor } from "./components/CodeMirrorEditor";
export { CodeMirrorViewer } from "./components/CodeMirrorViewer";
export { CommandPaletteDialog } from "./components/CommandPaletteDialog";
export { DashboardShell } from "./components/DashboardShell";
export {
  DiffFileContent,
  getStoredViewMode,
  storeViewMode,
  type ViewMode,
} from "./components/DiffFileContent";
export { DiffOverviewRuler } from "./components/DiffOverviewRuler";
export { FileBrowser, type FileBrowserHandle } from "./components/FileBrowser";
export { FileViewer } from "./components/FileViewer";
export { GitStatusIndicator } from "./components/GitStatusIndicator";
export { ImagePreview } from "./components/ImagePreview";
export {
  AUTO_DETECT_LANGUAGE_ID,
  LanguagePickerDialog,
} from "./components/LanguagePickerDialog";
export { NewWorktreeDialog } from "./components/NewWorktreeForm";
export { PdfPreview } from "./components/PdfPreview";
export { QuickOpenDialog } from "./components/QuickOpenDialog";
export { RepoAvatar } from "./components/RepoAvatar";
export { RepoList } from "./components/RepoList";
export {
  SearchBar,
  type SearchBarHandle,
  type SearchOptionKey,
  type SearchOptions,
} from "./components/SearchBar";
export { SearchFilesDialog } from "./components/SearchFilesDialog";
export { TerminalSelectionContextMenu } from "./components/SelectionContextMenu";
export { SettingsPage } from "./components/SettingsPage";
export { SetupStatusIndicator } from "./components/SetupStatusIndicator";
export { SettingsRow, SettingsSection } from "./components/settings";
export { WorktreeCard } from "./components/WorktreeCard";
export { WorktreeLabel } from "./components/WorktreeLabel";
export { WorktreePickerDialog } from "./components/WorktreePickerDialog";
export { type WorktreeTab, WorktreeTabNav } from "./components/WorktreeTabNav";
// Context
export { DashboardProvider, useAdapter, useCapabilities } from "./context";
export {
  useBrowserProfiles,
  useInvalidateBrowserProfiles,
  useRemoveBrowserProfile,
  useRepoBrowserProfiles,
  useSetRepoBrowserProfile,
} from "./hooks/use-browser-profiles";
export { type UseDiffTargetReturn, useDiffTarget } from "./hooks/use-diff-target";
export {
  type EditorHistoryEntry,
  type UseEditorHistoryReturn,
  useEditorHistory,
} from "./hooks/use-editor-history";
export { type HooksSetupState, useHooksSetup } from "./hooks/use-hooks-setup";
export { useIsDark } from "./hooks/use-is-dark";
export { LABEL_FILTER_KEY, useLabelFilter } from "./hooks/use-label-filter";
export {
  LABEL_LAST_WORKTREE_KEY,
  useLabelLastWorktree,
  useRecordLabelLastWorktree,
} from "./hooks/use-label-last-worktree";
export {
  useCreateWorktree,
  useRemoveRepo,
  useRemoveWorktree,
  useReorderRepos,
  useUpdateRepoLabel,
} from "./hooks/use-repo-mutations";
export { useRepos } from "./hooks/use-repos";
export { type UseSearchReturn, useSearch } from "./hooks/use-search";
export { useUpdateSettings } from "./hooks/use-settings-mutations";
export { useSettingsQuery } from "./hooks/use-settings-query";
// Hooks
export {
  useBranchStatusWatcher,
  useSetupStatusWatcher,
  useStatusWatcher,
} from "./hooks/use-status";
export { useWorktreePath } from "./hooks/use-worktree-path";
export { AGENT_MODE_KEY, readAgentMode, useAgentMode } from "./lib/agent-mode";
export {
  buildLspWsUrl,
  createDiffLspNavigation,
  createLspExtension,
  getLspLanguageId,
  hasPendingNavigation,
  LSP_SUPPORTED_LANGUAGES,
  releaseLspClient,
  resolveNavigation,
  toFileUri,
  toLspServerLang,
} from "./lib/codemirror-lsp";
export {
  clearSearch,
  collectSearchMatches,
  cursorLineTracker,
  dispatchSearch,
  restoreScrollPosition,
  scrollToLine,
  scrollToSearchMatch,
  serializeViewPosition,
} from "./lib/codemirror-setup";
export type { CommandRegistryDeps, PaletteCommand } from "./lib/command-registry";
export { buildCommands, formatShortcut, isMacPlatform } from "./lib/command-registry";
export { getFileIcon, getFolderIcon } from "./lib/file-icon";
export { type FilePreviewType, getFilePreviewType } from "./lib/file-type";
export {
  extensionToLanguage,
  filenameToLanguage,
  languageLabel,
  languageToExtension,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from "./lib/language-map";
export type {
  RenderedBlockKind,
  RenderMarkdownBlock,
} from "./lib/markdown-live-preview";
export { getRecentWorktreeOrder, recordWorktreeAccess } from "./lib/recent-worktrees";
export {
  type AddToChatDetail,
  type AddToTerminalDetail,
  buildLineReference,
  type ChatInsertDetail,
  type SelectionToChatDetail,
  type TerminalInsertDetail,
} from "./lib/selection-to-chat";
export { isServiceHealthy, type ServiceHealth } from "./lib/service-health";
// Lib
export { playSound, SOUNDS, type SoundId } from "./lib/sounds";
export type { SSEEvent } from "./lib/sse";
// Query
export { queryClient, queryKeys } from "./query-client";
export type { DashboardState, DashboardStore } from "./stores/dashboard-store";
export { createDashboardStore } from "./stores/dashboard-store";
// Stores
export {
  useDashboardStore,
  useRawDashboardStore,
} from "./stores/index";
export type {
  AgentInfo,
  AgentStatusType,
  BranchCompareStatus,
  BrowserProfileInfo,
  ChangeEntry,
  ChangeSection,
  CIState,
  CIStatus,
  CodingAgentConfig,
  CodingAgentDefinition,
  CodingAgentType,
  ConflictKind,
  ContentSearchMatch,
  DiffMode,
  FileContentResult,
  FileEntry,
  FileListResult,
  FileStatus,
  FormatFileResult,
  GitStatus,
  GitSyncState,
  HooksStatus,
  LabelDefinition,
  ListWorktreeBranchesResult,
  NotificationSettings,
  RepoAvatarInfo,
  RepoInfo,
  RepoKind,
  Settings,
  SetupState,
  SetupStatus,
  TabAgentStatus,
  TerminalLayoutNode,
  TerminalPaneConfig,
  WorktreeBranchStatus,
  WorktreeChanges,
  WorktreeDiff,
  WorktreeInfo,
  WorktreeStatus,
  WorktreeTerminalConfig,
} from "./types";
