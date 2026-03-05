import { basename, extname } from "node:path";
import { watch } from "chokidar";
import { loadCurrentStatuses, loadStatusFile, statusDir, type WorkspaceStatus } from "./state";

export interface StatusEvent {
  kind: "update" | "remove" | "snapshot";
  status?: WorkspaceStatus;
  statuses?: WorkspaceStatus[];
  workspaceId?: string;
}

type StatusListener = (event: StatusEvent) => void;

const listeners: Set<StatusListener> = new Set();
let watcher: ReturnType<typeof watch> | null = null;

function startWatcher() {
  if (watcher) return;

  const dir = statusDir();
  watcher = watch(dir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  watcher.on("add", handleFileChange);
  watcher.on("change", handleFileChange);
  watcher.on("unlink", handleFileRemove);
}

async function handleFileChange(filePath: string) {
  if (extname(filePath) !== ".json") return;
  const name = basename(filePath, ".json");
  if (name === "active") return; // Skip active workspace marker

  const status = await loadStatusFile(filePath);
  if (status) {
    emit({ kind: "update", status });
  }
}

function handleFileRemove(filePath: string) {
  if (extname(filePath) !== ".json") return;
  const workspaceId = basename(filePath, ".json");
  if (workspaceId === "active") return;
  emit({ kind: "remove", workspaceId });
}

function emit(event: StatusEvent) {
  for (const listener of listeners) {
    listener(event);
  }
}

export function subscribe(listener: StatusListener): () => void {
  listeners.add(listener);
  startWatcher();

  // Send current snapshot
  const statuses = loadCurrentStatuses();
  if (statuses.length > 0) {
    listener({ kind: "snapshot", statuses });
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && watcher) {
      watcher.close();
      watcher = null;
    }
  };
}
