import { Button, cn } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { trpc } from "../../../lib/trpc-client";
import { useAdapter } from "../../context";
import { ErrorLine, errorText, PROJECTS_KEY, type Project } from "./project-sections";

type Dashboard = Awaited<ReturnType<typeof trpc.projects.dashboard.query>>;
type Agent = Dashboard["agents"][number];
type Subscriptions = Awaited<ReturnType<typeof trpc.projects.subscriptions.query>>;

const usd = (n: number) => `$${n.toFixed(2)}`;

/** "3 min ago", "2 h ago", "yesterday", then the date. Short enough for a narrow panel. */
function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172_800) return "yesterday";
  return new Date(ms).toLocaleDateString();
}

/** What a coordinator subscription listens to, in words. */
function subscriptionLabel(s: Subscriptions["subscriptions"][number]): string {
  if (s.kind === "project") return "Worker chats and the context inbox";
  const pr = s.filterKey.match(/^github:pr:(.+)#(\d+)$/);
  if (pr) return `Reviews and comments on PR #${pr[2]}`;
  const ci = s.filterKey.match(/^github:ci:.+@(.+)$/);
  if (ci) return `CI on ${ci[1]}`;
  return s.filterKey;
}

/**
 * A wake-up as a person reads it. The coordinator's own message names a worker by its chat id so it
 * can act on it; here the worktree says enough: "Worker chat chat_123 ("Chat") in worktree
 * api-feat finished its turn" reads "api-feat finished its turn".
 */
function wakeupText(summary: string): string {
  return summary.replace(/^Worker chat \S+(?: \("[^"]*"\))? in worktree (\S+) /, "$1 ");
}

const CI_LABEL: Record<string, string> = {
  success: "CI passed",
  failure: "CI failed",
  pending: "CI running",
  running: "CI running",
  cancelled: "CI cancelled",
};
const CI_TONE: Record<string, string> = {
  success: "bg-green-500",
  failure: "bg-red-500",
  pending: "bg-yellow-500",
  running: "bg-yellow-500",
};

function Heading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {children}
      </h3>
      {action}
    </div>
  );
}

function StatusDot({ running }: { running: boolean }) {
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        running ? "animate-pulse bg-green-500" : "bg-muted-foreground/40",
      )}
    />
  );
}

/**
 * The Activity tab of a project's view, sized for the right panel: the coordinator first (state,
 * start, stop, charter), then the other agents, spend, the project's pull requests, what wakes the
 * coordinator, and the recent wake-ups once. It reads `projects.dashboard` and
 * `projects.subscriptions`, refreshed by the status stream with a slow poll as the fallback.
 */
export function ProjectActivity({
  project,
  canEdit,
  onOpenWorktree,
  onOpenCharter,
}: {
  project: Project;
  canEdit: boolean;
  onOpenWorktree: (worktreeId: string) => void;
  onOpenCharter: () => void;
}) {
  const queryClient = useQueryClient();
  const adapter = useAdapter();
  const [error, setError] = useState<string | null>(null);
  const dashKey = ["projects.dashboard", project.id];
  const subsKey = ["projects.subscriptions", project.id];
  useEffect(
    () =>
      adapter.subscribeStatusEvents((event) => {
        if (
          event.kind === "update" ||
          event.kind === "branch-status" ||
          event.kind === "chat-created" ||
          event.kind === "chat-removed" ||
          event.kind === "agent-session-created" ||
          event.kind === "agent-session-updated" ||
          event.kind === "agent-session-ended" ||
          event.kind === "subscription-created" ||
          event.kind === "subscription-delivered" ||
          event.kind === "subscription-removed"
        ) {
          void queryClient.invalidateQueries({ queryKey: ["projects.dashboard", project.id] });
          void queryClient.invalidateQueries({ queryKey: ["projects.subscriptions", project.id] });
        }
      }),
    [adapter, queryClient, project.id],
  );
  const dash = useQuery({
    queryKey: dashKey,
    queryFn: () => trpc.projects.dashboard.query({ project: project.id }),
    refetchInterval: 5000,
  });
  const subs = useQuery({
    queryKey: subsKey,
    queryFn: () => trpc.projects.subscriptions.query({ project: project.id }),
    refetchInterval: 5000,
  });
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      await queryClient.invalidateQueries({ queryKey: dashKey });
      await queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
    }
  };
  const stop = (chatId: string) =>
    act(() => trpc.projects.stopAgent.mutate({ project: project.id, chatId }));

  const data = dash.data;
  const coordinatorAgent = data?.agents.find((a) => a.chatId === project.coordinator?.chatId);
  const others = (data?.agents ?? []).filter((a) => a !== coordinatorAgent);
  const wakeups = subs.data?.wakeups ?? [];

  return (
    <div className="space-y-5" data-testid="dashboard">
      {project.description ? (
        <p className="text-sm text-muted-foreground" data-testid="project-page__description">
          {project.description}
        </p>
      ) : null}

      <CoordinatorCard
        project={project}
        agent={coordinatorAgent}
        canEdit={canEdit}
        onStart={() => act(() => trpc.projects.startCoordinator.mutate({ project: project.id }))}
        onStop={stop}
        onOpenCharter={onOpenCharter}
      />

      {others.length > 0 ? (
        <section className="space-y-1.5" data-testid="dashboard__agents">
          <Heading>Agents</Heading>
          <ul className="divide-y rounded-lg border">
            {others.map((a) => (
              <AgentRow
                key={a.chatId}
                agent={a}
                canEdit={canEdit}
                onOpen={a.worktreeId ? () => onOpenWorktree(a.worktreeId as string) : undefined}
                onStop={() => stop(a.chatId)}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {data ? (
        <section className="space-y-1.5" data-testid="dashboard__spend">
          <Heading>Spend</Heading>
          <div className="grid grid-cols-3 divide-x rounded-lg border text-center">
            <Stat label="Today" testId="dashboard__spend-today" value={usd(data.spend.todayUsd)} />
            <Stat
              label="7 days"
              testId="dashboard__spend-week"
              value={usd(data.spend.last7DaysUsd)}
            />
            <Stat label="Total" testId="dashboard__spend-total" value={usd(data.spend.totalUsd)} />
          </div>
          <p className="text-xs text-muted-foreground">
            {data.spend.budgetUsd !== null ? (
              <>
                <span data-testid="dashboard__spend-remaining">
                  {usd(data.spend.remainingUsd ?? 0)}
                </span>{" "}
                left of the {usd(data.spend.budgetUsd)} budget.
              </>
            ) : (
              "No budget set."
            )}
            {data.spend.unattributedUsd > 0 ? (
              <>
                {" "}
                <span data-testid="dashboard__spend-unattributed">
                  {usd(data.spend.unattributedUsd)}
                </span>{" "}
                is from chats that no longer exist.
              </>
            ) : null}
          </p>
        </section>
      ) : null}

      {data && data.worktrees.length > 0 ? (
        <section className="space-y-1.5" data-testid="dashboard__worktrees">
          <Heading>Pull requests</Heading>
          <ul className="divide-y rounded-lg border">
            {data.worktrees.map((w) => (
              <li
                key={w.worktreeId}
                data-testid="dashboard__member"
                data-repo={w.repo}
                data-worktree={w.worktreeId}
                data-ci={w.ci ?? ""}
                data-pr-state={w.pr?.state ?? ""}
              >
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                  onClick={() => onOpenWorktree(w.worktreeId)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{w.branch}</span>
                    <span className="block truncate text-xs text-muted-foreground">{w.repo}</span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs">
                    {w.pr ? (
                      <a
                        href={w.pr.url ?? undefined}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className={cn(
                          "rounded px-1.5 py-0.5 font-medium",
                          w.pr.isDraft
                            ? "bg-muted text-muted-foreground"
                            : w.pr.state === "merged"
                              ? "bg-violet-500/15 text-violet-600 dark:text-violet-400"
                              : w.pr.state === "closed"
                                ? "bg-red-500/15 text-red-600 line-through dark:text-red-400"
                                : "bg-green-500/15 text-green-700 dark:text-green-400",
                        )}
                        data-testid="dashboard__member-pr"
                      >
                        PR #{w.pr.number}
                        {w.pr.isDraft ? " draft" : w.pr.state === "open" ? "" : ` ${w.pr.state}`}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">No PR</span>
                    )}
                    <span
                      className="flex items-center gap-1 text-muted-foreground"
                      data-testid="dashboard__member-ci"
                    >
                      {w.ci ? (
                        <>
                          <span
                            className={cn(
                              "size-1.5 rounded-full",
                              CI_TONE[w.ci] ?? "bg-muted-foreground/40",
                            )}
                          />
                          {CI_LABEL[w.ci] ?? `CI ${w.ci}`}
                        </>
                      ) : null}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-1.5" data-testid="projects__subscriptions">
        <Heading>Recent wake-ups</Heading>
        {wakeups.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="projects__no-wakeups">
            Nothing has woken the coordinator yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {wakeups.slice(0, 8).map((w) => (
              <li
                key={`${w.subscriptionId}-${w.receivedAt}-${w.summary}`}
                data-testid="projects__wakeup"
                data-state={w.droppedReason ? "dropped" : w.deliveredAt ? "delivered" : "waiting"}
                className="text-xs"
              >
                <span className="text-muted-foreground">
                  {ago(w.receivedAt)}
                  {w.droppedReason
                    ? ` · dropped (${w.droppedReason})`
                    : w.deliveredAt
                      ? ""
                      : " · waiting"}
                </span>
                <p className="line-clamp-2" title={w.summary}>
                  {wakeupText(w.summary)}
                </p>
              </li>
            ))}
          </ul>
        )}
        {(subs.data?.subscriptions ?? []).length > 0 ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              What wakes the coordinator
            </summary>
            <ul className="mt-1.5 space-y-1">
              {(subs.data?.subscriptions ?? []).map((s) => (
                <li
                  key={s.id}
                  data-testid="projects__subscription"
                  data-kind={s.kind}
                  className="flex justify-between gap-2"
                >
                  <span className="truncate" title={s.filterKey}>
                    {subscriptionLabel(s)}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {s.wakeups}/{s.maxWakeups}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <ErrorLine message={error} />
    </div>
  );
}

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="px-2 py-2">
      <div className="text-sm font-medium tabular-nums" data-testid={testId}>
        {value}
      </div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function CoordinatorCard({
  project,
  agent,
  canEdit,
  onStart,
  onStop,
  onOpenCharter,
}: {
  project: Project;
  agent: Agent | undefined;
  canEdit: boolean;
  onStart: () => void;
  onStop: (chatId: string) => void;
  onOpenCharter: () => void;
}) {
  const coordinator = project.coordinator;
  const running = agent?.status === "running";
  return (
    <section
      className="space-y-2 rounded-lg border p-3"
      data-testid="projects__coordinator"
      data-state={coordinator ? "started" : "not-started"}
    >
      <div
        className="flex items-center gap-2"
        {...(agent
          ? {
              "data-testid": "dashboard__agent",
              "data-chat": agent.chatId,
              "data-role": "coordinator",
              "data-status": agent.status,
            }
          : {})}
      >
        <StatusDot running={running} />
        <span className="text-sm font-medium">Coordinator</span>
        <span
          className="ml-auto text-xs text-muted-foreground"
          data-testid="projects__coordinator-chat"
          data-chat={coordinator?.chatId}
        >
          {!coordinator ? "Not started" : running ? "Working" : "Idle"}
        </span>
        {canEdit && agent && running ? (
          <Button
            size="xs"
            variant="outline"
            data-testid="dashboard__agent-stop"
            onClick={() => onStop(agent.chatId)}
          >
            Stop
          </Button>
        ) : null}
      </div>
      {coordinator ? (
        <p className="text-xs text-muted-foreground">
          {[
            agent?.agent,
            agent?.model,
            `on ${coordinator.hostId ?? "the hub"}`,
            agent && agent.spendUsd > 0 ? usd(agent.spendUsd) : null,
            agent?.lastActivityAt ? `active ${ago(agent.lastActivityAt)}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="projects__coordinator-none">
          {project.repos.length === 0
            ? "It starts once the project has a repo."
            : "Start it to plan and dispatch work across the project's repos."}
        </p>
      )}
      {project.coordinatorError ? (
        <p
          role="alert"
          data-testid="projects__coordinator-error"
          className="text-xs text-destructive"
        >
          {project.coordinatorError}
        </p>
      ) : null}
      {project.context?.syncError ? (
        <p className="text-xs text-destructive" data-testid="project-page__sync-error">
          {project.context.syncError}
        </p>
      ) : null}
      <div className="flex gap-2">
        {canEdit && !coordinator && project.repos.length > 0 ? (
          <Button size="sm" data-testid="projects__coordinator-start" onClick={onStart}>
            Start coordinator
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          className="-ml-2"
          data-testid="project-page__charter-open"
          onClick={onOpenCharter}
        >
          View charter
        </Button>
      </div>
    </section>
  );
}

function AgentRow({
  agent,
  canEdit,
  onOpen,
  onStop,
}: {
  agent: Agent;
  canEdit: boolean;
  onOpen?: () => void;
  onStop: () => void;
}) {
  const running = agent.status === "running";
  return (
    <li
      className="flex items-center gap-2 px-3 py-2"
      data-testid="dashboard__agent"
      data-chat={agent.chatId}
      data-role={agent.role}
      data-status={agent.status}
    >
      <StatusDot running={running} />
      <button
        type="button"
        className="min-w-0 flex-1 text-left disabled:cursor-default"
        disabled={!onOpen}
        data-testid="dashboard__agent-open"
        onClick={onOpen}
      >
        <span className="block truncate text-sm">
          {agent.branch ?? (agent.name === "Chat" ? "Project chat" : agent.name)}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {[
            agent.repo ?? "project folder",
            agent.model,
            agent.spendUsd > 0 ? usd(agent.spendUsd) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </button>
      <span
        className="shrink-0 text-xs text-muted-foreground"
        data-testid="dashboard__agent-status"
      >
        {running ? "Working" : "Idle"}
      </span>
      {canEdit && running ? (
        <Button size="xs" variant="outline" data-testid="dashboard__agent-stop" onClick={onStop}>
          Stop
        </Button>
      ) : null}
    </li>
  );
}
