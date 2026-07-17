import { type ChildProcess, spawn } from "node:child_process";
import { emit } from "../events/status-event-bus";
import { prependBinDirs, shellCommandInvocation } from "../process/path";
import { loadProjectConfig } from "./project-config";

/**
 * Per-workspace `.band/config.json::setup` runner.
 *
 * Lives in the infra tier — it's a process pool that shells out to
 * `bash -c <setup command>` for the workspace lifecycle. Higher tiers
 * (`WorkspaceService.create` and the watcher snapshot) consume it via
 * its function exports.
 *
 * Moved here from `services/setup-runner.ts` (issue #535, follow-up 3)
 * so the `node:child_process` shell-out lives behind an infra adapter
 * instead of inside the services tier.
 */

interface SetupInfo {
  workspaceId: string;
  process: ChildProcess;
  startedAt: number;
}

const setups = new Map<string, SetupInfo>();

export function getRunningSetups(): string[] {
  return Array.from(setups.keys());
}

export function runSetup(
  workspaceId: string,
  worktreePath: string,
  projectPath: string,
  onComplete?: () => void,
): void {
  // Guard against concurrent setups on same workspace
  if (setups.has(workspaceId)) return;

  const config = loadProjectConfig(worktreePath, projectPath);
  const setupCommand = typeof config?.setup === "string" ? config.setup : undefined;

  if (!setupCommand) {
    onComplete?.();
    return;
  }

  const { PORT: _port, ...parentEnv } = process.env;
  // `bash -c <cmd>` on POSIX, `cmd.exe /d /s /c <cmd>` on Windows — a
  // stock Windows host has no bash, so route the command through the
  // platform shell rather than ENOENT on a missing `bash`.
  const { file, args } = shellCommandInvocation(setupCommand);
  const child = spawn(file, args, {
    cwd: worktreePath,
    env: {
      ...parentEnv,
      PATH: prependBinDirs(process.env.PATH),
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
