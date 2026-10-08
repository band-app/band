/**
 * The coordinator session of a project (plan steps 6.2 and T.1).
 *
 * A project has one long-lived coordinator chat. It is a project-level chat with no
 * worktree: it runs in the project folder on the host the project pins it to (the
 * working copy of the project's context repo, with a checkout of every repo's default
 * branch under `repos/`). The agent reads its instructions from AGENTS.md in the project folder and gets a scoped set of hub tools
 * at `/mcp-proxy/band-coordinator`, authenticated by the session's own `mcp_`
 * token. Nothing in a tool call names the project: the hub takes it from the
 * chat the token was issued for, so a coordinator cannot reach another
 * project's worktrees.
 *
 * The policy of the project decides what a tool may do. `observe` allows reads
 * only. `autonomous` messages and stops the project's worker chats and
 * dispatches within the limits, and a dispatch calls `checkDispatch` here.
 */

import { createLogger } from "@band-app/logger";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { ProjectConflictError } from "../errors";
import { ProjectQueries, type ProjectRow } from "../infra/db/queries/projects";
import { UsageEventQueries } from "../infra/db/queries/usage-events";
import { subscribe as subscribeStatusBus } from "../infra/events/status-event-bus";
import { hostRegistry } from "../infra/host/registry";
import { chatScope, projectScopeId } from "../infra/project-scope";
import { COORDINATOR_LABEL, resolvePolicy } from "./_utils/project-policy";
import { agentSessionService } from "./agent-session-service";
import { chatService } from "./chat-service";
import { projectFolderService, WaitingForWorkerError } from "./project-folder-service";
import { type ProjectView, projectService, type UpdateProjectInput } from "./project-service";
import { projectSubscriptionService } from "./project-subscription-service";
import { abortTask, hasRunningTask, submitOrQueueTask } from "./task-service";
import { terminalService } from "./terminal-service";
import { worktreeService } from "./worktree-service";

const log = createLogger("project-coordinator");

const DEFAULT_COORDINATOR_AGENT = "claude-code";
const MAX_MESSAGE = 20_000;
const MAX_READ_TURNS = 20;
const MAX_TRANSCRIPT_CHARS = 30_000;

/** A tool refusal the agent sees as the text of an error result. */
export class CoordinatorToolError extends Error {}

export interface WorkerChatView {
  chatId: string;
  name: string;
  agent: string;
  model: string | null;
  running: boolean;
}

export interface WorkerView {
  worktreeId: string;
  repo: string;
  branch: string;
  hostId: string;
  chats: WorkerChatView[];
  pr: { number: number; state: string; url: string | null } | null;
  ci: string | null;
}

function worktreeIdOf(w: { repoName: string; name: string }): string {
  return toWorktreeId(w.repoName, w.name);
}

export class ProjectCoordinatorService {
  private readonly usage = new UsageEventQueries();
  /** Why the last start of a project's coordinator failed, for the project page. */
  private readonly startErrors = new Map<string, string>();
  private readonly starting = new Map<string, Promise<void>>();
  private readonly legacy = new ProjectQueries();

  // ---- session start -----------------------------------------------------------------

  /**
   * Creates the coordinator's chat when the project has none, and starts the agent so it
   * starts with it. Needs at least one repo. The agent starts in the background (it
   * prepares the project folder first), so a slow or failing agent never fails the caller.
   * Safe to call again: a running start is shared.
   */
  async ensureCoordinator(ref: string): Promise<ProjectView> {
    const row = projectService.row(ref);
    const view = projectService.get(row.id);
    if (view.repos.length === 0) return view;
    let pending = this.starting.get(row.id);
    if (!pending) {
      pending = this.create(row.id).finally(() => this.starting.delete(row.id));
      this.starting.set(row.id, pending);
    }
    await pending;
    return projectService.get(row.id);
  }

  /**
   * Updates a project and keeps its coordinator in step: the coordinator's model, and a move to
   * the new host when `coordinatorHostId` changed.
   */
  async update(ref: string, patch: UpdateProjectInput): Promise<ProjectView> {
    // The host the folder is on, so "hub default" and the hub's own id count as the same host.
    const row = projectService.row(ref);
    const before = projectFolderService.hostIdOf(row);
    const next = patch.coordinatorHostId?.trim() || null;
    if (before && next && next !== before) await this.assertMovable(row, before);
    const updated = projectService.update(ref, patch);
    this.syncModel(updated.id);
    if (projectFolderService.hostIdOf(projectService.row(updated.id)) !== before) {
      await this.moveHost(updated.id);
    }
    return projectService.get(updated.id);
  }

  /**
   * Refuses a move while a default-branch checkout on the old host has changes or commits that
   * exist nowhere else. A host that cannot be reached (offline, or no checkout there) cannot be
   * checked, so it does not block the move.
   */
  private async assertMovable(row: ProjectRow, hostId: string): Promise<void> {
    const host = hostRegistry.hostById(hostId);
    const blockers: string[] = [];
    for (const { repo } of projectService.get(row.id).repos) {
      try {
        const status = await host.project.status({ project: row.name, repo });
        const reasons: string[] = [];
        if (status.dirty) reasons.push("uncommitted changes");
        if (status.ahead > 0) {
          reasons.push(`${status.ahead} unpushed commit${status.ahead === 1 ? "" : "s"}`);
        }
        if (reasons.length > 0) blockers.push(`${repo} has ${reasons.join(" and ")}`);
      } catch (err) {
        log.info(
          { project: row.name, repo, hostId, err },
          "could not check a checkout before a move",
        );
      }
    }
    if (blockers.length > 0) {
      throw new ProjectConflictError(
        `Cannot move the coordinator off host "${hostId}": ${blockers.join("; ")}. Commit and push or discard them first.`,
      );
    }
  }

  /**
   * Moves the project's folder view to its current coordinator host after `coordinatorHostId`
   * changed. Every chat of the view stops its agent process on the old host and starts a fresh
   * session (the session files are on the old host), and the coordinator starts again on the new
   * host. A terminal already open on the old host keeps running there until it is closed. The
   * folder state is the old host's, so it is dropped.
   */
  async moveHost(ref: string): Promise<void> {
    const row = projectService.row(ref);
    projectFolderService.forget(row.id);
    for (const chat of chatService.listForProject(row.id)) {
      agentSessionService.stop(chat.id);
      if (chat.activeSessionId) chatService.updateActiveSession(chat.id, undefined);
    }
    if (row.coordinatorChatId) await this.ensureCoordinator(row.id);
  }

  lastError(projectId: string): string | null {
    return this.startErrors.get(projectId) ?? null;
  }

  /** Whether the project has no coordinator host yet, because no worker can run the agent. */
  isWaiting(projectId: string): boolean {
    return this.waiting.has(projectId) && !this.projectById(projectId)?.coordinatorHostId;
  }

  private readonly waiting = new Set<string>();
  private stopListening: (() => void) | null = null;

  /**
   * Starts the coordinators that wait for a worker when a worker comes online or reports new
   * capabilities. Called once the server is up.
   */
  start(): void {
    this.stopListening ??= subscribeStatusBus((event) => {
      if (event.kind !== "host-status-changed" || event.hostStatus !== "online") return;
      for (const id of [...this.waiting]) {
        void this.ensureCoordinator(id).catch((err) => {
          log.warn({ projectId: id, err }, "could not start a waiting coordinator");
        });
      }
    });
  }

  private async create(projectId: string): Promise<void> {
    try {
      const row = projectService.row(projectId);
      let chat = row.coordinatorChatId ? chatService.get(row.coordinatorChatId) : undefined;
      if (!chat) {
        chat = chatService.createForProject(row.id, {
          name: "Coordinator",
          agent: row.coordinatorAgent ?? DEFAULT_COORDINATOR_AGENT,
          model: row.coordinatorModel,
          labels: { [COORDINATOR_LABEL]: row.id },
          allowReservedLabels: true,
        });
        projectService.setCoordinator(row.id, chat.id);
      }
      this.startErrors.delete(row.id);
      // A project from before AGENTS.md was a context file gets its default now.
      await projectService.seedInstructions(row.id);
      const chatId = chat.id;
      // Wake-ups for the coordinator: worker chats, member PRs, the context inbox.
      void projectSubscriptionService.reconcile(row.id).catch((err) => {
        log.warn({ projectId: row.id, err }, "could not subscribe the coordinator");
      });
      // Starting the agent prepares the project folder and attaches the session, which carries the tools.
      void agentSessionService
        .ensureSession(chatId, "prompt")
        .then(() => this.waiting.delete(row.id))
        .catch((err) => {
          if (err instanceof WaitingForWorkerError) this.waiting.add(row.id);
          else this.waiting.delete(row.id);
          this.startErrors.set(row.id, err instanceof Error ? err.message : String(err));
          log.warn({ projectId: row.id, chatId, err }, "coordinator agent did not start");
        });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.startErrors.set(projectId, message);
      log.warn({ projectId, err }, "could not create the coordinator");
    }
  }

  /**
   * Removes the chats and terminals of the project's folder view, the coordinator's included.
   * Called before the project is removed. The project folder
   * stays on its host, because the checkouts in it may hold work that is not pushed.
   */
  async teardown(ref: string): Promise<void> {
    const row = projectService.row(ref);
    // The coordinator and every other chat and terminal opened in the project's folder view.
    for (const chat of chatService.listForProject(row.id)) chatService.remove(chat.id);
    // A coordinator chat the index missed (it always lists it) still goes.
    if (row.coordinatorChatId) chatService.remove(row.coordinatorChatId);
    const scope = projectScopeId(row.id);
    // Drops the chat layout saved under the project's scope.
    chatService.removeAllForWorktree(scope);
    await terminalService
      .killWorktree(scope)
      .catch((err) =>
        log.warn({ project: row.name, err }, "could not stop the project's terminals"),
      );
    terminalService.deleteLayout(scope);
    projectService.setCoordinator(row.id, null);
    projectFolderService.forget(row.id);
    this.startErrors.delete(row.id);
  }

  /**
   * Finishes the move of 6.2 coordinators into the project folder. The migration already moved
   * their chats to the project and listed their worktrees in `legacy_coordinator_worktrees`.
   * This removes each worktree and its branch, and starts the chat on a fresh session, because the
   * old session belongs to the worktree's directory. Safe to run on every boot.
   */
  async removeLegacyWorktrees(): Promise<void> {
    for (const legacy of this.legacy.legacyCoordinatorWorktrees()) {
      try {
        const resolved = worktreeService.resolve(legacy.worktreeId);
        if (resolved) {
          const { repo, worktree, host } = resolved;
          await worktreeService.remove({ repo: repo.name, name: worktree.name });
          if (host.id === hostRegistry.local.id)
            await this.deleteLegacyBranch(host, repo, worktree.branch);
        }
        const project = projectService.find(legacy.projectId);
        const chat = project?.coordinatorChatId
          ? chatService.get(project.coordinatorChatId)
          : undefined;
        if (chat?.activeSessionId) chatService.updateActiveSession(chat.id, undefined);
        this.legacy.clearLegacyCoordinatorWorktree(legacy.worktreeId);
      } catch (err) {
        log.warn(
          { worktreeId: legacy.worktreeId, err },
          "could not remove a legacy coordinator worktree",
        );
      }
    }
  }

  /**
   * Deletes the coordinator branch from its repo. The remote branch goes too, but only when it
   * holds no commits of its own: a branch someone pushed work to is theirs to delete.
   */
  private async deleteLegacyBranch(
    host: { git: { exec(args: string[], cwd: string): Promise<{ stdout: string }> } },
    repo: { path: string; defaultBranch: string },
    branch: string,
  ): Promise<void> {
    const git = (args: string[]) => host.git.exec(args, repo.path);
    // Only the legacy coordinator branch is ours to delete, never the default branch.
    if (!branch.startsWith("coordinator-") || branch === repo.defaultBranch) return;
    await git(["branch", "-d", branch]).catch(() => undefined);
    // Fetch first, so a push made since the last fetch is counted.
    const fetched = await git(["fetch", "origin", branch]).then(
      () => true,
      () => false,
    );
    if (!fetched) return;
    const sha = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`])
      .then((r) => r.stdout.trim())
      .catch(() => "");
    if (!sha) return;
    const own = await git(["rev-list", "--count", `origin/${repo.defaultBranch}..${sha}`])
      .then((r) => Number(r.stdout.trim()))
      .catch(() => Number.NaN);
    if (own === 0) {
      await git([
        "push",
        `--force-with-lease=refs/heads/${branch}:${sha}`,
        "origin",
        "--delete",
        branch,
      ]).catch((err) => {
        log.warn({ branch, err }, "could not delete the remote coordinator branch");
      });
    }
  }

  /** Applies a changed coordinator model to a chat that already exists. */
  syncModel(ref: string): void {
    const row = projectService.row(ref);
    if (row.coordinatorChatId && chatService.get(row.coordinatorChatId)) {
      chatService.update(row.coordinatorChatId, { model: row.coordinatorModel });
    }
  }

  // ---- session scope --------------------------------------------------------

  /** The project a chat coordinates, or undefined for any other chat. */
  projectOfChat(chatId: string): ProjectRow | undefined {
    const chat = chatService.get(chatId);
    if (!chat || !chat.labels[COORDINATOR_LABEL]) return undefined;
    const row = projectService.findByCoordinatorChat(chatId);
    return row && row.id === chat.labels[COORDINATOR_LABEL] ? row : undefined;
  }

  projectById(id: string): ProjectRow | undefined {
    try {
      return projectService.row(id);
    } catch {
      return undefined;
    }
  }

  // ---- tool logic ---------------------------------------------------------------------

  private workersOf(row: ProjectRow): WorkerView[] {
    return projectService.workersOf(row).map((w) => {
      const worktreeId = worktreeIdOf(w);
      const status = projectService.branchStatus(worktreeId);
      const pr = status?.ciPr ?? null;
      return {
        worktreeId,
        repo: w.repoName,
        branch: w.branch,
        hostId: w.hostId,
        chats: chatService.list(worktreeId).map((c) => ({
          chatId: c.id,
          name: c.name,
          agent: c.agent,
          model: c.model ?? null,
          running: this.isRunning(c.id),
        })),
        pr: pr ? { number: pr.number, state: pr.state, url: pr.url ?? null } : null,
        ci: status?.ciState ?? null,
      };
    });
  }

  private isRunning(chatId: string): boolean {
    return hasRunningTask(chatId) || agentSessionService.isInTurn(chatId);
  }

  /** What the project has spent so far, from the usage scanner's numbers (its workers and its coordinator). */
  spendUsd(row: ProjectRow): number {
    const ids = new Set([
      projectScopeId(row.id),
      ...projectService.allWorktreesOf(row.id).map((w) => worktreeIdOf(w)),
    ]);
    if (ids.size === 0) return 0;
    const buckets = this.usage.aggregate({
      fromMs: 0,
      toMs: Date.now() + 60_000,
      groupBy: "worktreeId",
    });
    return buckets.filter((b) => ids.has(b.bucket)).reduce((sum, b) => sum + b.costUsd, 0);
  }

  status(row: ProjectRow) {
    const view = projectService.get(row.id);
    const workers = this.workersOf(row);
    const policy = view.effectivePolicy;
    const spent = this.spendUsd(row);
    return {
      project: {
        name: view.name,
        description: view.description,
        repos: view.repos,
        contextName: view.contextName,
      },
      policy,
      running: workers.reduce((n, w) => n + w.chats.filter((c) => c.running).length, 0),
      spend: {
        usd: Math.round(spent * 10_000) / 10_000,
        budgetUsd: policy.budgetUsd,
        remainingUsd: policy.budgetUsd === null ? null : Math.max(0, policy.budgetUsd - spent),
      },
      worktrees: workers,
    };
  }

  listWorktrees(row: ProjectRow): WorkerView[] {
    return this.workersOf(row);
  }

  /** A chat of one of the project's worker worktrees, or a refusal. The coordinator itself is not one. */
  private workerChat(row: ProjectRow, chatId: string) {
    const chat = chatService.get(chatId);
    const inProject =
      chat && projectService.workersOf(row).some((w) => worktreeIdOf(w) === chat.worktreeId);
    if (!chat || !inProject) {
      throw new CoordinatorToolError(
        `Chat ${chatId} is not a chat of a worktree in project "${row.name}". Call worktrees_list for the chats you may use.`,
      );
    }
    return chat;
  }

  /** A transcript of the last turns of a worker chat, as plain text. */
  readChat(row: ProjectRow, chatId: string, turns = 5) {
    const chat = this.workerChat(row, chatId);
    const sessionId = chat.activeSessionId;
    if (!sessionId) return { chatId, running: this.isRunning(chatId), transcript: "" };
    const revision = agentSessionService.logRevision(sessionId);
    const page = agentSessionService.replayTurns(
      sessionId,
      revision,
      Math.min(Math.max(1, turns), MAX_READ_TURNS),
    );
    const lines: string[] = [];
    for (const event of page.events as unknown as Array<Record<string, unknown>>) {
      if (event.type === "prompt") {
        lines.push(`User: ${String(event.text ?? "")}`);
      } else if (event.type === "update") {
        const update = event.update as Record<string, unknown>;
        if (update.sessionUpdate === "agent_message_chunk") {
          const content = update.content as { text?: string } | undefined;
          if (content?.text) lines.push(`Agent: ${content.text}`);
        } else if (update.sessionUpdate === "tool_call") {
          lines.push(`[tool] ${String(update.title ?? "tool call")}`);
        }
      } else if (event.type === "turn-ended" && event.error) {
        lines.push(`[turn failed] ${String(event.error)}`);
      }
    }
    let transcript = lines.join("\n");
    if (transcript.length > MAX_TRANSCRIPT_CHARS) {
      transcript = `...${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`;
    }
    return { chatId, running: this.isRunning(chatId), hasOlder: page.hasOlder, transcript };
  }

  /**
   * Checks whether the project may take more worker work. `observe` refuses.
   * The budget applies to every message. The concurrency limit applies only to
   * a message that starts a new turn. A dispatch passes `runs`, the number of worker agents it starts.
   */
  checkDispatch(row: ProjectRow, opts: { newRun: boolean; runs?: number }): void {
    this.requireMutation(row);
    const p = projectService.get(row.id).effectivePolicy;
    if (p.budgetUsd !== null) {
      const spent = this.spendUsd(row);
      if (spent >= p.budgetUsd) {
        throw new CoordinatorToolError(
          `Refused: project "${row.name}" has spent $${spent.toFixed(2)} of its $${p.budgetUsd} budget. Ask the user to raise budgetUsd before starting more work.`,
        );
      }
    }
    if (opts.newRun && p.maxConcurrent !== null) {
      const running = this.status(row).running;
      const runs = opts.runs ?? 1;
      if (running + runs > p.maxConcurrent) {
        throw new CoordinatorToolError(
          `Refused: ${running} worker agents are already running, ${runs === 1 ? "one more" : `${runs} more`} would pass the limit, and project "${row.name}" allows ${p.maxConcurrent} at once. Wait for one to finish, or stop one with worktree_stop.`,
        );
      }
    }
  }

  /** Sends a message to a worker chat. A message that starts a new turn counts against the limits. */
  sendToChat(row: ProjectRow, chatId: string, message: string) {
    this.requireMutation(row);
    const chat = this.workerChat(row, chatId);
    const text = message.trim();
    if (!text) throw new CoordinatorToolError("The message is empty.");
    if (text.length > MAX_MESSAGE) {
      throw new CoordinatorToolError(`The message is over ${MAX_MESSAGE} characters.`);
    }
    // A running chat only queues the message, so it takes no new slot, but the budget still applies.
    this.checkDispatch(row, { newRun: !this.isRunning(chatId) });
    const result = submitOrQueueTask({ worktreeId: chatScope(chat), chatId, prompt: text });
    return { chatId, queued: result.queued };
  }

  /** Stops the running turn of every chat in a worker worktree. */
  stopWorktree(row: ProjectRow, worktreeId: string) {
    this.requireMutation(row);
    const worker = projectService.workersOf(row).find((w) => worktreeIdOf(w) === worktreeId);
    if (!worker) {
      throw new CoordinatorToolError(
        `Worktree ${worktreeId} is not in project "${row.name}". Call worktrees_list for the worktrees you may use.`,
      );
    }
    const stopped: string[] = [];
    for (const chat of chatService.list(worktreeId)) {
      if (this.isRunning(chat.id) && abortTask(chat.id)) stopped.push(chat.id);
    }
    return { worktreeId, stoppedChats: stopped };
  }

  // ---- repo tools (T.1) ---------------------------------------------------------------

  /** A file of a repo's default-branch checkout, or the entries of a directory. */
  async repoRead(row: ProjectRow, repo: string, path: string) {
    return this.repoCall(() => projectFolderService.read(row, repo, path));
  }

  /** Fixed-string, case-insensitive search through a repo's checkout. */
  async repoSearch(row: ProjectRow, repo: string, query: string) {
    const matches = await this.repoCall(() => projectFolderService.search(row, repo, query));
    return { matches };
  }

  /** The newest commits on a repo's default-branch checkout. */
  async repoLog(row: ProjectRow, repo: string, n: number) {
    const commits = await this.repoCall(() => projectFolderService.log(row, repo, n));
    return { commits };
  }

  /** Reports a refusal from the folder or the host as a tool error the agent can read. */
  private async repoCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new CoordinatorToolError(err instanceof Error ? err.message : String(err));
    }
  }

  requireMutation(row: ProjectRow): void {
    const { autonomy } = resolvePolicy(projectService.get(row.id).policy);
    if (autonomy === "observe") {
      throw new CoordinatorToolError(
        `Refused: project "${row.name}" is in observe mode, which allows reading only. Ask the user to raise autonomy to autonomous.`,
      );
    }
  }
}

export const projectCoordinatorService = new ProjectCoordinatorService();
