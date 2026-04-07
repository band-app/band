import { createTRPCClient, createWSClient, httpBatchLink, splitLink, wsLink } from "@trpc/client";
import type { DashboardAdapter, PlatformCapabilities, Unsubscribe } from "../adapter";
import type { SSEEvent } from "../lib/sse";
import type {
  CIStatus,
  CliStatus,
  ContentSearchMatch,
  DiffMode,
  FileContentResult,
  FileDiffResult,
  FileListResult,
  GitStatus,
  HooksStatus,
  ProjectInfo,
  Settings,
  WorkspaceDiff,
  WorkspaceDiffSummary,
  WorkspaceStatus,
} from "../types";

const wsClient = createWSClient({
  url: () => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/trpc`;
  },
});

export class WebDashboardAdapter implements DashboardAdapter {
  // The AppRouter type lives in apps/web which cannot be imported here
  // (circular dep). Type safety comes from the DashboardAdapter interface.
  // biome-ignore lint/suspicious/noExplicitAny: tRPC client without router type
  private trpc: any = createTRPCClient({
    links: [
      splitLink({
        condition: (op) => op.type === "subscription",
        true: wsLink({ client: wsClient }),
        false: httpBatchLink({ url: "/trpc" }),
      }),
    ],
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

  async checkPath(path: string): Promise<{ isGitRepo: boolean }> {
    return await this.trpc.projects.checkPath.query({ path });
  }

  async gitInit(path: string): Promise<void> {
    await this.trpc.projects.gitInit.mutate({ path });
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

  async clearNeedsAttention(workspaceId: string): Promise<void> {
    await this.trpc.statuses.clearNeedsAttention.mutate({ workspaceId });
  }

  async closeWorkspaceWindows(_workspaceId: string): Promise<void> {
    // No-op: window management is handled by the desktop app
  }

  async runScript(path: string, scriptType: string): Promise<void> {
    await this.trpc.workspaces.runScript.mutate({ path, scriptType });
  }

  async gitPull(project: string, branch: string): Promise<void> {
    await this.trpc.workspaces.gitPull.mutate({ project, branch });
  }

  async gitPush(project: string, branch: string): Promise<void> {
    await this.trpc.workspaces.gitPush.mutate({ project, branch });
  }

  async getSettings(): Promise<Settings> {
    return (await this.trpc.settings.get.query()) as Settings;
  }

  async updateSettings(settings: Settings): Promise<void> {
    await this.trpc.settings.update.mutate(settings as unknown as Record<string, unknown>);
  }

  private statusHandlers = new Set<(data: SSEEvent) => void>();
  private statusSubscription: { unsubscribe: () => void } | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private createStatusSubscription() {
    this.statusSubscription = this.trpc.status.stream.subscribe(undefined, {
      onData: (data: SSEEvent) => {
        for (const h of this.statusHandlers) {
          h(data);
        }
      },
      onError: () => {
        this.statusSubscription = null;
        this.scheduleReconnect();
      },
      onComplete: () => {
        this.statusSubscription = null;
        this.scheduleReconnect();
      },
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    if (this.statusHandlers.size === 0) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.statusHandlers.size > 0 && !this.statusSubscription) {
        this.createStatusSubscription();
      }
    }, 2000);
  }

  private subscribeStatusStream(handler: (data: SSEEvent) => void): Unsubscribe {
    this.statusHandlers.add(handler);

    if (!this.statusSubscription) {
      this.createStatusSubscription();
    }

    return () => {
      this.statusHandlers.delete(handler);
      if (this.statusHandlers.size === 0) {
        if (this.statusSubscription) {
          this.statusSubscription.unsubscribe();
          this.statusSubscription = null;
        }
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      }
    };
  }

  subscribeStatusEvents(handler: (event: Record<string, unknown>) => void): Unsubscribe {
    return this.subscribeStatusStream(handler);
  }

  subscribeAgentStatus(
    onSnapshot: (statuses: WorkspaceStatus[]) => void,
    onUpdate: (status: WorkspaceStatus) => void,
    onRemove: (workspaceId: string) => void,
  ): Unsubscribe {
    return this.subscribeStatusStream((data) => {
      if (data.kind === "snapshot" && data.statuses) {
        onSnapshot(data.statuses);
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
    return this.subscribeStatusStream((data) => {
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

  async getWorkspaceDiff(workspaceId: string, contextLines?: number, diffMode?: DiffMode): Promise<WorkspaceDiff> {
    return (await this.trpc.workspace.getDiff.query({
      workspaceId,
      contextLines,
      diffMode,
    })) as WorkspaceDiff;
  }

  async getWorkspaceDiffSummary(workspaceId: string, diffMode?: DiffMode): Promise<WorkspaceDiffSummary> {
    return (await this.trpc.workspace.getDiffSummary.query({
      workspaceId,
      diffMode,
    })) as WorkspaceDiffSummary;
  }

  async getFileDiff(
    workspaceId: string,
    filePath: string,
    mergeBase: string,
    contextLines?: number,
  ): Promise<FileDiffResult> {
    return (await this.trpc.workspace.getFileDiff.query({
      workspaceId,
      filePath,
      mergeBase,
      contextLines,
    })) as FileDiffResult;
  }

  async listWorkspaceFiles(workspaceId: string, path: string): Promise<FileListResult> {
    return (await this.trpc.workspace.listFiles.query({ workspaceId, path })) as FileListResult;
  }

  async getWorkspaceFile(workspaceId: string, path: string): Promise<FileContentResult> {
    return (await this.trpc.workspace.getFile.query({ workspaceId, path })) as FileContentResult;
  }

  async searchWorkspaceFiles(
    workspaceId: string,
    query: string,
    limit?: number,
  ): Promise<{ files: string[] }> {
    return (await this.trpc.workspace.searchFiles.query({
      workspaceId,
      query,
      limit,
    })) as { files: string[] };
  }

  async searchWorkspaceContent(
    workspaceId: string,
    query: string,
    options?: { caseSensitive?: boolean; limit?: number },
  ): Promise<{ results: ContentSearchMatch[] }> {
    return (await this.trpc.workspace.searchContent.query({
      workspaceId,
      query,
      caseSensitive: options?.caseSensitive,
      limit: options?.limit,
    })) as { results: ContentSearchMatch[] };
  }
}

// Valid sub-path prefixes for restoring the last workspace location
const VALID_TAB_PREFIXES = ["/changes", "/code", "/terminal"];

export class WebCapabilities implements PlatformCapabilities {
  copyPath = false;
  navigate?: (href: string) => void;

  getWorkspaceHref(workspaceId: string): string {
    const base = `/workspace/${encodeURIComponent(workspaceId)}`;
    try {
      const stored = sessionStorage.getItem(`band-tab:${workspaceId}`);
      if (stored && VALID_TAB_PREFIXES.some((p) => stored.startsWith(p))) {
        return `${base}${stored}`;
      }
    } catch {}
    return base;
  }

  async openUrl(url: string): Promise<void> {
    window.open(url, "_blank");
  }
}
