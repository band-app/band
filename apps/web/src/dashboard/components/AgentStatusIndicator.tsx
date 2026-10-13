import { Tooltip, TooltipContent, TooltipTrigger } from "@band-app/ui";
import { GitBranch } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentInfo, AgentStatusType, TabAgentStatus } from "../types";

/** A status that gets a mark. `idle` shows the fallback icon instead. */
export type ActiveAgentStatus = Exclude<AgentStatusType, "idle">;

/** What each state is called for screen readers and what its tooltip says. */
export const AGENT_STATE_INFO: Record<ActiveAgentStatus, { label: string; tooltip: string }> = {
  working: { label: "Agent running", tooltip: "Agent running..." },
  monitoring: { label: "Monitoring", tooltip: "Loop or background task running" },
  question: { label: "Waiting for your answer", tooltip: "Waiting for your answer" },
  done: { label: "Finished", tooltip: "Finished" },
  failed: { label: "Failed", tooltip: "Failed" },
};

export function isActiveAgentStatus(status: AgentStatusType): status is ActiveAgentStatus {
  return status in AGENT_STATE_INFO;
}

interface DotProps {
  status: ActiveAgentStatus;
  testId?: string;
  /** Adds a native tooltip, for places without a Tooltip wrapper (the tab strip). */
  withTitle?: boolean;
}

/**
 * The mark for one agent state, drawn the same in the sidebar, the tab strip
 * and the worktree picker. `working` is a solid yellow dot, `monitoring` a
 * yellow ring that pulses slowly, `question` an amber "?", `done` a solid
 * green dot and `failed` a solid red dot.
 */
export function AgentStateDot({ status, testId, withTitle }: DotProps) {
  const common = {
    role: "img" as const,
    "aria-label": AGENT_STATE_INFO[status].label,
    "data-testid": testId,
    "data-status": status,
    title: withTitle ? AGENT_STATE_INFO[status].tooltip : undefined,
  };
  switch (status) {
    case "working":
      return (
        <span {...common} className="inline-block size-2 shrink-0 rounded-full bg-status-working" />
      );
    case "monitoring":
      return (
        <span
          {...common}
          className="inline-block size-2 shrink-0 rounded-full border-[1.5px] border-status-working animate-status-pulse-slow"
        />
      );
    case "question":
      return (
        <span
          {...common}
          className="inline-flex size-3 shrink-0 animate-status-pulse items-center justify-center rounded-full bg-status-question text-[9px] font-bold leading-none text-black"
        >
          ?
        </span>
      );
    case "done":
      return (
        <span {...common} className="inline-block size-2 shrink-0 rounded-full bg-status-done" />
      );
    case "failed":
      return (
        <span {...common} className="inline-block size-2 shrink-0 rounded-full bg-status-failed" />
      );
  }
}

/** "Chat 2: question, Terminal 1: working", numbering each kind in list order. */
export function describeTabStatuses(tabs: TabAgentStatus[] | undefined): string {
  let chats = 0;
  let terminals = 0;
  const parts: string[] = [];
  for (const t of tabs ?? []) {
    if (t.chatId) parts.push(`Chat ${++chats}: ${t.status}`);
    else if (t.terminalId) parts.push(`Terminal ${++terminals}: ${t.status}`);
  }
  return parts.join(", ");
}

interface Props {
  agent?: AgentInfo;
  /** The worktree's chats and terminals with their own states, listed in the tooltip. */
  tabStatuses?: TabAgentStatus[];
  isActive?: boolean;
  // Icon shown when the agent is idle. Non-root cards fall back to the branch
  // glyph (the default); the root card passes its house icon so the status dot
  // occupies the same slot — replacing the identity icon rather than sitting
  // beside it.
  fallback?: ReactNode;
}

export function AgentStatusIndicator({ agent, tabStatuses, isActive, fallback }: Props) {
  if (!agent || !isActiveAgentStatus(agent.status)) {
    return (
      fallback ?? (
        <GitBranch
          className={`size-3 shrink-0 ${isActive ? "text-primary" : "text-muted-foreground"}`}
        />
      )
    );
  }

  const tabsText = describeTabStatuses(tabStatuses);
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <span
          className="inline-flex shrink-0 items-center"
          data-testid="worktree-card__agent-status"
          data-status={agent.status}
        >
          <AgentStateDot status={agent.status} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" data-testid="worktree-card__agent-status-tooltip">
        {tabsText || AGENT_STATE_INFO[agent.status].tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
