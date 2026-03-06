// Types
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

// Adapter
export type { DashboardAdapter, PlatformCapabilities, Unsubscribe } from "./adapter";

// Context
export { DashboardProvider, useAdapter, useCapabilities } from "./context";

// Stores
export { useDashboardStore, useSettingsStore, useRawDashboardStore, useRawSettingsStore } from "./stores/index";
export type { DashboardState, DashboardStore } from "./stores/dashboard-store";
export { createDashboardStore } from "./stores/dashboard-store";
export type { SettingsState, SettingsStore } from "./stores/settings-store";
export { createSettingsStore } from "./stores/settings-store";

// Hooks
export { useStatusWatcher, useActiveWorkspaceWatcher, useBranchStatusWatcher } from "./hooks/use-status";
export { useHooksSetup, type HooksSetupState } from "./hooks/use-hooks-setup";

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

// Lib
export { playSound, SOUNDS, type SoundId } from "./lib/sounds";
