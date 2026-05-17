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
  protected trpc: any = createTRPCClient({
    links: [
      splitLink({
        condition: (op) => op.type === "subscription",
        true: wsLink({ client: wsClient }),
        // Cap batched GETs to stay under Node/proxy header limits — issue #430.
        false: httpBatchLink({ url: "/trpc", maxURLLength: 2000 }),
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

  async setWorkspacePinned(project: string, branch: string, pinned: boolean): Promise<void> {
    await this.trpc.workspaces.setPinned.mutate({ project, branch, pinned });
  }

  async clearNeedsAttention(workspaceId: string): Promise<void> {
    await this.trpc.statuses.clearNeedsAttention.mutate({ workspaceId });
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

  async listModels(
    agentId?: string,
  ): Promise<{ id: string; name: string; description?: string; contextWindow?: number }[]> {
    const data = await this.trpc.models.list.query({ agentId });
    return data.models as {
      id: string;
      name: string;
      description?: string;
      contextWindow?: number;
    }[];
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

  subscribeFileChanges(workspaceId: string, handler: (path: string) => void): Unsubscribe {
    // The server tears the underlying watcher down (and the subscription
    // completes) when its `fs.watch` hits an unrecoverable error — e.g.
    // the worktree directory was deleted. We reconnect with exponential
    // backoff so the FileBrowser silently re-acquires auto-refresh when
    // the workspace comes back, but doesn't busy-loop if the workspace
    // is permanently gone (server returns immediately each time). The
    // `active` flag stops reconnects after the caller unsubscribes; in
    // the steady state the FileBrowser unmounts when the workspace is
    // removed, so the loop terminates naturally.
    let active = true;
    let currentSub: { unsubscribe: () => void } | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const MAX_BACKOFF_MS = 30_000;

    // Some tRPC transports can fire onStopped after onError (or vice
    // versa) for the same disconnect; the `!reconnectTimer` guard makes
    // the second call a no-op so we don't schedule the reconnect twice.
    const handleDisconnect = () => {
      currentSub = null;
      if (active && !reconnectTimer) {
        // 500, 1000, 2000, 4000 … capped at 30 s.
        const delay = Math.min(2 ** attempt * 500, MAX_BACKOFF_MS);
        attempt += 1;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (active) connect();
        }, delay);
      }
    };

    const connect = () => {
      currentSub = this.trpc.workspace.fileChanges.subscribe(
        { workspaceId },
        {
          onData: (data: { path: string }) => {
            // A successful data delivery proves the watcher is healthy;
            // reset the backoff so the next disconnection restarts the
            // climb from the floor.
            attempt = 0;
            handler(data.path);
          },
          onStopped: handleDisconnect,
          onError: handleDisconnect,
        },
      );
    };

    connect();

    return () => {
      active = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      currentSub?.unsubscribe();
      currentSub = null;
    };
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

  async installCli(opts?: { allowPrompt?: boolean }): Promise<void> {
    await this.trpc.cli.install.mutate(opts);
  }

  async getWorkspaceDiff(
    workspaceId: string,
    contextLines?: number,
    diffMode?: DiffMode,
    compareBranch?: string,
  ): Promise<WorkspaceDiff> {
    return (await this.trpc.workspace.getDiff.query({
      workspaceId,
      contextLines,
      diffMode,
      compareBranch,
    })) as WorkspaceDiff;
  }

  async getWorkspaceDiffSummary(
    workspaceId: string,
    diffMode?: DiffMode,
    compareBranch?: string,
  ): Promise<WorkspaceDiffSummary> {
    return (await this.trpc.workspace.getDiffSummary.query({
      workspaceId,
      diffMode,
      compareBranch,
    })) as WorkspaceDiffSummary;
  }

  async listWorkspaceBranches(
    workspaceId: string,
  ): Promise<{ branches: string[]; defaultBranch: string; headBranch: string }> {
    return (await this.trpc.workspace.listBranches.query({ workspaceId })) as {
      branches: string[];
      defaultBranch: string;
      headBranch: string;
    };
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

  async saveWorkspaceFile(workspaceId: string, path: string, content: string): Promise<void> {
    await this.trpc.workspace.saveFile.mutate({ workspaceId, path, content });
  }

  async createWorkspaceFile(workspaceId: string, path: string, content = ""): Promise<void> {
    await this.trpc.workspace.createFile.mutate({ workspaceId, path, content });
  }

  async createWorkspaceDirectory(workspaceId: string, path: string): Promise<void> {
    await this.trpc.workspace.createDirectory.mutate({ workspaceId, path });
  }

  async deleteWorkspacePath(
    workspaceId: string,
    path: string,
  ): Promise<{ kind: "file" | "directory" }> {
    return (await this.trpc.workspace.deletePath.mutate({ workspaceId, path })) as {
      kind: "file" | "directory";
    };
  }

  async renameWorkspacePath(
    workspaceId: string,
    fromPath: string,
    toPath: string,
  ): Promise<{ kind: "file" | "directory" }> {
    return (await this.trpc.workspace.renamePath.mutate({
      workspaceId,
      fromPath,
      toPath,
    })) as { kind: "file" | "directory" };
  }

  async copyWorkspacePath(
    workspaceId: string,
    fromPath: string,
    toPath: string,
  ): Promise<{ kind: "file" | "directory" }> {
    return (await this.trpc.workspace.copyPath.mutate({
      workspaceId,
      fromPath,
      toPath,
    })) as { kind: "file" | "directory" };
  }

  async revertFile(
    workspaceId: string,
    filePath: string,
    diffMode: DiffMode,
    compareBranch?: string,
  ): Promise<void> {
    await this.trpc.workspace.revertFile.mutate({
      workspaceId,
      filePath,
      diffMode,
      compareBranch,
    });
  }

  async gitPullWorkspace(workspaceId: string): Promise<void> {
    await this.trpc.workspace.gitPull.mutate({ workspaceId });
  }

  async gitPushWorkspace(workspaceId: string): Promise<void> {
    await this.trpc.workspace.gitPush.mutate({ workspaceId });
  }

  async gitCommitWorkspace(workspaceId: string, message: string, body?: string): Promise<void> {
    await this.trpc.workspace.gitCommit.mutate({ workspaceId, message, body });
  }

  async generateCommitMessage(
    workspaceId: string,
  ): Promise<{ message: string; body: string; agentLabel: string }> {
    return (await this.trpc.workspace.generateCommitMessage.mutate({ workspaceId })) as {
      message: string;
      body: string;
      agentLabel: string;
    };
  }

  getWorkspaceFileUrl(workspaceId: string, path: string): string {
    return `/api/workspace-file/${encodeURIComponent(workspaceId)}/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
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
    options?: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean; limit?: number },
  ): Promise<{ results: ContentSearchMatch[] }> {
    return (await this.trpc.workspace.searchContent.query({
      workspaceId,
      query,
      caseSensitive: options?.caseSensitive,
      wholeWord: options?.wholeWord,
      regex: options?.regex,
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
      if (stored !== null) {
        // Empty string means the Chat tab (workspace index route);
        // non-empty values must match a known sub-path prefix.
        if (stored === "" || VALID_TAB_PREFIXES.some((p) => stored.startsWith(p))) {
          return `${base}${stored}`;
        }
      }
    } catch {}
    return base;
  }

  async openUrl(url: string): Promise<void> {
    window.open(url, "_blank");
  }
}
