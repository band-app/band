/**
 * Project-wide subscriptions (plan step 6.4). Events about anything in a project wake its
 * coordinator chat, not only the chat that made a subscription.
 *
 * Three kinds of event reach the coordinator:
 *
 * - GitHub. When a task group member's worktree gets a pull request (the branch-status poller
 *   stores it), this service subscribes the coordinator to the PR (comments, reviews, lifecycle)
 *   and to CI on the member's branch. Both go away when the PR merges or closes, after one event
 *   that tells the coordinator which.
 * - Worker chats. A chat of a project worktree whose turn ends with an error, which asks the
 *   user a question, or which finishes with nothing queued, becomes an event with the chat id.
 * - The project context. A new file in `inbox/` or `handoffs/` (not `inbox/done/`) becomes an
 *   event with its path. The coordinator marks an item handled by moving it into `inbox/done/`.
 *
 * Worker and context events go through one subscription per project, `project:<id>`, so a burst
 * of them is one coalesced wake-up with the guards of `SubscriptionService` (coalescing, a
 * wake-up cap, a 180-day expiry). A worker chat is also held to one event per kind per minute,
 * so a coordinator that messages a worker and wakes on its answer cannot loop quickly.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "@band-app/logger";
import type { ProjectRow } from "../infra/db/queries/projects";
import { TaskGroupQueries } from "../infra/db/queries/task-groups";
import {
  type ChatLifecycleEvent,
  subscribeChatLifecycle,
} from "../infra/events/chat-lifecycle-bus";
import {
  type StatusEvent,
  subscribe as subscribeStatusBus,
} from "../infra/events/status-event-bus";
import { githubCiKey, githubPrKey } from "../infra/subscriptions/github";
import { redactSecrets } from "./_utils/context-redaction";
import { chatService } from "./chat-service";
import { contextRepoPath, contextService, runGit } from "./context-service";
import { githubWebhookService } from "./github-webhook-service";
import { projectService } from "./project-service";
import { type Subscription, subscriptionService } from "./subscription-service";

const log = createLogger("project-subscriptions");

export const PROJECT_SOURCE = "project";
/** Wake-ups one project subscription may deliver before it ends. */
const PROJECT_MAX_WAKEUPS = 1000;
/** Wake-ups a member's PR or CI subscription may deliver. */
const MEMBER_MAX_WAKEUPS = 100;
const DEFAULT_COALESCE_SECONDS = 30;
const DEFAULT_WORKER_EVENT_GAP_MS = 60_000;
const MAX_ERROR_CHARS = 300;
const INBOX_PREFIX = "inbox/";
const DONE_PREFIX = "inbox/done/";
const HANDOFFS_PREFIX = "handoffs/";
/** git's empty tree, the base for the first commit of a repo. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Text from a worker or a file name, on one line and cut short, before it goes into a prompt. */
function oneLine(text: string, max: number): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    out += code < 32 || code === 127 ? " " : ch;
  }
  return out.replace(/ {2,}/g, " ").trim().slice(0, max);
}

export const projectKey = (projectId: string) => `${PROJECT_SOURCE}:${projectId}`;

/** How long a project subscription batches events. Read when a subscription is made, so a test can shorten it. */
function coalesceSeconds(): number {
  const raw = Number(process.env.BAND_PROJECT_COALESCE_SECONDS);
  return process.env.BAND_PROJECT_COALESCE_SECONDS !== undefined &&
    Number.isInteger(raw) &&
    raw >= 0 &&
    raw <= 3600
    ? raw
    : DEFAULT_COALESCE_SECONDS;
}

/** A worker chat's events are held to one per kind per this long. Read on every event, so a test can set it. */
function workerEventGapMs(): number {
  const raw = Number(process.env.BAND_PROJECT_EVENT_MIN_GAP_MS);
  return Number.isFinite(raw) && raw >= 0 && process.env.BAND_PROJECT_EVENT_MIN_GAP_MS !== undefined
    ? raw
    : DEFAULT_WORKER_EVENT_GAP_MS;
}

/** `owner/name` and the number from a pull request URL, or undefined for a URL of another shape. */
export function parsePrUrl(url: string): { repo: string; number: number } | undefined {
  const m = /^https?:\/\/[^/]+\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(url);
  return m ? { repo: `${m[1]}/${m[2]}`.toLowerCase(), number: Number(m[3]) } : undefined;
}

/** Added paths of a diff that mean new work for the coordinator. */
export function isInboxPath(path: string): boolean {
  if (path.startsWith(DONE_PREFIX)) return false;
  if (!path.startsWith(INBOX_PREFIX) && !path.startsWith(HANDOFFS_PREFIX)) return false;
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base !== "" && !base.startsWith(".");
}

export interface ProjectSubscriptionView {
  id: string;
  source: string;
  filterKey: string;
  kind: "project" | "pull-request" | "ci";
  wakeups: number;
  maxWakeups: number;
  expiresAt: number;
  createdAt: number;
}

export interface ProjectWakeupView {
  subscriptionId: string;
  summary: string;
  receivedAt: number;
  deliveredAt: number | null;
  droppedReason: string | null;
}

export class ProjectSubscriptionService {
  private readonly groups = new TaskGroupQueries();
  private readonly lastWorkerEvent = new Map<string, number>();
  /** The commit of each project context the last time this service looked at it. */
  private readonly seenHeads = new Map<string, string>();
  /** One pass per context at a time, so two quick pushes are diffed in order. */
  private readonly contextLanes = new Map<string, Promise<void>>();
  /** One subscribe per member worktree at a time, so two polls never create the same PR subscription twice. */
  private readonly memberLanes = new Map<string, Promise<void>>();
  private stops: Array<() => void> = [];
  private started = false;

  /** Starts listening, then makes every project's subscriptions match the current state. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stops = [
      subscribeStatusBus((event) => this.onStatusEvent(event)),
      subscribeChatLifecycle((event) => this.onChatLifecycle(event)),
      contextService.onChanged((name) => this.onContextChanged(name)),
    ];
    void this.reconcileAll().catch((err) => log.warn({ err }, "could not reconcile projects"));
  }

  stop(): void {
    this.started = false;
    for (const stop of this.stops) stop();
    this.stops = [];
    this.lastWorkerEvent.clear();
    this.seenHeads.clear();
    this.contextLanes.clear();
    this.memberLanes.clear();
  }

  /** Subscribes every project that has a coordinator, and takes the inbox baseline of its context. */
  async reconcileAll(): Promise<void> {
    for (const row of projectService.rows()) await this.reconcile(row.id);
  }

  /**
   * Makes the project's subscriptions match its state: the project subscription exists when it
   * has a coordinator, and each member with an open PR has its PR and CI subscriptions. Safe to
   * call at any time. Called at boot and when a coordinator is created.
   */
  async reconcile(projectId: string): Promise<void> {
    const row = projectService.find(projectId);
    if (!row?.coordinatorChatId || !row.coordinatorWorktreeId) return;
    this.ensureProjectSubscription(row);
    await this.baseline(row.contextName);
    for (const member of this.groups.membersOfProject(row.id)) {
      if (!member.worktreeId) continue;
      const pr = projectService.branchStatus(member.worktreeId)?.ciPr;
      if (pr) await this.syncMemberPr(member.worktreeId, pr);
    }
  }

  // ---- views ---------------------------------------------------------------------------

  /** The subscriptions that wake a project's coordinator, with its recent wake-ups. */
  describe(row: ProjectRow): {
    subscriptions: ProjectSubscriptionView[];
    wakeups: ProjectWakeupView[];
  } {
    const chatId = row.coordinatorChatId;
    if (!chatId) return { subscriptions: [], wakeups: [] };
    const mine = subscriptionService.list({ chatId }).filter((s) => s.createdBy === "coordinator");
    const wakeups = mine
      .flatMap((s) =>
        subscriptionService.listEvents(s.id).map((e) => ({
          subscriptionId: s.id,
          summary: e.summary,
          receivedAt: e.receivedAt,
          deliveredAt: e.deliveredAt,
          droppedReason: e.droppedReason ?? null,
        })),
      )
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, 50);
    return {
      subscriptions: mine.map((s) => ({
        id: s.id,
        source: s.source,
        filterKey: s.filterKey,
        kind:
          s.source === PROJECT_SOURCE
            ? "project"
            : s.filterKey.startsWith("github:ci:")
              ? "ci"
              : "pull-request",
        wakeups: s.wakeups,
        maxWakeups: s.maxWakeups,
        expiresAt: s.expiresAt,
        createdAt: s.createdAt,
      })),
      wakeups,
    };
  }

  // ---- the project subscription ------------------------------------------------------------

  private ensureProjectSubscription(row: ProjectRow): Subscription | undefined {
    const chatId = row.coordinatorChatId;
    const worktreeId = row.coordinatorWorktreeId;
    if (!chatId || !worktreeId || !chatService.get(chatId)) return undefined;
    const key = projectKey(row.id);
    const now = Date.now();
    const existing = subscriptionService
      .list({ chatId })
      .find((s) => s.source === PROJECT_SOURCE && s.filterKey === key && s.expiresAt > now);
    if (existing) return existing;
    return subscriptionService.create({
      chatId,
      worktreeId,
      source: PROJECT_SOURCE,
      filterKey: key,
      coalesceSeconds: coalesceSeconds(),
      maxWakeups: PROJECT_MAX_WAKEUPS,
      createdBy: "coordinator",
    });
  }

  private emitProjectEvent(
    row: ProjectRow,
    event: { id: string; kind: string; summary: string; url?: string },
  ): void {
    if (!this.ensureProjectSubscription(row)) return;
    subscriptionService.ingest({
      id: event.id,
      source: PROJECT_SOURCE,
      kind: event.kind,
      key: projectKey(row.id),
      url: event.url ?? "",
      actor: "band",
      summary: event.summary,
      at: Date.now(),
    });
  }

  // ---- worker chats ------------------------------------------------------------------------

  private onChatLifecycle(event: ChatLifecycleEvent): void {
    try {
      const row = projectService.projectOfWorker(event.worktreeId);
      if (!row?.coordinatorChatId || event.chatId === row.coordinatorChatId) return;
      const gap = workerEventGapMs();
      const now = Date.now();
      const gapKey = `${event.chatId}:${event.kind}`;
      const last = this.lastWorkerEvent.get(gapKey);
      if (last !== undefined && now - last < gap) return;
      for (const [k, at] of this.lastWorkerEvent)
        if (now - at >= gap) this.lastWorkerEvent.delete(k);
      this.lastWorkerEvent.set(gapKey, now);

      const rawName = chatService.get(event.chatId)?.name;
      const chatName = rawName ? oneLine(rawName, 80) : undefined;
      const who = `Worker chat ${event.chatId}${chatName ? ` ("${chatName}")` : ""} in worktree ${event.worktreeId}`;
      const summary =
        event.kind === "failed"
          ? `${who} ended its turn with an error: ${oneLine(redactSecrets(event.error ?? "unknown error"), MAX_ERROR_CHARS)}`
          : event.kind === "waiting"
            ? `${who} is waiting for a permission or an answer.`
            : `${who} finished its turn and is idle.`;
      this.emitProjectEvent(row, {
        id: `worker:${event.chatId}:${event.kind}:${now}-${randomUUID()}`,
        kind: `worker_${event.kind}`,
        summary,
      });
    } catch (err) {
      log.warn({ err, chatId: event.chatId }, "could not turn a worker event into a wake-up");
    }
  }

  // ---- member pull requests ----------------------------------------------------------------

  private onStatusEvent(event: StatusEvent): void {
    if (event.kind !== "branch-status" || !event.worktreeId || !event.ci?.pr) return;
    const worktreeId = event.worktreeId;
    const pr = event.ci.pr;
    void this.syncMemberPr(worktreeId, pr).catch((err) =>
      log.warn({ err, worktreeId }, "could not sync a member's PR subscriptions"),
    );
  }

  /** Records the member's PR and subscribes or unsubscribes the coordinator for it. */
  syncMemberPr(
    worktreeId: string,
    pr: { number: number; url: string; state: "open" | "merged" | "closed" },
  ): Promise<void> {
    const previous = this.memberLanes.get(worktreeId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.syncMemberPrNow(worktreeId, pr))
      .finally(() => {
        if (this.memberLanes.get(worktreeId) === run) this.memberLanes.delete(worktreeId);
      });
    this.memberLanes.set(worktreeId, run);
    return run;
  }

  private async syncMemberPrNow(
    worktreeId: string,
    pr: { number: number; url: string; state: "open" | "merged" | "closed" },
  ): Promise<void> {
    const found = this.groups.memberOfWorktree(worktreeId);
    if (!found) return;
    const row = projectService.find(found.group.projectId);
    if (!row?.coordinatorChatId || !row.coordinatorWorktreeId) return;
    if (found.member.prNumber !== pr.number) {
      this.groups.setMemberPr(found.group.id, found.member.repo, pr.number);
    }
    const parsed = parsePrUrl(pr.url);
    if (!parsed) return;
    const prKey = githubPrKey(parsed.repo, pr.number);
    const ciKey = githubCiKey(parsed.repo, found.group.branch);
    const coordinatorChatId = row.coordinatorChatId;
    const mine = () =>
      subscriptionService
        .list({ chatId: coordinatorChatId })
        .filter(
          (s) =>
            s.createdBy === "coordinator" &&
            s.source === "github" &&
            (s.filterKey === prKey || s.filterKey === ciKey),
        );

    const current = mine();
    if (pr.state !== "open") {
      const existing = current;
      if (existing.length === 0) return;
      // One event first, so the coordinator learns the outcome, then the subscriptions go.
      this.emitProjectEvent(row, {
        id: `pr:${parsed.repo}#${pr.number}:${pr.state}`,
        kind: pr.state === "merged" ? "pr_merged" : "pr_closed",
        summary: `Pull request ${parsed.repo}#${pr.number} of task group "${found.group.title}" (${found.member.repo}) was ${pr.state}.`,
        url: pr.url,
      });
      for (const sub of existing) subscriptionService.remove(sub.id);
      return;
    }

    const have = new Set(current.map((s) => s.filterKey));
    const base = {
      chatId: coordinatorChatId,
      worktreeId: row.coordinatorWorktreeId,
      repo: parsed.repo,
      coalesceSeconds: coalesceSeconds(),
      maxWakeups: MEMBER_MAX_WAKEUPS,
      createdBy: "coordinator" as const,
    };
    const created: Subscription[] = [];
    if (!have.has(prKey)) {
      created.push(
        subscriptionService.createGithubPr({
          ...base,
          number: pr.number,
          allowedSenders: await githubWebhookService.defaultSenders(parsed.repo),
        }),
      );
    }
    if (!have.has(ciKey)) {
      created.push(subscriptionService.createGithubCi({ ...base, branch: found.group.branch }));
    }
    // Registers the repo webhook, or records that it waits for a public URL (the poller serves it meanwhile).
    for (const sub of created) await githubWebhookService.ensureRegistered(sub);
  }

  // ---- the project context inbox -----------------------------------------------------------

  private async headOf(name: string): Promise<string | undefined> {
    const r = await runGit(["rev-parse", "--verify", "-q", "HEAD^{commit}"], {
      cwd: contextRepoPath(name),
    });
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  /** Takes the commit a context is at now, so only later additions wake the coordinator. */
  private async baseline(name: string): Promise<void> {
    if (this.seenHeads.has(name)) return;
    const head = await this.headOf(name).catch(() => undefined);
    if (head && !this.seenHeads.has(name)) this.seenHeads.set(name, head);
  }

  private onContextChanged(name: string): void {
    const row = projectService.findByContext(name);
    if (!row?.coordinatorChatId) return;
    const previous = this.contextLanes.get(name) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.scanContext(row, name))
      .catch((err) => log.warn({ err, context: name }, "could not scan the context for new files"))
      .finally(() => {
        if (this.contextLanes.get(name) === run) this.contextLanes.delete(name);
      });
    this.contextLanes.set(name, run);
  }

  private async scanContext(row: ProjectRow, name: string): Promise<void> {
    const head = await this.headOf(name);
    if (!head) return;
    const seen = this.seenHeads.get(name);
    if (seen === head) return;
    this.seenHeads.set(name, head);
    const repo = contextRepoPath(name);
    // Without a baseline, only the newest commit counts.
    let from = seen;
    if (!from) {
      const parent = await runGit(["rev-parse", "--verify", "-q", `${head}^`], { cwd: repo });
      from = parent.code === 0 ? parent.stdout.trim() : EMPTY_TREE;
    }
    const diff = await runGit(
      [
        "diff",
        "--name-only",
        "--no-renames",
        "--diff-filter=A",
        from,
        head,
        "--",
        INBOX_PREFIX,
        HANDOFFS_PREFIX,
      ],
      { cwd: repo },
    );
    if (diff.code !== 0) return;
    const short = head.slice(0, 7);
    for (const path of diff.stdout
      .split("\n")
      .map((p) => p.trim())
      .filter(isInboxPath)) {
      this.emitProjectEvent(row, {
        id: `context:${name}:${head}:${path}`,
        kind: path.startsWith(HANDOFFS_PREFIX) ? "handoff" : "inbox",
        summary: `New file in the project context "${name}": ${oneLine(path, 200)} (commit ${short}). Read it, act on it, then move it to ${DONE_PREFIX} if it is an inbox item.`,
        url: path,
      });
    }
  }
}

export const projectSubscriptionService = new ProjectSubscriptionService();
