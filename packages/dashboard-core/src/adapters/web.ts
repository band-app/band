import type { DashboardAdapter, PlatformCapabilities, Unsubscribe } from "../adapter";
import { subscribeSSE } from "../lib/sse";
import type {
  CIStatus,
  CliStatus,
  FileContentResult,
  FileListResult,
  GitStatus,
  HooksStatus,
  ProjectInfo,
  Settings,
  WorkspaceDiff,
  WorkspaceStatus,
} from "../types";

export class WebDashboardAdapter implements DashboardAdapter {
  async listProjects(): Promise<ProjectInfo[]> {
    const res = await fetch("/api/projects");
    if (!res.ok) throw new Error("Failed to fetch projects");
    const data = (await res.json()) as { projects: ProjectInfo[] };
    return data.projects;
  }

  async addProject(path: string, label?: string): Promise<void> {
    const res = await fetch("/api/projects/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, label }),
    });
    if (!res.ok) throw new Error("Failed to add project");
  }

  async removeProject(name: string): Promise<void> {
    const res = await fetch("/api/projects/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error("Failed to remove project");
  }

  async reorderProjects(names: string[]): Promise<void> {
    const res = await fetch("/api/projects/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names }),
    });
    if (!res.ok) throw new Error("Failed to reorder projects");
  }

  async updateProjectLabel(name: string, label: string | null): Promise<void> {
    const res = await fetch("/api/projects/label", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, label }),
    });
    if (!res.ok) throw new Error("Failed to update label");
  }

  async createWorkspace(
    project: string,
    branch: string,
    base?: string,
    prompt?: string,
  ): Promise<void> {
    const res = await fetch("/api/workspaces/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, branch, base, prompt }),
    });
    if (!res.ok) throw new Error("Failed to create workspace");
  }

  async removeWorkspace(project: string, branch: string): Promise<void> {
    const res = await fetch("/api/workspaces/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, branch }),
    });
    if (!res.ok) throw new Error("Failed to remove workspace");
  }

  async openWorkspace(_workspaceId: string): Promise<void> {
    // No-op: window management is handled by the desktop app
  }

  async runScript(path: string, scriptType: string): Promise<void> {
    const res = await fetch("/api/workspaces/run-script", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, scriptType }),
    });
    if (!res.ok) throw new Error("Failed to run script");
  }

  async getSettings(): Promise<Settings> {
    const res = await fetch("/api/settings");
    if (!res.ok) throw new Error("Failed to fetch settings");
    return (await res.json()) as Settings;
  }

  async updateSettings(settings: Settings): Promise<void> {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    if (!res.ok) throw new Error("Failed to update settings");
  }

  subscribeAgentStatus(
    onUpdate: (status: WorkspaceStatus) => void,
    onRemove: (workspaceId: string) => void,
  ): Unsubscribe {
    return subscribeSSE((data) => {
      if (data.kind === "snapshot" && data.statuses) {
        for (const status of data.statuses) {
          onUpdate(status);
        }
      } else if (data.kind === "update" && data.status) {
        onUpdate(data.status);
      } else if (data.kind === "remove" && data.workspaceId) {
        onRemove(data.workspaceId);
      }
    });
  }

  subscribeActiveWorkspace(_onChange: (workspaceId: string | null) => void): Unsubscribe {
    // Web app doesn't have active workspace tracking
    return () => {};
  }

  subscribeBranchStatus(
    onGit: (workspaceId: string, git: GitStatus) => void,
    onCI: (workspaceId: string, ci: CIStatus) => void,
  ): Unsubscribe {
    return subscribeSSE((data) => {
      if (data.kind === "branch-status" && data.workspaceId) {
        if (data.git) onGit(data.workspaceId, data.git);
        if (data.ci) onCI(data.workspaceId, data.ci);
      }
    });
  }

  async checkHooks(): Promise<HooksStatus> {
    const res = await fetch("/api/hooks/check");
    if (!res.ok) throw new Error("Failed to check hooks");
    return (await res.json()) as HooksStatus;
  }

  async installHooks(): Promise<void> {
    const res = await fetch("/api/hooks/install", { method: "POST" });
    if (!res.ok) throw new Error("Failed to install hooks");
  }

  async checkCli(): Promise<CliStatus> {
    const res = await fetch("/api/cli/check");
    if (!res.ok) throw new Error("Failed to check CLI");
    const data = (await res.json()) as { status: CliStatus };
    return data.status;
  }

  async installCli(): Promise<void> {
    const res = await fetch("/api/cli/install", { method: "POST" });
    if (!res.ok) throw new Error("Failed to install CLI");
  }

  async getWorkspaceDiff(workspaceId: string): Promise<WorkspaceDiff> {
    const res = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/diff`);
    if (!res.ok) throw new Error("Failed to fetch diff");
    return (await res.json()) as WorkspaceDiff;
  }

  async listWorkspaceFiles(workspaceId: string, path: string): Promise<FileListResult> {
    const res = await fetch(
      `/api/workspace/${encodeURIComponent(workspaceId)}/files?path=${encodeURIComponent(path)}`,
    );
    if (!res.ok) throw new Error("Failed to list files");
    return (await res.json()) as FileListResult;
  }

  async getWorkspaceFile(workspaceId: string, path: string): Promise<FileContentResult> {
    const res = await fetch(
      `/api/workspace/${encodeURIComponent(workspaceId)}/file?path=${encodeURIComponent(path)}`,
    );
    if (!res.ok) throw new Error("Failed to read file");
    return (await res.json()) as FileContentResult;
  }
}

export class WebCapabilities implements PlatformCapabilities {
  copyPath = false;

  getWorkspaceHref(workspaceId: string): string {
    return `/chat/${encodeURIComponent(workspaceId)}`;
  }
}
