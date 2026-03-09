import { createTRPCClient, httpBatchLink } from "@trpc/client";
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
  // The AppRouter type lives in apps/web which cannot be imported here
  // (circular dep). Type safety comes from the DashboardAdapter interface.
  // biome-ignore lint/suspicious/noExplicitAny: tRPC client without router type
  private trpc: any = createTRPCClient({
    links: [httpBatchLink({ url: "/trpc" })],
  });

  async listProjects(): Promise<ProjectInfo[]> {
    const data = await this.trpc.projects.list.query();
    return data.projects;
  }

  async addProject(path: string, label?: string): Promise<void> {
    await this.trpc.projects.add.mutate({ path, label });
  }

  async removeProject(name: string): Promise<void> {
    await this.trpc.projects.remove.mutate({ name });
  }

  async reorderProjects(names: string[]): Promise<void> {
    await this.trpc.projects.reorder.mutate({ names });
  }

  async updateProjectLabel(name: string, label: string | null): Promise<void> {
    await this.trpc.projects.updateLabel.mutate({ name, label });
  }

  async createWorkspace(
    project: string,
    branch: string,
    base?: string,
    prompt?: string,
  ): Promise<void> {
    await this.trpc.workspaces.create.mutate({ project, branch, base, prompt });
  }

  async removeWorkspace(project: string, branch: string): Promise<void> {
    await this.trpc.workspaces.remove.mutate({ project, branch });
  }

  async openWorkspace(_workspaceId: string): Promise<void> {
    // No-op: window management is handled by the desktop app
  }

  async runScript(path: string, scriptType: string): Promise<void> {
    await this.trpc.workspaces.runScript.mutate({ path, scriptType });
  }

  async getSettings(): Promise<Settings> {
    return (await this.trpc.settings.get.query()) as Settings;
  }

  async updateSettings(settings: Settings): Promise<void> {
    await this.trpc.settings.update.mutate(settings as unknown as Record<string, unknown>);
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
    return await this.trpc.hooks.check.query();
  }

  async installHooks(): Promise<void> {
    await this.trpc.hooks.install.mutate();
  }

  async checkCli(): Promise<CliStatus> {
    const data = await this.trpc.cli.check.query();
    return data.status as CliStatus;
  }

  async installCli(): Promise<void> {
    await this.trpc.cli.install.mutate();
  }

  async getWorkspaceDiff(workspaceId: string): Promise<WorkspaceDiff> {
    return (await this.trpc.workspace.getDiff.query({ workspaceId })) as WorkspaceDiff;
  }

  async listWorkspaceFiles(workspaceId: string, path: string): Promise<FileListResult> {
    return (await this.trpc.workspace.listFiles.query({ workspaceId, path })) as FileListResult;
  }

  async getWorkspaceFile(workspaceId: string, path: string): Promise<FileContentResult> {
    return (await this.trpc.workspace.getFile.query({ workspaceId, path })) as FileContentResult;
  }
}

export class WebCapabilities implements PlatformCapabilities {
  copyPath = false;

  getWorkspaceHref(workspaceId: string): string {
    return `/chat/${encodeURIComponent(workspaceId)}`;
  }
}
