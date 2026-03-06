import { readFileSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { watch } from "chokidar";
import { loadCurrentStatuses, loadStatusFile, statusDir, bandHome, type WorkspaceStatus } from "./state";

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
  kind: "update" | "remove" | "snapshot" | "branch-status";
  status?: WorkspaceStatus;
  statuses?: WorkspaceStatus[];
  workspaceId?: string;
  git?: GitStatus;
  ci?: CIStatus;
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

function emit(event: StatusEvent) {
  for (const listener of listeners) {
    listener(event);
  }
}

export function subscribe(listener: StatusListener): () => void {
  listeners.add(listener);
  startWatchers();

  // Send current agent status snapshot
  const statuses = loadCurrentStatuses();
  if (statuses.length > 0) {
    listener({ kind: "snapshot", statuses });
  }

  // Send current branch status snapshots
  for (const event of loadCurrentBranchStatuses()) {
    listener(event);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
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
