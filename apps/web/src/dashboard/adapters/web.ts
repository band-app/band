import type { AgentMode } from "@band-app/shared/agent-sessions";
import type { GitOpResult } from "@band-app/shared/git-op-result";
import { createTRPCClient, createWSClient, httpBatchLink, splitLink, wsLink } from "@trpc/client";
import { HubWebSocket, hubAssetUrl, hubFetch, hubUrl, hubWsUrl } from "../../lib/hub-config";
import type { DashboardAdapter, PlatformCapabilities, Unsubscribe } from "../adapter";
import type { SSEEvent } from "../lib/sse";
import type {
  BrowserProfileInfo,
  CIStatus,
  CliStatus,
  ContentSearchMatch,
  DiffMode,
  FileContentResult,
  FileListResult,
  FormatFileResult,
  GitStatus,
  HooksStatus,
  ListWorktreeBranchesResult,
  RepoInfo,
  Settings,
  WorktreeDiff,
  WorktreeStatus,
} from "../types";

const wsClient = createWSClient({
  url: () => {
    return hubWsUrl("/trpc");
  },
  WebSocket: HubWebSocket,
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
        false: httpBatchLink({
          url: hubUrl("/trpc"),
          maxURLLength: 2000,
          fetch: (url, init) => hubFetch(String(url), init),
        }),
      }),
    ],
  });

  async listRepos(): Promise<RepoInfo[]> {
    const data = await this.trpc.repos.list.query();
    // Normalise `kind` at the adapter boundary so downstream consumers
    // can treat it as required. Newer servers always set it, but the
    // dashboard may briefly run against an older server during a rolling
    // upgrade — default to "git" in that case (matches the migration's
    // DEFAULT 'git' for pre-existing rows).
    return (data.repos as RepoInfo[]).map((p) => ({
      ...p,
      kind: p.kind ?? "git",
    }));
  }

  async removeRepo(name: string): Promise<void> {
    await this.trpc.repos.remove.mutate({ name });
  }

  async reorderRepos(names: string[]): Promise<void> {
    await this.trpc.repos.reorder.mutate({ names });
  }

  async updateRepoLabel(name: string, label: string | null): Promise<void> {
    await this.trpc.repos.updateLabel.mutate({ name, label });
  }

  async gitInit(path: string): Promise<void> {
    await this.trpc.repos.gitInit.mutate({ path });
  }

  async promoteRepoToGit(name: string): Promise<void> {
    await this.trpc.repos.promoteToGit.mutate({ name });
  }

  async createWorktree(
    repo: string,
    branch: string,
    base?: string,
    prompt?: string,
    agentMode?: AgentMode,
    host?: { hostId: string; hostRepoPath?: string },
  ): Promise<{ hostId?: string }> {
    const res = await this.trpc.worktrees.create.mutate({
      repo,
      branch,
      base,
      prompt,
      agentMode,
      hostId: host?.hostId,
      hostRepoPath: host?.hostRepoPath,
    });
    return { hostId: res.hostId };
  }

  async removeWorktree(repo: string, name: string, hostId?: string): Promise<void> {
    await this.trpc.worktrees.remove.mutate({ repo, name, hostId });
  }

  async setWorktreePinned(
    repo: string,
    name: string,
    pinned: boolean,
    hostId?: string,
  ): Promise<void> {
    await this.trpc.worktrees.setPinned.mutate({ repo, name, pinned, hostId });
  }

  async clearNeedsAttention(worktreeId: string): Promise<void> {
    await this.trpc.statuses.clearNeedsAttention.mutate({ worktreeId });
  }

  async refreshBranchStatus(worktreeId: string): Promise<void> {
    await this.trpc.statuses.refreshBranchStatus.mutate({ worktreeId });
  }

  async runScript(path: string, scriptType: string): Promise<void> {
    await this.trpc.worktrees.runScript.mutate({ path, scriptType });
  }

  gitPull(repo: string, name: string, hostId?: string): Promise<GitOpResult> {
    return this.trpc.worktrees.gitPull.mutate({ repo, name, hostId });
  }

  gitPush(repo: string, name: string, hostId?: string): Promise<GitOpResult> {
    return this.trpc.worktrees.gitPush.mutate({ repo, name, hostId });
  }

  async listBrowserProfiles(): Promise<BrowserProfileInfo[]> {
    const data = await this.trpc.browserProfiles.list.query();
    return data.profiles as BrowserProfileInfo[];
  }

  async removeBrowserProfile(profileId: string): Promise<void> {
    await this.trpc.browserProfiles.remove.mutate({ profileId });
  }

  async listRepoBrowserProfiles(): Promise<Record<string, string>> {
    const data = await this.trpc.browserProfiles.repoDefaults.query();
    const byRepo: Record<string, string> = {};
    for (const row of data.defaults as { repoName: string; profileId: string }[]) {
      byRepo[row.repoName] = row.profileId;
    }
    return byRepo;
  }

  async setRepoBrowserProfile(repoName: string, profileId: string | null): Promise<void> {
    await this.trpc.browserProfiles.setRepoDefault.mutate({ repoName, profileId });
  }

  async getSettings(): Promise<Settings> {
    return (await this.trpc.settings.get.query()) as Settings;
  }

  async updateSettings(settings: Settings): Promise<void> {
    await this.trpc.settings.update.mutate(settings as unknown as Record<string, unknown>);
  }

  async listModels(agentId?: string): Promise<{
    models: { id: string; name: string; description?: string; contextWindow?: number }[];
    defaultModel?: string;
    updatedAt?: number;
  }> {
    const data = await this.trpc.models.list.query({ agentId });
    return data as {
      models: { id: string; name: string; description?: string; contextWindow?: number }[];
      defaultModel?: string;
      updatedAt?: number;
    };
  }

  async listAllModels(): Promise<{
    agents: {
      agentId: string;
      agentType: string;
      agentLabel: string;
      models: { id: string; name: string; description?: string; contextWindow?: number }[];
      updatedAt?: number;
      defaultModel?: string;
    }[];
    defaultAgentId: string;
  }> {
    const data = await this.trpc.models.listAll.query();
    return data as {
      agents: {
        agentId: string;
        agentType: string;
        agentLabel: string;
        models: { id: string; name: string; description?: string; contextWindow?: number }[];
        updatedAt?: number;
        defaultModel?: string;
      }[];
      defaultAgentId: string;
    };
  }

  async refreshModels(
    agentId?: string,
    hostId?: string,
  ): Promise<{
    results: {
      agentId: string;
      models: { id: string; name: string; description?: string; contextWindow?: number }[];
      updatedAt: number;
      error?: string;
    }[];
  }> {
    const data = await this.trpc.models.refresh.mutate({ agentId, hostId });
    return data as {
      results: {
        agentId: string;
        models: { id: string; name: string; description?: string; contextWindow?: number }[];
        updatedAt: number;
        error?: string;
      }[];
    };
  }

  private statusHandlers = new Set<(data: SSEEvent) => void>();
  private statusSubscription: { unsubscribe: () => void } | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The newest `branch-status` event per worktree. The server sends each
   * status once (in the on-connect snapshot, then only when it changes), and
   * the stream is shared: a handler added after the snapshot arrived gets
   * these replayed instead.
   */
  private latestBranchStatuses = new Map<string, SSEEvent>();

  private createStatusSubscription() {
    // The on-connect snapshot refills it. A worktree removed while the
    // stream was down sent no `remove` event, so its entry would stay.
    this.latestBranchStatuses.clear();
    this.statusSubscription = this.trpc.status.stream.subscribe(undefined, {
      onData: (data: SSEEvent) => {
        if (data.kind === "branch-status" && data.worktreeId) {
          this.latestBranchStatuses.set(data.worktreeId, data);
        } else if (data.kind === "remove" && data.worktreeId) {
          this.latestBranchStatuses.delete(data.worktreeId);
        }
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
        this.latestBranchStatuses.clear();
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

  /**
   * Cache so we only post to the server when the value actually changes —
   * the React tree can re-render and call this on routes that don't
   * change the worktree, and we don't want to spam the mutation.
   */
  private lastActiveWorktreeId: string | null | undefined = undefined;

  async setActiveWorktree(worktreeId: string | null): Promise<void> {
    if (this.lastActiveWorktreeId === worktreeId) return;
    this.lastActiveWorktreeId = worktreeId;
    try {
      await this.trpc.editor.setActiveWorktree.mutate({ worktreeId });
    } catch {
      // Best-effort: the active-worktree hint is a UX nicety, not a
      // correctness invariant. Reset the cache so the next change attempt
      // re-posts (rather than silently agreeing with a stale value the
      // server never received).
      this.lastActiveWorktreeId = undefined;
    }
  }

  subscribeAgentStatus(
    onSnapshot: (statuses: WorktreeStatus[]) => void,
    onUpdate: (status: WorktreeStatus) => void,
    onRemove: (worktreeId: string) => void,
  ): Unsubscribe {
    return this.subscribeStatusStream((data) => {
      if (data.kind === "snapshot" && data.statuses) {
        onSnapshot(data.statuses);
      } else if (data.kind === "update" && data.status) {
        onUpdate(data.status);
      } else if (data.kind === "remove" && data.worktreeId) {
        onRemove(data.worktreeId);
      }
    });
  }

  subscribeBranchStatus(
    onGit: (worktreeId: string, git: GitStatus) => void,
    onCI: (worktreeId: string, ci: CIStatus) => void,
  ): Unsubscribe {
    const handle = (data: SSEEvent) => {
      if (data.kind === "branch-status" && data.worktreeId) {
        if (data.git) onGit(data.worktreeId, data.git);
        if (data.ci) onCI(data.worktreeId, data.ci);
      }
    };
    for (const data of this.latestBranchStatuses.values()) handle(data);
    return this.subscribeStatusStream(handle);
  }

  subscribeFileChanges(worktreeId: string, handler: (path: string) => void): Unsubscribe {
    // The server tears the underlying watcher down (and the subscription
    // completes) when its `fs.watch` hits an unrecoverable error — e.g.
    // the worktree directory was deleted. We reconnect with exponential
    // backoff so the FileBrowser silently re-acquires auto-refresh when
    // the worktree comes back, but doesn't busy-loop if the worktree
    // is permanently gone (server returns immediately each time). The
    // `active` flag stops reconnects after the caller unsubscribes; in
    // the steady state the FileBrowser unmounts when the worktree is
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
      currentSub = this.trpc.worktree.fileChanges.subscribe(
        { worktreeId },
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

  async getWorktreeDiff(
    worktreeId: string,
    contextLines?: number,
    diffMode?: DiffMode,
    compareBranch?: string,
  ): Promise<WorktreeDiff> {
    return (await this.trpc.worktree.getDiff.query({
      worktreeId,
      contextLines,
      diffMode,
      compareBranch,
    })) as WorktreeDiff;
  }

  async listWorktreeBranches(
    worktreeId: string,
    options?: { query?: string; limit?: number },
  ): Promise<ListWorktreeBranchesResult> {
    return await this.trpc.worktree.listBranches.query({ worktreeId, ...options });
  }

  async listWorktreeFiles(worktreeId: string, path: string): Promise<FileListResult> {
    return (await this.trpc.worktree.listFiles.query({ worktreeId, path })) as FileListResult;
  }

  async getWorktreeFile(worktreeId: string, path: string): Promise<FileContentResult> {
    return (await this.trpc.worktree.getFile.query({ worktreeId, path })) as FileContentResult;
  }

  async saveWorktreeFile(worktreeId: string, path: string, content: string): Promise<void> {
    await this.trpc.worktree.saveFile.mutate({ worktreeId, path, content });
  }

  async readExternalFile(absolutePath: string): Promise<FileContentResult> {
    // tRPC infers a discriminated union (`{ tooLarge } | { binary } | { content }`)
    // for the procedure's return. `FileContentResult` widens those into a single
    // shape with all variants as optional fields — same pattern `getWorktreeFile`
    // uses (and the downstream `FileViewer` consumer already keys off the flags
    // before reading `.content`).
    return (await this.trpc.host.readFile.query({ absolutePath })) as FileContentResult;
  }

  async resolveWorktreePath(
    worktreeId: string,
    path: string,
  ): Promise<{
    exists: boolean;
    isFile: boolean;
    external: boolean;
    worktreeRelativePath: string | null;
  }> {
    return await this.trpc.worktree.resolvePath.query({ worktreeId, path });
  }

  async saveExternalFile(absolutePath: string, content: string): Promise<void> {
    await this.trpc.host.saveFile.mutate({ absolutePath, content });
  }

  async formatWorktreeFile(
    worktreeId: string,
    filePath: string,
    content: string,
  ): Promise<FormatFileResult> {
    return await this.trpc.worktree.formatFile.mutate({
      worktreeId,
      filePath,
      content,
    });
  }

  async createWorktreeFile(worktreeId: string, path: string, content = ""): Promise<void> {
    await this.trpc.worktree.createFile.mutate({ worktreeId, path, content });
  }

  async createWorktreeDirectory(worktreeId: string, path: string): Promise<void> {
    await this.trpc.worktree.createDirectory.mutate({ worktreeId, path });
  }

  async deleteWorktreePath(
    worktreeId: string,
    path: string,
  ): Promise<{ kind: "file" | "directory" }> {
    return (await this.trpc.worktree.deletePath.mutate({ worktreeId, path })) as {
      kind: "file" | "directory";
    };
  }

  async renameWorktreePath(
    worktreeId: string,
    fromPath: string,
    toPath: string,
  ): Promise<{ kind: "file" | "directory" }> {
    return (await this.trpc.worktree.renamePath.mutate({
      worktreeId,
      fromPath,
      toPath,
    })) as { kind: "file" | "directory" };
  }

  async copyWorktreePath(
    worktreeId: string,
    fromPath: string,
    toPath: string,
  ): Promise<{ kind: "file" | "directory" }> {
    return (await this.trpc.worktree.copyPath.mutate({
      worktreeId,
      fromPath,
      toPath,
    })) as { kind: "file" | "directory" };
  }

  getWorktreeFileUrl(worktreeId: string, path: string): string {
    return hubAssetUrl(
      `/api/worktree-file/${encodeURIComponent(worktreeId)}/${path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
    );
  }

  async searchWorktreeFiles(
    worktreeId: string,
    query: string,
    limit?: number,
  ): Promise<{ files: string[] }> {
    return (await this.trpc.worktree.searchFiles.query({
      worktreeId,
      query,
      limit,
    })) as { files: string[] };
  }

  async searchWorktreeContent(
    worktreeId: string,
    query: string,
    options?: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean; limit?: number },
  ): Promise<{ results: ContentSearchMatch[] }> {
    return (await this.trpc.worktree.searchContent.query({
      worktreeId,
      query,
      caseSensitive: options?.caseSensitive,
      wholeWord: options?.wholeWord,
      regex: options?.regex,
      limit: options?.limit,
    })) as { results: ContentSearchMatch[] };
  }
}

export class WebCapabilities implements PlatformCapabilities {
  copyPath = false;
  navigate?: (href: string) => void;

  // The worktree URL no longer carries a sub-path for the active tab —
  // tab state lives entirely inside `MobileWorktreeLayout`, and the
  // desktop dockview at AppShell renders every panel regardless of URL.
  // See issue #467 for the refactor that removed the `band-tab:` session
  // store and the `/changes` / `/code` / `/terminal` child routes.
  getWorktreeHref(worktreeId: string): string {
    return `/worktree/${encodeURIComponent(worktreeId)}`;
  }

  async openUrl(url: string): Promise<void> {
    window.open(url, "_blank");
  }
}
