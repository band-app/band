// Types

// Adapter
export type { DashboardAdapter, PlatformCapabilities, Unsubscribe } from "./adapter";
// Components
export { AddProjectDialog } from "./components/AddProjectDialog";
export { AgentStatusBadge } from "./components/AgentStatusBadge";
export { CIStatusIndicator } from "./components/CIStatusIndicator";
export { DashboardShell } from "./components/DashboardShell";
export { DiffView } from "./components/DiffView";
export { FileBrowser } from "./components/FileBrowser";
export { FileViewer } from "./components/FileViewer";
export { GitStatusIndicator } from "./components/GitStatusIndicator";
export { NewWorkspaceDialog } from "./components/NewWorkspaceForm";
export { ProjectList } from "./components/ProjectList";
export { SettingsPage } from "./components/SettingsPage";
export { WorkspaceCard } from "./components/WorkspaceCard";
export { type WorkspaceTab, WorkspaceTabNav } from "./components/WorkspaceTabNav";
// Context
export { DashboardProvider, useAdapter, useCapabilities } from "./context";
export { type HooksSetupState, useHooksSetup } from "./hooks/use-hooks-setup";
export {
  useAddProject,
  useCreateWorkspace,
  useRemoveProject,
  useRemoveWorkspace,
  useReorderProjects,
  useUpdateProjectLabel,
} from "./hooks/use-project-mutations";
export { useProjects } from "./hooks/use-projects";
export { useUpdateSettings } from "./hooks/use-settings-mutations";
export { useSettingsQuery } from "./hooks/use-settings-query";
// Hooks
export {
  useActiveWorkspaceWatcher,
  useBranchStatusWatcher,
  useStatusWatcher,
} from "./hooks/use-status";
export { extensionToLanguage, filenameToLanguage } from "./lib/language-map";
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
  BandConfig,
  CIState,
  CIStatus,
  CodingAgentConfig,
  CodingAgentType,
  FileContentResult,
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
  WorkspaceBranchStatus,
  WorkspaceDiff,
  WorkspaceStatus,
  WorktreeInfo,
} from "./types";
