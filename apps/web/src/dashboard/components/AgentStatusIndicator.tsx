import { Tooltip, TooltipContent, TooltipTrigger } from "@band-app/ui";
import type { AgentInfo, AgentStatusType, TabAgentStatus } from "../types";

/** A status that gets a mark. `idle` is drawn only by `AgentStatusIndicator`. */
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
          className="inline-block size-2 shrink-0 rounded-full border-2 border-status-working animate-status-pulse-slow"
        />
      );
    case "question":
      return (
        <span
          {...common}
          className="inline-flex size-3 shrink-0 animate-status-pulse items-center justify-center rounded-full bg-status-question text-[9px] font-bold leading-none text-status-foreground"
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
  /** Marked unread by a person: an idle row shows the unread dot instead of the faint one. */
  unread?: boolean;
  /** Makes the dot a button that marks the worktree read or unread. */
  onToggleUnread?: () => void;
}

const IDLE_LABEL = "No agent activity";
const UNREAD_LABEL = "Unread";

/** True when the worktree has something to read: a manual mark or a finished or failed turn. */
export function hasUnreadMark(unread: boolean | undefined, status: AgentStatusType): boolean {
  return unread === true || status === "done" || status === "failed";
}

/** The semantic done color marks unread work, the same as a finished turn. */
function UnreadDot() {
  return (
    <span
      role="img"
      aria-label={UNREAD_LABEL}
      className="inline-block size-2 shrink-0 rounded-full bg-status-done"
    />
  );
}

/**
 * The left slot of a worktree row: the agent's state mark, the unread dot, or a faint solid dot
 * when there is no activity. An agent state shows over the unread mark, so a row has one dot.
 * With `onToggleUnread` the dot is a button, and its name says what a click does.
 */
export function AgentStatusIndicator({ agent, tabStatuses, unread, onToggleUnread }: Props) {
  const status: AgentStatusType = agent?.status ?? "idle";
  const tabsText = describeTabStatuses(tabStatuses);
  const active = isActiveAgentStatus(status);
  const showUnread = unread === true && !active;
  const dataStatus = showUnread ? "unread" : status;
  const dot = active ? (
    <AgentStateDot status={status} />
  ) : showUnread ? (
    <UnreadDot />
  ) : (
    <span
      role="img"
      aria-label={IDLE_LABEL}
      title={tabsText || IDLE_LABEL}
      className="inline-block size-2 shrink-0 rounded-full bg-muted-foreground/40"
    />
  );
  const content = onToggleUnread ? (
    <button
      type="button"
      // Keyboard users reach the same action in the card menu, so the dot adds no tab stop.
      tabIndex={-1}
      data-testid="worktree-card__unread-toggle"
      aria-label={hasUnreadMark(unread, status) ? "Mark as read" : "Mark as unread"}
      className="-m-1 inline-flex shrink-0 cursor-pointer items-center rounded-full p-1"
      onClick={(e) => {
        e.stopPropagation();
        onToggleUnread();
      }}
    >
      {dot}
    </button>
  ) : (
    dot
  );
  const slot = (
    <span
      className="inline-flex shrink-0 items-center"
      data-testid="worktree-card__agent-status"
      data-status={dataStatus}
    >
      {content}
    </span>
  );
  // Idle rows are the common case in long lists, so they skip the Tooltip.
  if (!active) return slot;
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>{slot}</TooltipTrigger>
      <TooltipContent side="top" data-testid="worktree-card__agent-status-tooltip">
        {tabsText || AGENT_STATE_INFO[status].tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
