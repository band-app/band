import { create } from "zustand";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error("Not running inside Tauri");
  }
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

export type AgentStatusType =
  | "idle"
  | "working"
  | "needs_input"
  | "error"
  | "done";

export interface AgentInfo {
  name: string;
  status: AgentStatusType;
  lastActivity: string;
  summary?: string;
}

export interface WorkspaceStatus {
  workspaceId: string;
  project: string;
  branch: string;
  worktreePath: string;
  ide: string;
  pid?: number;
  agent?: AgentInfo;
}

export interface ProjectInfo {
  name: string;
  path: string;
  defaultBranch: string;
  worktrees: WorktreeInfo[];
}

export interface WorktreeInfo {
  branch: string;
  path: string;
  head?: string;
}

interface DashboardState {
  projects: ProjectInfo[];
  statuses: Map<string, WorkspaceStatus>;
  loading: boolean;
  error: string | null;

  loadProjects: () => Promise<void>;
  addProject: (path: string) => Promise<void>;
  removeProject: (name: string) => Promise<void>;
  createWorkspace: (
    project: string,
    branch: string,
    base?: string
  ) => Promise<void>;
  removeWorkspace: (project: string, branch: string) => Promise<void>;
  openWorkspace: (workspaceId: string) => Promise<void>;
  updateStatus: (status: WorkspaceStatus) => void;
  removeStatus: (workspaceId: string) => void;
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  projects: [],
  statuses: new Map(),
  loading: false,
  error: null,

  loadProjects: async () => {
    set({ loading: true, error: null });
    try {
      const projects = await invoke<ProjectInfo[]>("project_list");
      set({ projects, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  addProject: async (path: string) => {
    try {
      await invoke("project_init", { path });
      await get().loadProjects();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  removeProject: async (name: string) => {
    try {
      await invoke("project_remove", { name });
      await get().loadProjects();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  createWorkspace: async (project: string, branch: string, base?: string) => {
    try {
      await invoke("workspace_create", { project, branch, base });
      await get().loadProjects();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  removeWorkspace: async (project: string, branch: string) => {
    try {
      await invoke("workspace_remove", { project, branch });
      await get().loadProjects();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  openWorkspace: async (workspaceId: string) => {
    try {
      await invoke("workspace_open", { workspaceId });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  updateStatus: (status: WorkspaceStatus) => {
    set((state) => {
      const statuses = new Map(state.statuses);
      statuses.set(status.workspaceId, status);
      return { statuses };
    });
  },

  removeStatus: (workspaceId: string) => {
    set((state) => {
      const statuses = new Map(state.statuses);
      statuses.delete(workspaceId);
      return { statuses };
    });
  },
}));
