/**
 * Read model of the project dashboard (plan step 6.6). It joins what other services already own: the
 * project's chats, its task groups with their branch status, the usage scanner's rows and the pending
 * dispatches. Nothing here writes, and the quick actions call the services that own them.
 */

import { toWorktreeId } from "@band-app/shared/worktree-id";
import type { ProjectRow } from "../infra/db/queries/projects";
import { UsageEventQueries } from "../infra/db/queries/usage-events";
import { projectScopeId } from "../infra/project-scope";
import { agentSessionService } from "./agent-session-service";
import { chatService } from "./chat-service";
import { projectDispatchService } from "./project-dispatch-service";
import { projectService } from "./project-service";
import { projectSubscriptionService } from "./project-subscription-service";
import { abortTask, hasRunningTask } from "./task-service";

const DAY_MS = 24 * 60 * 60 * 1000;
const SPEND_DAYS = 7;

export interface DashboardAgent {
  chatId: string;
  /** Null for the coordinator, which runs in the project folder and has no worktree. */
  worktreeId: string | null;
  name: string;
  role: "coordinator" | "worker";
  repo: string | null;
  branch: string | null;
  hostId: string | null;
  agent: string;
  model: string | null;
  status: "running" | "idle";
  lastActivityAt: number | null;
  spendUsd: number;
}

function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export class ProjectDashboardService {
  private readonly usage = new UsageEventQueries();

  private isRunning(chatId: string): boolean {
    return hasRunningTask(chatId) || agentSessionService.isInTurn(chatId);
  }

  dashboard(row: ProjectRow) {
    const view = projectService.get(row.id);
    const worktrees = projectService.allWorktreesOf(row.id);
    // Rows recorded under the project's own scope are the coordinator's, which has no worktree.
    const worktreeIds = [
      projectScopeId(row.id),
      ...worktrees.map((w) => toWorktreeId(w.repoName, w.name)),
    ];
    const now = Date.now();
    const today = localDay(now);
    const weekStart = now - (SPEND_DAYS - 1) * DAY_MS;
    const firstDay = localDay(weekStart);
    // Every row the scanner has for the project's worktrees, so the budget matches `spendUsd`.
    const rows = this.usage.spendByChatAndDay(worktreeIds, 0);

    const perChat = new Map<string, number>();
    const perDay = new Map<string, number>();
    let total = 0;
    let unattributed = 0;
    let todayUsd = 0;
    let weekUsd = 0;
    for (const r of rows) {
      total += r.costUsd;
      if (r.chatId && chatService.get(r.chatId)) {
        perChat.set(r.chatId, (perChat.get(r.chatId) ?? 0) + r.costUsd);
      } else {
        unattributed += r.costUsd;
      }
      if (r.day >= firstDay) {
        weekUsd += r.costUsd;
        perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.costUsd);
      }
      if (r.day === today) todayUsd += r.costUsd;
    }

    const agents: DashboardAgent[] = [];
    // Project-level chats (the coordinator) have no worktree.
    for (const chat of chatService.listForProject(row.id)) {
      agents.push({
        chatId: chat.id,
        worktreeId: null,
        name: chat.name,
        role: "coordinator",
        repo: null,
        branch: null,
        hostId: row.coordinatorHostId ?? null,
        agent: chat.agent,
        model: chat.model ?? null,
        status: this.isRunning(chat.id) ? "running" : "idle",
        lastActivityAt: chat.activeSessionLastModified ?? null,
        spendUsd: round(perChat.get(chat.id) ?? 0),
      });
    }
    for (const w of worktrees) {
      const worktreeId = toWorktreeId(w.repoName, w.name);
      for (const chat of chatService.list(worktreeId)) {
        agents.push({
          chatId: chat.id,
          worktreeId,
          name: chat.name,
          role: "worker",
          repo: w.repoName,
          branch: w.branch,
          hostId: w.hostId ?? null,
          agent: chat.agent,
          model: chat.model ?? null,
          status: this.isRunning(chat.id) ? "running" : "idle",
          lastActivityAt: chat.activeSessionLastModified ?? null,
          spendUsd: round(perChat.get(chat.id) ?? 0),
        });
      }
    }
    agents.sort(
      (a, b) =>
        Number(b.role === "coordinator") - Number(a.role === "coordinator") ||
        (a.worktreeId ?? "").localeCompare(b.worktreeId ?? "") ||
        a.chatId.localeCompare(b.chatId),
    );

    const days: Array<{ day: string; usd: number }> = [];
    for (let i = SPEND_DAYS - 1; i >= 0; i--) {
      const day = localDay(now - i * DAY_MS);
      days.push({ day, usd: round(perDay.get(day) ?? 0) });
    }
    const budgetUsd = view.effectivePolicy.budgetUsd;

    const groups = projectDispatchService.groupsOf(row).map((g) => ({
      ...g,
      members: g.members.map((m) => {
        const status = m.worktreeId ? projectService.branchStatus(m.worktreeId) : undefined;
        const pr = status?.ciPr ?? null;
        return {
          ...m,
          pr: pr
            ? { number: pr.number, url: pr.url ?? null, state: pr.state, isDraft: pr.isDraft }
            : null,
          ci: status?.ciState ?? null,
        };
      }),
    }));

    const { wakeups } = projectSubscriptionService.describe(row);
    return {
      agents,
      groups,
      spend: {
        totalUsd: round(total),
        todayUsd: round(todayUsd),
        last7DaysUsd: round(weekUsd),
        days,
        unattributedUsd: round(unattributed),
        budgetUsd,
        remainingUsd: budgetUsd === null ? null : round(Math.max(0, budgetUsd - total)),
      },
      pendingDispatches: projectDispatchService.requestsOf(row, "pending"),
      wakeups: wakeups.slice(0, 10),
    };
  }

  /** Stops the running turn of one chat of the project, the coordinator's included. Returns whether a turn was stopped. */
  stopAgent(row: ProjectRow, chatId: string): boolean {
    const chat = chatService.get(chatId);
    // The coordinator has no worktree: it belongs to the project directly.
    const inProject =
      chat &&
      (chat.projectId === row.id ||
        projectService
          .allWorktreesOf(row.id)
          .some((w) => toWorktreeId(w.repoName, w.name) === chat.worktreeId));
    if (!chat || !inProject) return false;
    return this.isRunning(chatId) ? abortTask(chatId) : false;
  }
}

export const projectDashboardService = new ProjectDashboardService();
