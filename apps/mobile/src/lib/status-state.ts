/**
 * The agent and branch status of every worktree, built from the hub's `status.stream` events.
 * The reducer is pure: `applyStatusEvent` returns a new state and never mutates the old one.
 * The event shapes follow the hub's `StatusEvent` (apps/hub/src/server/infra/events).
 */

export interface AgentStatusLike {
  status: string;
}

export interface TabStatusLike {
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

export function agentStateOf(status: WorktreeStatusLike | undefined): AgentState {
  if (!status) return "idle";
  const tabs = status.tabStatuses ?? [];
  if (
    status.agent?.status === "needs_attention" ||
    tabs.some((t) => t.status === "needs_attention")
  ) {
    return "attention";
  }
  if (status.agent?.status === "working" || tabs.some((t) => t.status === "working")) {
    return "running";
  }
  return "idle";
}
