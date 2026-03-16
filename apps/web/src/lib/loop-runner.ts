import { type ChildProcess, spawn } from "node:child_process";
import { createLogger } from "@band/logger";
import {
  generateIterationId,
  generateLoopId,
  type LoopIterationRecord,
  saveIteration,
  saveLoop,
} from "./loop-store";
import { shellPath } from "./process-utils";
import { loadSettings } from "./state";
import { emit as emitStatus } from "./watcher";
import { resolveWorkspace } from "./workspace";

const log = createLogger("loop-runner");

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type LoopEventType =
  | "loop-start"
  | "iteration-start"
  | "iteration-output"
  | "iteration-end"
  | "loop-paused"
  | "loop-resumed"
  | "loop-end";

export interface LoopEvent {
  type: LoopEventType;
  loopId: string;
  iteration?: number;
  data?: string;
  exitCode?: number;
  promiseDetected?: boolean;
  status?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LoopStatus = "running" | "paused" | "completed" | "failed" | "stopped";

export interface LoopInfo {
  id: string;
  workspaceId: string;
  prompt: string;
  completionPromise: string;
  maxIterations: number;
  currentIteration: number;
  status: LoopStatus;
  startedAt: number;
  completedAt?: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type LoopListener = (event: LoopEvent) => void;

interface InternalLoop extends LoopInfo {
  loopRecordId: string;
  events: LoopEvent[];
  expireTimer?: ReturnType<typeof setTimeout>;
  activeProcess?: ChildProcess;
  pauseRequested: boolean;
  stopRequested: boolean;
}

// ---------------------------------------------------------------------------
// Singleton state (globalThis symbol pattern — survives module reloading)
// ---------------------------------------------------------------------------

const LOOPS_KEY = Symbol.for("band.loop-runner.loops");
const LOOP_LISTENERS_KEY = Symbol.for("band.loop-runner.listeners");

const g = globalThis as unknown as Record<symbol, unknown>;
if (!g[LOOPS_KEY]) g[LOOPS_KEY] = new Map<string, InternalLoop>();
if (!g[LOOP_LISTENERS_KEY]) g[LOOP_LISTENERS_KEY] = new Map<string, Set<LoopListener>>();

const loopsMap = g[LOOPS_KEY] as Map<string, InternalLoop>;
const listeners = g[LOOP_LISTENERS_KEY] as Map<string, Set<LoopListener>>;

const BUFFER_EXPIRE_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_ITERATIONS = 25;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function persistLoop(loop: InternalLoop): void {
  const workspace = resolveWorkspace(loop.workspaceId);
  try {
    saveLoop({
      id: loop.loopRecordId,
      workspaceId: loop.workspaceId,
      project: workspace?.project.name ?? "",
      branch: workspace?.worktree.branch ?? "",
      prompt: loop.prompt,
      completionPromise: loop.completionPromise,
      maxIterations: loop.maxIterations,
      currentIteration: loop.currentIteration,
      status: loop.status,
      startedAt: loop.startedAt,
      completedAt: loop.completedAt,
    });
  } catch (err) {
    log.warn({ err, loopId: loop.loopRecordId }, "failed to persist loop");
  }
}

function broadcast(workspaceId: string, event: LoopEvent) {
  const subs = listeners.get(workspaceId);
  if (!subs) return;
  for (const listener of subs) {
    try {
      listener(event);
    } catch {
      // listener may have been removed
    }
  }
}

function emit(workspaceId: string, loop: InternalLoop, event: LoopEvent) {
  loop.events.push(event);
  broadcast(workspaceId, event);
  // Also broadcast through the shared status stream so the dashboard cards update
  emitLoopStatus(workspaceId, loop);
}

function emitLoopStatus(workspaceId: string, loop: InternalLoop) {
  emitStatus({
    kind: "loop-status",
    workspaceId,
    loopStatus: {
      loopId: loop.loopRecordId,
      currentIteration: loop.currentIteration,
      maxIterations: loop.maxIterations,
      status: loop.status,
    },
  });
}

function scheduleExpiry(workspaceId: string) {
  const loop = loopsMap.get(workspaceId);
  if (!loop) return;
  loop.expireTimer = setTimeout(() => {
    const current = loopsMap.get(workspaceId);
    if (current === loop && current.status !== "running" && current.status !== "paused") {
      loopsMap.delete(workspaceId);
    }
  }, BUFFER_EXPIRE_MS);
}

function toLoopInfo(loop: InternalLoop): LoopInfo {
  return {
    id: loop.loopRecordId,
    workspaceId: loop.workspaceId,
    prompt: loop.prompt,
    completionPromise: loop.completionPromise,
    maxIterations: loop.maxIterations,
    currentIteration: loop.currentIteration,
    status: loop.status,
    startedAt: loop.startedAt,
    completedAt: loop.completedAt,
  };
}

// ---------------------------------------------------------------------------
// Single iteration execution
// ---------------------------------------------------------------------------

interface IterationResult {
  exitCode: number;
  output: string;
  promiseDetected: boolean;
}

async function runIteration(
  workspaceId: string,
  loop: InternalLoop,
  worktreePath: string,
  resolvedPath: string,
): Promise<IterationResult> {
  const settings = loadSettings();
  const claudeCmd =
    (settings as Record<string, unknown>).codingAgent &&
    typeof (settings as Record<string, unknown>).codingAgent === "object"
      ? ((settings as Record<string, unknown>).codingAgent as Record<string, unknown>)?.command
      : undefined;
  const executable = (typeof claudeCmd === "string" && claudeCmd) || "claude";

  return new Promise((resolve) => {
    const child = spawn(executable, ["-p", loop.prompt, "--output-format", "text"], {
      cwd: worktreePath,
      env: {
        ...process.env,
        PATH: resolvedPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    loop.activeProcess = child;

    let stdout = "";

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      emit(workspaceId, loop, {
        type: "iteration-output",
        loopId: loop.loopRecordId,
        iteration: loop.currentIteration,
        data: text,
      });
    });

    child.stderr?.on("data", (data: Buffer) => {
      log.debug(
        { workspaceId, iteration: loop.currentIteration },
        `stderr: ${data.toString().slice(0, 500)}`,
      );
    });

    child.on("error", (err) => {
      log.error({ workspaceId, err }, "failed to spawn claude process");
      loop.activeProcess = undefined;
      resolve({ exitCode: 1, output: stdout, promiseDetected: false });
    });

    child.on("exit", (code) => {
      loop.activeProcess = undefined;
      const exitCode = code ?? 1;
      const promiseDetected = stdout.includes(loop.completionPromise);
      resolve({ exitCode, output: stdout, promiseDetected });
    });
  });
}

// ---------------------------------------------------------------------------
// Main loop execution
// ---------------------------------------------------------------------------

async function runLoop(workspaceId: string, loop: InternalLoop): Promise<void> {
  const workspace = resolveWorkspace(workspaceId);
  if (!workspace) {
    loop.status = "failed";
    loop.completedAt = Date.now();
    persistLoop(loop);
    emit(workspaceId, loop, {
      type: "loop-end",
      loopId: loop.loopRecordId,
      status: "failed",
      error: "Workspace not found",
    });
    scheduleExpiry(workspaceId);
    return;
  }

  const resolvedPath = await shellPath();

  emit(workspaceId, loop, {
    type: "loop-start",
    loopId: loop.loopRecordId,
  });

  while (loop.currentIteration < loop.maxIterations) {
    // Check for stop between iterations
    if (loop.stopRequested) {
      loop.status = "stopped";
      loop.completedAt = Date.now();
      persistLoop(loop);
      emit(workspaceId, loop, {
        type: "loop-end",
        loopId: loop.loopRecordId,
        status: "stopped",
      });
      break;
    }

    // Check for pause between iterations
    if (loop.pauseRequested) {
      loop.status = "paused";
      persistLoop(loop);
      emit(workspaceId, loop, {
        type: "loop-paused",
        loopId: loop.loopRecordId,
      });
      return; // Exit — resumeLoop() re-enters
    }

    loop.currentIteration++;
    const iteration = loop.currentIteration;
    persistLoop(loop);

    // Create iteration record
    const iterRecord: LoopIterationRecord = {
      id: generateIterationId(),
      loopId: loop.loopRecordId,
      iteration,
      status: "running",
      promiseDetected: false,
      startedAt: Date.now(),
    };
    saveIteration(iterRecord);

    emit(workspaceId, loop, {
      type: "iteration-start",
      loopId: loop.loopRecordId,
      iteration,
    });

    // Spawn claude -p
    const result = await runIteration(workspaceId, loop, workspace.worktree.path, resolvedPath);

    // Update iteration record
    iterRecord.status = result.exitCode === 0 ? "completed" : "failed";
    iterRecord.exitCode = result.exitCode;
    iterRecord.output = result.output;
    iterRecord.promiseDetected = result.promiseDetected;
    iterRecord.completedAt = Date.now();
    saveIteration(iterRecord);

    emit(workspaceId, loop, {
      type: "iteration-end",
      loopId: loop.loopRecordId,
      iteration,
      exitCode: result.exitCode,
      promiseDetected: result.promiseDetected,
    });

    persistLoop(loop);

    // Check completion promise
    if (result.promiseDetected) {
      loop.status = "completed";
      loop.completedAt = Date.now();
      persistLoop(loop);
      emit(workspaceId, loop, {
        type: "loop-end",
        loopId: loop.loopRecordId,
        status: "completed",
      });
      break;
    }

    // If iteration failed, stop the loop
    if (result.exitCode !== 0) {
      loop.status = "failed";
      loop.completedAt = Date.now();
      persistLoop(loop);
      emit(workspaceId, loop, {
        type: "loop-end",
        loopId: loop.loopRecordId,
        status: "failed",
        error: `Iteration ${iteration} exited with code ${result.exitCode}`,
      });
      break;
    }
  }

  // Max iterations reached without completion
  if (loop.status === "running") {
    loop.status = "completed";
    loop.completedAt = Date.now();
    persistLoop(loop);
    emit(workspaceId, loop, {
      type: "loop-end",
      loopId: loop.loopRecordId,
      status: "completed",
    });
  }

  scheduleExpiry(workspaceId);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function submitLoop(
  workspaceId: string,
  prompt: string,
  completionPromise: string,
  maxIterations?: number,
): LoopInfo {
  const workspace = resolveWorkspace(workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  // Check for running task — workspace can only have one active agent.
  // Access the task map via globalThis symbol to avoid circular dependency
  // with task-runner.ts (which checks for running loops from this module).
  const tasksMap = (globalThis as unknown as Record<symbol, unknown>)[
    Symbol.for("band.task-runner.tasks")
  ] as Map<string, { status: string }> | undefined;
  const existingTask = tasksMap?.get(workspaceId);
  if (existingTask?.status === "running") {
    throw new LoopConflictError(workspaceId);
  }

  // Check for running/paused loop
  const existing = loopsMap.get(workspaceId);
  if (existing && (existing.status === "running" || existing.status === "paused")) {
    throw new LoopConflictError(workspaceId);
  }

  // Clear any previous expiration timer
  if (existing?.expireTimer) {
    clearTimeout(existing.expireTimer);
  }

  const resolvedMax = maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const loopRecordId = generateLoopId();

  const loop: InternalLoop = {
    id: loopRecordId,
    workspaceId,
    prompt,
    completionPromise,
    maxIterations: resolvedMax,
    currentIteration: 0,
    status: "running",
    startedAt: Date.now(),
    loopRecordId,
    events: [],
    pauseRequested: false,
    stopRequested: false,
  };

  loopsMap.set(workspaceId, loop);
  persistLoop(loop);

  // Fire-and-forget async execution
  runLoop(workspaceId, loop).catch((err) => {
    log.error({ workspaceId, err }, "loop execution failed");
  });

  return toLoopInfo(loop);
}

export function pauseLoop(workspaceId: string): boolean {
  const loop = loopsMap.get(workspaceId);
  if (!loop || loop.status !== "running") return false;
  loop.pauseRequested = true;
  // Does not kill the current process — waits for current iteration to finish
  return true;
}

export function resumeLoop(workspaceId: string): boolean {
  const loop = loopsMap.get(workspaceId);
  if (!loop || loop.status !== "paused") return false;
  loop.status = "running";
  loop.pauseRequested = false;
  persistLoop(loop);
  emit(workspaceId, loop, {
    type: "loop-resumed",
    loopId: loop.loopRecordId,
  });
  // Re-enter the loop
  runLoop(workspaceId, loop).catch((err) => {
    log.error({ workspaceId, err }, "loop resume failed");
  });
  return true;
}

export function stopLoop(workspaceId: string): boolean {
  const loop = loopsMap.get(workspaceId);
  if (!loop || (loop.status !== "running" && loop.status !== "paused")) return false;
  loop.stopRequested = true;

  // Kill the active process if running
  if (loop.activeProcess) {
    loop.activeProcess.kill("SIGTERM");
  }

  // If paused, transition immediately
  if (loop.status === "paused") {
    loop.status = "stopped";
    loop.completedAt = Date.now();
    persistLoop(loop);
    emit(workspaceId, loop, {
      type: "loop-end",
      loopId: loop.loopRecordId,
      status: "stopped",
    });
    scheduleExpiry(workspaceId);
  }

  return true;
}

export function getLoop(workspaceId: string): LoopInfo | null {
  const loop = loopsMap.get(workspaceId);
  if (!loop) return null;
  return toLoopInfo(loop);
}

export function subscribe(workspaceId: string, listener: LoopListener): () => void {
  let subs = listeners.get(workspaceId);
  if (!subs) {
    subs = new Set();
    listeners.set(workspaceId, subs);
  }
  subs.add(listener);

  return () => {
    subs.delete(listener);
    if (subs.size === 0) {
      listeners.delete(workspaceId);
    }
  };
}

export function getBufferedEvents(workspaceId: string): LoopEvent[] {
  const loop = loopsMap.get(workspaceId);
  if (!loop) return [];
  return [...loop.events];
}

export class LoopConflictError extends Error {
  constructor(workspaceId: string) {
    super(`Loop or task already running for workspace ${workspaceId}`);
    this.name = "LoopConflictError";
  }
}
