import { startBranchStatusPoller, stopBranchStatusPoller } from "./branch-status-poller";
import { getDb } from "./db/connection";
import { branchStatuses as branchStatusesTable } from "./db/schema";
import { getRunningSetups } from "./setup-runner";
import { loadCurrentStatuses, type WorkspaceStatus } from "./state";

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
  status?: WorkspaceStatus;
  statuses?: WorkspaceStatus[];
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

type StatusListener = (event: StatusEvent) => void;

const listeners: Set<StatusListener> = new Set();

function loadCurrentBranchStatuses(): StatusEvent[] {
  const db = getDb();
  const rows = db.select().from(branchStatusesTable).all();
  return rows.map((row) => ({
    kind: "branch-status" as const,
    workspaceId: row.workspaceId,
    git: {
      dirty: row.gitDirty,
      conflict: row.gitConflict,
      ahead: row.gitAhead,
      behind: row.gitBehind,
      sync_state: row.gitSyncState,
    },
    ci: {
      state: row.ciState,
      url: row.ciUrl,
    },
  }));
}

export function emit(event: StatusEvent) {
  for (const listener of listeners) {
    listener(event);
  }
}

export function subscribe(listener: StatusListener): () => void {
  listeners.add(listener);
  startBranchStatusPoller();

  // Send current agent status snapshot (always include runningSetups for reconciliation)
  const statuses = loadCurrentStatuses();
  const runningSetups = getRunningSetups();
  listener({ kind: "snapshot", statuses, runningSetups });

  // Send current branch status snapshots
  for (const event of loadCurrentBranchStatuses()) {
    listener(event);
  }

  // Send current setup status snapshots
  for (const workspaceId of getRunningSetups()) {
    listener({ kind: "setup-status", workspaceId, setupState: "running" });
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopBranchStatusPoller();
    }
  };
}
