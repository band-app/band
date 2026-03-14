import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { emit } from "./watcher";

interface SetupInfo {
  workspaceId: string;
  process: ChildProcess;
  startedAt: number;
}

const setups = new Map<string, SetupInfo>();

export function getRunningSetups(): string[] {
  return Array.from(setups.keys());
}

export function runSetup(workspaceId: string, worktreePath: string, onComplete?: () => void): void {
  // Guard against concurrent setups on same workspace
  if (setups.has(workspaceId)) return;

  const configPath = join(worktreePath, ".band", "config.json");
  if (!existsSync(configPath)) {
    onComplete?.();
    return;
  }

  let setupCommand: string | undefined;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    setupCommand = config.setup;
  } catch {
    onComplete?.();
    return;
  }

  if (!setupCommand) {
    onComplete?.();
    return;
  }

  const child = spawn("bash", ["-c", setupCommand], {
    cwd: worktreePath,
    env: {
      ...process.env,
      PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const info: SetupInfo = {
    workspaceId,
    process: child,
    startedAt: Date.now(),
  };
  setups.set(workspaceId, info);

  emit({ kind: "setup-status", workspaceId, setupState: "running" });

  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
    // Keep only last 1KB of stderr for error reporting
    if (stderr.length > 1024) {
      stderr = stderr.slice(-1024);
    }
  });

  child.on("error", (err) => {
    setups.delete(workspaceId);
    emit({
      kind: "setup-status",
      workspaceId,
      setupState: "failed",
      setupError: err.message,
    });
  });

  child.on("exit", (code) => {
    setups.delete(workspaceId);
    if (code === 0) {
      emit({ kind: "setup-status", workspaceId, setupState: "completed" });
      onComplete?.();
    } else {
      const errorMsg = stderr.trim() || `Setup exited with code ${code}`;
      emit({
        kind: "setup-status",
        workspaceId,
        setupState: "failed",
        setupError: errorMsg,
      });
    }
  });
}
