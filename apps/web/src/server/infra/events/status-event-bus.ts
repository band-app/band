/**
 * Process-wide pub/sub for workspace-status events (issue #535,
 * follow-up 2).
 *
 * Lives in the Infra tier so the lower-level adapters that produce these
 * events (e.g. `infra/tunnels/tunnel-client.ts` emitting `tunnel-url` /
 * `tunnel-error`) can publish without reaching back into the services
 * tier. The services-tier façade in `services/watcher.ts` re-exports
 * `emit` and `StatusEvent`, layers the on-connect snapshot logic on top
 * of `subscribe`, and is what the API tier and other services consume.
 *
 * The bus deliberately holds no state beyond the listener set — every
 * status snapshot (current workspace statuses, branch statuses, running
 * setups) is recomputed in `services/watcher.ts` at subscribe time from
 * the database.
 */

/**
 * Per-workspace agent info embedded in a `WorkspaceStatusSnapshot`. The
 * canonical shape originally lived in `services/state.ts::AgentInfo`;
 * declared here so the infra event bus has no upward dependency on the
 * services tier. `services/state.ts` re-exports a `WorkspaceStatus` type
 * with the same shape for ergonomics.
 */
export interface WorkspaceAgentInfo {
  name: string;
  status: string;
  lastActivity: string;
  summary?: string;
  codingAgentId?: string;
}

/**
 * Workspace-status snapshot used inside `StatusEvent`. Mirrors the legacy
 * `WorkspaceStatus` shape that `services/watcher.ts` historically owned;
 * extracted here so the infra producers (tunnel-client and any future
 * infra-level emitter) can construct events without crossing into the
 * services tier.
 */
export interface WorkspaceStatusSnapshot {
  workspaceId: string;
  project: string;
  branch: string;
  worktreePath: string;
  agent?: WorkspaceAgentInfo;
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
    | "open-file";
  status?: WorkspaceStatusSnapshot;
  statuses?: WorkspaceStatusSnapshot[];
  workspaceId?: string;
  git?: GitStatus;
  ci?: CIStatus;
  url?: string;
  error?: string;
  setupState?: "running" | "completed" | "failed";
  setupError?: string;
  runningSetups?: string[];
  browserId?: string;
  terminalId?: string;
  chatId?: string;
  /**
   * For `kind: "open-file"`: workspace-relative file path with optional
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
   * resolved workspace's root. When true, `filePath` carries an
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
 * want the on-connect snapshot (current workspace statuses, branch
 * statuses, running setups) should go through
 * `services/watcher.ts::subscribe` instead — it wraps this with the
 * snapshot replay and the branch-status poller lifecycle.
 */
export function subscribe(listener: StatusListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Number of currently registered listeners. Used by `services/watcher.ts`
 *  to start/stop the branch-status poller. */
export function listenerCount(): number {
  return listeners.size;
}
