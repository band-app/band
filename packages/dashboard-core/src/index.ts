// Types

// Adapter
export type { DashboardAdapter, PlatformCapabilities, Unsubscribe } from "./adapter";
// Components
export { AddProjectDialog } from "./components/AddProjectDialog";
export { AgentStatusBadge } from "./components/AgentStatusBadge";
export { CIStatusIndicator } from "./components/CIStatusIndicator";
export { DashboardShell } from "./components/DashboardShell";
export { GitStatusIndicator } from "./components/GitStatusIndicator";
export { NewWorkspaceDialog } from "./components/NewWorkspaceForm";
export { ProjectList } from "./components/ProjectList";
export { SettingsPage } from "./components/SettingsPage";
export { WorkspaceCard } from "./components/WorkspaceCard";
// Context
export { DashboardProvider, useAdapter, useCapabilities } from "./context";
export { type HooksSetupState, useHooksSetup } from "./hooks/use-hooks-setup";
// Hooks
export {
  useActiveWorkspaceWatcher,
  useBranchStatusWatcher,
  useStatusWatcher,
} from "./hooks/use-status";
// Lib
export { playSound, SOUNDS, type SoundId } from "./lib/sounds";
export type { DashboardState, DashboardStore } from "./stores/dashboard-store";
export { createDashboardStore } from "./stores/dashboard-store";
// Stores
export {
  useDashboardStore,
  useRawDashboardStore,
  useRawSettingsStore,
  useSettingsStore,
} from "./stores/index";
export type { SettingsState, SettingsStore } from "./stores/settings-store";
export { createSettingsStore } from "./stores/settings-store";
export type {
  AgentInfo,
  AgentStatusType,
  BandConfig,
  CIState,
  CIStatus,
  CodingAgentConfig,
  CodingAgentType,
  GitStatus,
  GitSyncState,
  HooksStatus,
  LabelDefinition,
  NotificationSettings,
  ProjectInfo,
  Settings,
  WorkspaceBranchStatus,
  WorkspaceStatus,
  WorktreeInfo,
} from "./types";
