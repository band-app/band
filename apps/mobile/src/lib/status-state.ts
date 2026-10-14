/**
 * The agent and branch status of every worktree, built from the hub's `status.stream` events.
 * The reducer is pure: `applyStatusEvent` returns a new state and never mutates the old one.
 * The event shapes follow the hub's `StatusEvent` (apps/hub/src/server/infra/events).
 */

export interface AgentStatusLike {
  status: string;
  /** When the agent last did something (an ISO timestamp), as the web card shows its age. */
  lastActivity?: string;
  summary?: string;
}

export interface TabStatusLike {
  /** Set for a chat's agent; a terminal's agent has `terminalId` instead. */
  chatId?: string;
  status: string;
}

export interface WorktreeStatusLike {
  worktreeId: string;
  agent?: AgentStatusLike;
  tabStatuses?: TabStatusLike[];
}

export interface GitStatusLike {
  dirty: boolean;
  conflict: boolean;
  ahead: number;
  behind: number;
}

export interface PullRequestLike {
  number: number;
  title: string;
  url: string;
  state: "open" | "merged" | "closed";
  isDraft: boolean;
}

export interface CiStatusLike {
  state: string;
  url?: string | null;
  pr?: PullRequestLike | null;
}

export interface BranchStatusLike {
  git?: GitStatusLike;
  ci?: CiStatusLike;
}

export interface StatusState {
  agents: ReadonlyMap<string, WorktreeStatusLike>;
  branches: ReadonlyMap<string, BranchStatusLike>;
}

/** One event of `status.stream`. Kinds this app does not use (setup-status, ...) are ignored. */
export interface StatusEvent {
  kind: string;
  /** Other events carry fields this app does not read (client-state-changed, setup-status). */
  [field: string]: unknown;
  worktreeId?: string;
  statuses?: WorktreeStatusLike[];
  status?: WorktreeStatusLike;
  git?: GitStatusLike;
  ci?: CiStatusLike;
}

export function emptyStatusState(): StatusState {
  return { agents: new Map(), branches: new Map() };
}

export function applyStatusEvent(state: StatusState, event: StatusEvent): StatusState {
  switch (event.kind) {
    case "snapshot": {
      // The branch statuses follow the snapshot as their own events, so start them empty: a
      // worktree removed while the stream was down sends no `remove`.
      const agents = new Map<string, WorktreeStatusLike>();
      for (const status of event.statuses ?? []) agents.set(status.worktreeId, status);
      return { agents, branches: new Map() };
    }
    case "update": {
      if (!event.status) return state;
      const agents = new Map(state.agents);
      agents.set(event.status.worktreeId, event.status);
      return { agents, branches: state.branches };
    }
    case "remove": {
      if (!event.worktreeId) return state;
      const agents = new Map(state.agents);
      const branches = new Map(state.branches);
      agents.delete(event.worktreeId);
      branches.delete(event.worktreeId);
      return { agents, branches };
    }
    case "branch-status": {
      if (!event.worktreeId) return state;
      const branches = new Map(state.branches);
      branches.set(event.worktreeId, { git: event.git, ci: event.ci });
      return { agents: state.agents, branches };
    }
    default:
      return state;
  }
}

/** `running`: an agent is working. `attention`: one waits for the user. `idle`: neither. */
export type AgentState = "running" | "attention" | "idle";

/** Hub statuses that wait for the user: a question, a finished turn or a failed one. */
function isAttention(status: string | undefined): boolean {
  return (
    status === "question" || status === "done" || status === "failed" || status === "needs_attention"
  );
}

/** Hub statuses that mean an agent is busy, or watching background work. */
function isRunning(status: string | undefined): boolean {
  return status === "working" || status === "monitoring";
}

export function agentStateOf(status: WorktreeStatusLike | undefined): AgentState {
  if (!status) return "idle";
  const all = [status.agent?.status, ...(status.tabStatuses ?? []).map((t) => t.status)];
  if (all.some(isAttention)) return "attention";
  if (all.some(isRunning)) return "running";
  return "idle";
}

/**
 * What an agent's icon shows. The names are the design's (`.am/refs/design-demo.html`) and the
 * hub's own (`AgentHookStatus`). This function is the one place that maps a hub status to an
 * icon. An older hub reports `needs_attention` and `waiting`, which map to question or done and
 * to idle.
 */
export type ShownState = "working" | "monitoring" | "question" | "done" | "failed" | "idle";

export interface ShownStateInput {
  /** The hub's status for the agent. */
  status: string | undefined;
  /**
   * Only for an older hub's `needs_attention`: whether the agent waits on a permission or a
   * question. `undefined` counts as a question because that is the case that needs the user.
   */
  pending?: boolean;
  /** Only for an older hub's `needs_attention`: the chat's last turn failed. */
  failed?: boolean;
}

export function shownState({ status, pending, failed }: ShownStateInput): ShownState {
  switch (status) {
    case "working":
    case "monitoring":
    case "question":
    case "done":
    case "failed":
      return status;
    case "needs_attention":
      if (failed) return "failed";
      return pending === false ? "done" : "question";
    default:
      return "idle";
  }
}

/** The most urgent of an agent's and its tabs' states, the one a worktree's icon shows. */
const URGENCY: ShownState[] = ["question", "failed", "done", "working", "monitoring", "idle"];

export function shownStateOf(status: WorktreeStatusLike | undefined): ShownState {
  if (!status) return "idle";
  const states = [status.agent?.status, ...(status.tabStatuses ?? []).map((t) => t.status)].map(
    (s) => shownState({ status: s }),
  );
  return URGENCY.find((u) => states.includes(u)) ?? "idle";
}

/** "now", "3 m", "2 h" or "5 d" since `iso`; null when there is no usable timestamp. */
export function ageLabel(when: string | number | undefined | null, now: number): string | null {
  if (when === undefined || when === null || when === "") return null;
  const then = typeof when === "number" ? when : Date.parse(when);
  if (Number.isNaN(then)) return null;
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}
