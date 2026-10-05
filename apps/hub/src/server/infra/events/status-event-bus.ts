/**
 * Process-wide pub/sub for worktree-status events (issue #535,
 * follow-up 2).
 *
 * Lives in the Infra tier so the lower-level adapters that produce these
 * events (e.g. `infra/tunnels/tunnel-client.ts` emitting `tunnel-url` /
 * `tunnel-error`) can publish without reaching back into the services
 * tier. The services-tier façade in `services/watcher-service.ts` re-exports
 * `emit` and `StatusEvent`, layers the on-connect snapshot logic on top
 * of `subscribe`, and is what the API tier and other services consume.
 *
 * The bus deliberately holds no state beyond the listener set — every
 * status snapshot (current worktree statuses, branch statuses, running
 * setups) is recomputed in `services/watcher-service.ts` at subscribe time from
 * the database.
 */

import type { PullRequestSummary } from "@band-app/host-local/git/git-client";
import type { AgentSessionRecord } from "@band-app/shared/agent-sessions";
import type { ClientStateEntry } from "@band-app/shared/client-state";

/**
 * Per-worktree agent info embedded in a `WorktreeStatusSnapshot`. The
 * canonical shape originally lived in `services/state.ts::AgentInfo`;
 * declared here so the infra event bus has no upward dependency on the
 * services tier. `services/state.ts` re-exports a `WorktreeStatus` type
 * with the same shape for ergonomics.
 */
export interface WorktreeAgentInfo {
  name: string;
  status: string;
  lastActivity: string;
  summary?: string;
  codingAgentId?: string;
}

/**
 * Worktree-status snapshot used inside `StatusEvent`. Mirrors the legacy
 * `WorktreeStatus` shape that `services/watcher-service.ts` historically owned;
 * extracted here so the infra producers (tunnel-client and any future
 * infra-level emitter) can construct events without crossing into the
 * services tier.
 */
export interface WorktreeStatusSnapshot {
  worktreeId: string;
  repo: string;
  branch: string;
  worktreePath: string;
  agent?: WorktreeAgentInfo;
  /**
   * The chats and terminals in the worktree whose agent is `working` or
   * `needs_attention`, for the center tab strip. Absent where the snapshot
   * comes straight from the row (the repos list).
   */
  tabStatuses?: TabAgentStatus[];
}

/**
 * One chat's or terminal's agent status: a chat pane's ACP turn
 * (`chatId`), or a hook-reporting CLI session in a Band terminal
 * (`terminalId`).
 */
export interface TabAgentStatus {
  chatId?: string;
  terminalId?: string;
  status: "working" | "needs_attention";
}

interface GitStatus {
  dirty: boolean;
  conflict: boolean;
  ahead: number;
  behind: number;
  sync_state: string;
}

interface CIStatus {
  state: string;
  url?: string | null;
  pr?: PullRequestSummary | null;
}

export interface StatusEvent {
  kind:
    | "update"
    | "remove"
    | "snapshot"
    | "branch-status"
    | "tunnel-url"
    | "tunnel-error"
    | "setup-status"
    | "browser-created"
    | "browser-removed"
    | "terminal-created"
    | "terminal-killed"
    | "chat-created"
    | "chat-removed"
    | "agent-session-created"
    | "agent-session-updated"
    | "agent-session-ended"
    | "client-state-changed"
    | "host-status-changed"
    | "host-request-changed"
    | "subscription-created"
    | "subscription-delivered"
    | "subscription-removed"
    | "open-file";
  status?: WorktreeStatusSnapshot;
  statuses?: WorktreeStatusSnapshot[];
  worktreeId?: string;
  git?: GitStatus;
  ci?: CIStatus;
  url?: string;
  error?: string;
  setupState?: "running" | "completed" | "failed";
  setupError?: string;
  /** For `kind: "setup-status"`: which `.band/config.json` script the state is for. */
  script?: "setup" | "teardown";
  runningSetups?: string[];
  browserId?: string;
  terminalId?: string;
  chatId?: string;
  /** For the `agent-session-*` kinds: the session's current record (issue #682). */
  agentSession?: AgentSessionRecord;
  /** For the `subscription-*` kinds: the subscription the event is about. */
  subscriptionId?: string;
  /** For `kind: "subscription-delivered"`: how many events the message carried. */
  eventCount?: number;
  /** For `kind: "subscription-removed"`: why the subscription ended. */
  reason?: "expired" | "max-wakeups" | "removed" | "chat-removed" | "worktree-removed";
  /** For `kind: "host-status-changed"`: the host and its new status. */
  hostId?: string;
  hostStatus?: "online" | "offline" | "lost" | "disposed";
  /** For `kind: "host-request-changed"`: the request and its new status. */
  hostRequestId?: string;
  hostRequestStatus?: "pending" | "leased" | "fulfilled" | "failed" | "cancelled";
  /** For `kind: "client-state-changed"`: the entry as stored after the write. */
  clientState?: ClientStateEntry;
  /**
   * For `kind: "client-state-changed"`: the page instance that made the write,
   * so it can skip its own echo (it already has the result from the mutation).
   */
  clientId?: string;
  /**
   * For `kind: "open-file"`: worktree-relative file path with optional
   * line / column suffix in the standard `path:line[:column]` /
   * `path:line-lineEnd` notation. Parsed by the client via
   * `parseFileLocation` from `@/dashboard`. Backs the
   * `band open` CLI command — see `editorRouter.openFile`.
   */
  filePath?: string;
  /**
   * For `kind: "open-file"`: whether to bring the dashboard window to
   * the foreground in addition to navigating to the file. Defaults to
   * true. Wired through the desktop IPC bridge by the renderer; the
   * plain web build ignores the field.
   */
  focus?: boolean;
  /**
   * For `kind: "open-file"`: whether the file lives outside the
   * resolved worktree's root. When true, `filePath` carries an
   * absolute filesystem path and the renderer should open it as an
   * external tab (same surface as desktop Cmd+O / "Open File…").
   */
  external?: boolean;
}

export type StatusListener = (event: StatusEvent) => void;

const listeners: Set<StatusListener> = new Set();

/**
 * Publish a status event to every registered listener. Synchronous, fan-
 * out style: a slow listener delays the next caller, which is acceptable
 * because each listener's job is to push to an in-memory queue / WS write
 * buffer (none do I/O inline).
 */
export function emit(event: StatusEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}

/**
 * Register a raw listener. Returns an unsubscribe function. Callers that
 * want the on-connect snapshot (current worktree statuses, branch
 * statuses, running setups) should go through
 * `services/watcher-service.ts::subscribe` instead — it wraps this with the
 * snapshot replay and the branch-status poller lifecycle.
 */
export function subscribe(listener: StatusListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Number of currently registered listeners. Used by `services/watcher-service.ts`
 *  to start/stop the branch-status poller. */
export function listenerCount(): number {
  return listeners.size;
}
