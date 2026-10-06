/**
 * The coordinator session of a project (plan steps 6.2 and T.1).
 *
 * A project has one long-lived coordinator chat. It is a project-level chat with no
 * worktree: it runs in the project folder on the host the project pins it to (the
 * working copy of the project's context repo, with a checkout of every repo's default
 * branch under `repos/`). The agent gets a charter as its system prompt and a scoped set of hub tools
 * at `/mcp-proxy/band-coordinator`, authenticated by the session's own `mcp_`
 * token. Nothing in a tool call names the project: the hub takes it from the
 * chat the token was issued for, so a coordinator cannot reach another
 * project's worktrees.
 *
 * The policy of the project decides what a tool may do. `observe` allows reads
 * only. `steer` adds messaging and stopping the project's worker chats.
 * `autonomous` may also dispatch within the limits. Dispatch itself (creating
 * a worktree) arrives in step 6.3 and calls `checkDispatch` here.
 */

import { createLogger } from "@band-app/logger";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { ProjectQueries, type ProjectRow } from "../infra/db/queries/projects";
import { UsageEventQueries } from "../infra/db/queries/usage-events";
import { hostRegistry } from "../infra/host/registry";
import { chatScope, projectScopeId } from "../infra/project-scope";
import {
  type Autonomy,
  COORDINATOR_LABEL,
  COORDINATOR_SERVER,
  resolvePolicy,
} from "./_utils/project-policy";
import { agentSessionService } from "./agent-session-service";
import { chatService } from "./chat-service";
import { projectFolderService } from "./project-folder-service";
import { type ProjectView, projectService } from "./project-service";
import { projectSubscriptionService } from "./project-subscription-service";
import { abortTask, hasRunningTask, submitOrQueueTask } from "./task-service";
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
   * receives the charter. Needs at least one repo. The agent starts in the background (it
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

  lastError(projectId: string): string | null {
    return this.startErrors.get(projectId) ?? null;
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
      const chatId = chat.id;
      // Wake-ups for the coordinator: worker chats, member PRs, the context inbox.
      void projectSubscriptionService.reconcile(row.id).catch((err) => {
        log.warn({ projectId: row.id, err }, "could not subscribe the coordinator");
      });
      // Starting the agent prepares the project folder and attaches the session, which carries the charter and the tools.
      void agentSessionService.ensureSession(chatId, "prompt").catch((err) => {
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
   * Removes the coordinator's chat. Called before the project is removed. The project folder
   * stays on its host, because the checkouts in it may hold work that is not pushed.
   */
  async teardown(ref: string): Promise<void> {
    const row = projectService.row(ref);
    if (row.coordinatorChatId) chatService.remove(row.coordinatorChatId);
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

  // ---- charter and session scope --------------------------------------------------------

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

  /** The system prompt appended to a coordinator session. */
  charter(row: ProjectRow): string {
    const view = projectService.get(row.id);
    const p = view.effectivePolicy;
    const repos = view.repos
      .map((r) => `- ${r.repo}${r.role ? ` (role: ${r.role})` : ""}`)
      .join("\n");
    const limits = [
      p.maxConcurrent
        ? `at most ${p.maxConcurrent} worker agents run at once`
        : "no limit on concurrent worker agents",
      p.budgetUsd ? `a soft budget of $${p.budgetUsd} for the project` : "no budget limit",
      `worker agents run at isolation "${p.isolationFloor}" or stronger`,
      p.labels.length
        ? `workers go only on hosts labeled ${p.labels.join(", ")}`
        : "workers may go on any host",
    ].join("; ");
    const autonomy: Record<Autonomy, string> = {
      observe:
        "Autonomy is observe. You may read project state and worker chats. You may not message, stop or dispatch anything. Report what you find and recommend actions to the user.",
      steer:
        "Autonomy is steer. You may message and stop worker chats of this project. Dispatching a new worker agent needs the user's approval. Merging always needs the user's confirmation.",
      autonomous: p.autoMerge
        ? "Autonomy is autonomous with auto-merge on. You may dispatch workers within the limits and merge pull requests whose CI passed."
        : "Autonomy is autonomous. You may dispatch workers within the limits. Merging still needs the user's confirmation.",
    };
    return [
      `You are the coordinator of the Band project "${view.name}".`,
      view.description ? `\nProject description: ${view.description}` : "",
      "\nYour job is to plan the work across the project's repos, hand it to worker agents, check on them and keep the user informed. Worker agents work in their own worktrees, one per task.",
      `\nWorking directory. You run in the project folder on the coordinator host. It is the working copy of the project context (notes.md, docs/, learnings/, inbox/, handoffs/) and has a checkout of every project repo's default branch under repos/<repo>/ (the local branch band/${view.name}/<default>, which tracks origin/<default>). Read the current code there, or through repo_read, repo_search and repo_log. Band fetches before your turns and fast-forwards a checkout only when it is clean, so a checkout with local changes can be behind origin. Code changes go through tasks (worktrees_create). Do not edit a default branch checkout unless the user explicitly asks you to. ${p.autonomy === "autonomous" ? "When the user asks for such an edit, you may commit it, and you may push it because autonomy is autonomous." : `When the user asks for such an edit, commit it but do not push without the user's confirmation, because autonomy is ${p.autonomy}.`} The folders repos/ and tasks/ are never committed to the context repo.`,
      `\nRepos in this project:\n${repos || "- none yet"}`,
      `\nModels: you run on ${p.models.coordinator}, worker agents on ${p.models.worker}, reviewers on ${p.models.reviewer}.`,
      `\nPolicy: ${limits}.`,
      `\n${autonomy[p.autonomy]}`,
      `\nContext. The project context repo "${view.contextName}" is shared by every agent in the project, and the user context holds the user's preferences. Read them before you plan. Layout of the project context: notes.md (running notes), docs/ (design and contracts), media/ (screenshots, recordings), inbox/<agent>.md (pointers to handoffs for an agent), handoffs/ (one file per handoff), learnings/ (what agents learned). Use context_search to find things, context_append_learning to record what future agents should know, and context_handoff to pass work on. Write contracts between repos (API shapes, event formats) to docs/ so the agent on the other side can read them.`,
      `\nTools. You act on the project only through the ${COORDINATOR_SERVER} tools: project_status (worktrees, agents, pull requests, spend), worktrees_list, chats_read, chats_send, worktree_stop and worktrees_create, plus repo_read {repo, path}, repo_search {repo, query} and repo_log {repo, n} for the default branch checkouts. They are limited to this project's worktrees and repos. A refused call names the reason, so tell the user what blocked you instead of retrying.`,
      "\nDispatching. worktrees_create starts a worker agent in a new worktree. Write the brief so the worker can act on it alone: the goal, the constraints, the contracts with other repos and what is out of scope, plus acceptance scenarios it can check. For work across repos, pass a group in mode split with the merge order. In steer mode the call waits for the user's approval, so tell the user it is pending and do not call it again.",
      `\nWake-ups. Band wakes you with a "Subscription update" message when something needs you: a worker chat ended its turn with an error, is waiting for a permission or an answer, or finished; a pull request of a task group has a review comment, a CI result or was merged or closed; or a new file appeared in inbox/ or handoffs/ of the project context. The message names the chat id or the file path. Read the source before you act on it. Events are batched, so one message can carry several. A pull request's subscriptions end when it merges or closes.`,
      `\nNotes and the inbox. You are the only writer of notes.md in the project context: workers do not edit it, so keep it current with decisions and status. learnings/ is append-only: add entries, never rewrite or delete them. Handoffs from workers land in handoffs/<stamp>-<from>-to-<to>.md and a pointer line in inbox/<to>.md. When you have dealt with an item in inbox/ or handoffs/, move the file into inbox/done/ (git mv in your working copy of the project context, which syncs after your turn). A file in inbox/done/ does not wake you again.`,
      "\nMerging. Never merge a pull request unless the user confirmed it in this conversation or auto-merge is on.",
    ]
      .filter(Boolean)
      .join("\n");
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
        `Refused: project "${row.name}" is in observe mode, which allows reading only. Ask the user to raise autonomy to steer or autonomous.`,
      );
    }
  }
}

export const projectCoordinatorService = new ProjectCoordinatorService();
