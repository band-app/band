import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { watch } from "chokidar";
import { startBranchStatusPoller, stopBranchStatusPoller } from "./branch-status-poller";
import { getLoop, type LoopInfo } from "./loop-runner";
import { getRunningSetups } from "./setup-runner";
import {
  bandHome,
  loadCurrentStatuses,
  loadStatusFile,
  statusDir,
  type WorkspaceStatus,
} from "./state";

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

export interface LoopStatusInfo {
  loopId: string;
  currentIteration: number;
  maxIterations: number;
  status: "running" | "paused" | "completed" | "failed" | "stopped";
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
    | "loop-status";
  status?: WorkspaceStatus;
  statuses?: WorkspaceStatus[];
  workspaceId?: string;
  git?: GitStatus;
  ci?: CIStatus;
  url?: string;
  error?: string;
  setupState?: "running" | "completed" | "failed";
  setupError?: string;
  loopStatus?: LoopStatusInfo;
}

type StatusListener = (event: StatusEvent) => void;

const listeners: Set<StatusListener> = new Set();
let agentWatcher: ReturnType<typeof watch> | null = null;
let branchWatcher: ReturnType<typeof watch> | null = null;

function branchStatusDir(): string {
  return join(bandHome(), "branch-status");
}

function startWatchers() {
  if (!agentWatcher) {
    const dir = statusDir();
    agentWatcher = watch(dir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });

    agentWatcher.on("add", handleAgentFileChange);
    agentWatcher.on("change", handleAgentFileChange);
    agentWatcher.on("unlink", handleAgentFileRemove);
  }

  if (!branchWatcher) {
    const dir = branchStatusDir();
    branchWatcher = watch(dir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });

    branchWatcher.on("add", handleBranchFileChange);
    branchWatcher.on("change", handleBranchFileChange);
  }
}

async function handleAgentFileChange(filePath: string) {
  if (extname(filePath) !== ".json") return;
  const name = basename(filePath, ".json");
  if (name === "active") return; // Skip active workspace marker

  const status = await loadStatusFile(filePath);
  if (status) {
    emit({ kind: "update", status });
  }
}

function handleAgentFileRemove(filePath: string) {
  if (extname(filePath) !== ".json") return;
  const workspaceId = basename(filePath, ".json");
  if (workspaceId === "active") return;
  emit({ kind: "remove", workspaceId });
}

function handleBranchFileChange(filePath: string) {
  if (extname(filePath) !== ".json") return;
  try {
    const data = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(data) as { workspaceId: string; git: GitStatus; ci: CIStatus };
    emit({
      kind: "branch-status",
      workspaceId: parsed.workspaceId,
      git: parsed.git,
      ci: parsed.ci,
    });
  } catch {
    // Skip invalid files
  }
}

function loadCurrentBranchStatuses(): StatusEvent[] {
  const dir = branchStatusDir();
  const events: StatusEvent[] = [];
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = readFileSync(join(dir, file), "utf-8");
        const parsed = JSON.parse(data) as { workspaceId: string; git: GitStatus; ci: CIStatus };
        events.push({
          kind: "branch-status",
          workspaceId: parsed.workspaceId,
          git: parsed.git,
          ci: parsed.ci,
        });
      } catch {
        // Skip invalid files
      }
    }
  } catch {
    // Dir may not exist
  }
  return events;
}

export function emit(event: StatusEvent) {
  for (const listener of listeners) {
    listener(event);
  }
}

export function subscribe(listener: StatusListener): () => void {
  listeners.add(listener);
  startWatchers();
  startBranchStatusPoller();

  // Send current agent status snapshot
  const statuses = loadCurrentStatuses();
  if (statuses.length > 0) {
    listener({ kind: "snapshot", statuses });
  }

  // Send current branch status snapshots
  for (const event of loadCurrentBranchStatuses()) {
    listener(event);
  }

  // Send current setup status snapshots
  for (const workspaceId of getRunningSetups()) {
    listener({ kind: "setup-status", workspaceId, setupState: "running" });
  }

  // Send current loop status snapshots
  for (const status of statuses) {
    const loop = getLoop(status.workspaceId);
    if (loop && (loop.status === "running" || loop.status === "paused")) {
      listener({
        kind: "loop-status",
        workspaceId: status.workspaceId,
        loopStatus: {
          loopId: loop.id,
          currentIteration: loop.currentIteration,
          maxIterations: loop.maxIterations,
          status: loop.status,
        },
      });
    }
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopBranchStatusPoller();
      if (agentWatcher) {
        agentWatcher.close();
        agentWatcher = null;
      }
      if (branchWatcher) {
        branchWatcher.close();
        branchWatcher = null;
      }
    }
  };
}
