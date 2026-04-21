// Types

// Adapter
export type { DashboardAdapter, PlatformCapabilities, Unsubscribe } from "./adapter";
// Components
export { AddProjectDialog } from "./components/AddProjectDialog";
export { AgentStatusIndicator } from "./components/AgentStatusIndicator";
export { AgentIcon, ClaudeIcon, CodexIcon } from "./components/agent-icons";
export { CIStatusIndicator } from "./components/CIStatusIndicator";
export { CodeMirrorEditor } from "./components/CodeMirrorEditor";
export { CodeMirrorViewer } from "./components/CodeMirrorViewer";
export { DashboardShell } from "./components/DashboardShell";
export { type DiffStats, DiffView } from "./components/DiffView";
export { FileBrowser } from "./components/FileBrowser";
export { FileViewer } from "./components/FileViewer";
export { GitStatusIndicator } from "./components/GitStatusIndicator";
export { ImagePreview } from "./components/ImagePreview";
export { NewWorkspaceDialog } from "./components/NewWorkspaceForm";
export { PdfPreview } from "./components/PdfPreview";
export { ProjectList } from "./components/ProjectList";
export { QuickOpenDialog } from "./components/QuickOpenDialog";
export { SearchBar, type SearchBarHandle, type SearchOptions } from "./components/SearchBar";
export { SearchFilesDialog } from "./components/SearchFilesDialog";
export { SettingsPage } from "./components/SettingsPage";
export { SetupStatusIndicator } from "./components/SetupStatusIndicator";
export { WorkspaceCard } from "./components/WorkspaceCard";
export { type WorkspaceTab, WorkspaceTabNav } from "./components/WorkspaceTabNav";
// Context
export { DashboardProvider, useAdapter, useCapabilities } from "./context";
export {
  type EditorHistoryEntry,
  type UseEditorHistoryReturn,
  useEditorHistory,
} from "./hooks/use-editor-history";
export { type HooksSetupState, useHooksSetup } from "./hooks/use-hooks-setup";
export { useIsDark } from "./hooks/use-is-dark";
export {
  useAddProject,
  useCreateWorkspace,
  useRemoveProject,
  useRemoveWorkspace,
  useReorderProjects,
  useUpdateProjectLabel,
} from "./hooks/use-project-mutations";
export { useProjects } from "./hooks/use-projects";
export { type UseSearchReturn, useSearch } from "./hooks/use-search";
export { useUpdateSettings } from "./hooks/use-settings-mutations";
export { useSettingsQuery } from "./hooks/use-settings-query";
// Hooks
export {
  useActiveWorkspaceWatcher,
  useBranchStatusWatcher,
  useSetupStatusWatcher,
  useStatusWatcher,
} from "./hooks/use-status";
export {
  buildLspWsUrl,
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
  scrollToLine,
  scrollToSearchMatch,
} from "./lib/codemirror-setup";
export { getFileIcon } from "./lib/file-icon";
export { type FileLocation, formatFileLocation, parseFileLocation } from "./lib/file-location";
export { type FilePreviewType, getFilePreviewType } from "./lib/file-type";
export { extensionToLanguage, filenameToLanguage } from "./lib/language-map";
export type { SelectionToChatDetail } from "./lib/selection-to-chat";
export { isServiceHealthy, type ServiceHealth } from "./lib/service-health";
// Lib
export { playSound, SOUNDS, type SoundId } from "./lib/sounds";
export type { SSEEvent } from "./lib/sse";
export { toWorkspaceId } from "./lib/workspace-id";
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
  AppMode,
  BandConfig,
  CIState,
  CIStatus,
  CodingAgentConfig,
  CodingAgentDefinition,
  CodingAgentType,
  ContentSearchMatch,
  DiffMode,
  FileContentResult,
  FileDiffResult,
  FileEntry,
  FileListResult,
  FileStatus,
  GitStatus,
  GitSyncState,
  HooksStatus,
  LabelDefinition,
  NotificationSettings,
  ProjectInfo,
  Settings,
  SetupState,
  SetupStatus,
  WorkspaceBranchStatus,
  WorkspaceDiff,
  WorkspaceDiffSummary,
  WorkspaceStatus,
  WorktreeInfo,
} from "./types";
