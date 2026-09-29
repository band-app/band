/**
 * Work a chat's agent process has pending on its own, which dies with the
 * process: background commands, monitors, scheduled wakeups, cron jobs,
 * and tool calls of a turn the agent started itself. While any of it is
 * outstanding, the idle timer in `agent-session-service` doesn't stop the
 * process.
 *
 * What Band can see of it:
 *   - AIR `async_task_*` updates (the Claude adapter sends them because
 *     Band lists the `asyncTasks` capability): a background Bash command,
 *     a Monitor or a workflow starts with `async_task_spawned` and ends
 *     with an `async_task_state_update` in a terminal state.
 *   - Tool calls, named by `_meta.claudeCode.toolName`: `ScheduleWakeup`
 *     (`delaySeconds`), `CronCreate`, `Monitor` (`timeout_ms`) and `Bash`
 *     with `run_in_background`. The last two also become async tasks; the
 *     tool call holds only until the task is announced.
 *   - A tool call the agent starts outside a Band turn, until it completes.
 *
 * Every hold ends at a deadline, at most `MAX_HOLD_MS` away, so work whose
 * end Band never sees (a `CronDelete`, a lost update) can't keep a process
 * alive forever.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { AsyncTaskUpdate } from "../../infra/agents/acp-agent-process";

/** The longest any one piece of work keeps an idle agent process alive. */
export const MAX_HOLD_MS = 8 * 60 * 60_000;
/** Claude Code's Monitor default when the call names no `timeout_ms`. */
const MONITOR_DEFAULT_TIMEOUT_MS = 5 * 60_000;

export interface PendingWorkHold {
  /** What the work is, for the log. */
  reason: string;
  /** When the hold lapses on its own (ms since epoch). */
  until: number;
  /** A hold that only lasts until its tool call completes. */
  untilCompleted?: boolean;
}

type ToolUpdate = Extract<acp.SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>;

function toolName(update: ToolUpdate): string | undefined {
  const meta = update._meta as { claudeCode?: { toolName?: unknown } } | null | undefined;
  const name = meta?.claudeCode?.toolName ?? (update as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export class PendingWork {
  private readonly holds = new Map<string, PendingWorkHold>();

  /** Notes what a `session/update` starts or ends. `inTurn` is whether a
   *  Band-started turn is running. */
  observeUpdate(update: acp.SessionUpdate, inTurn: boolean, now = Date.now()): void {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
    const key = `tool:${update.toolCallId}`;
    if (update.status === "failed") {
      this.holds.delete(key);
      return;
    }
    const hold = this.toolHold(update, now);
    if (hold) {
      this.set(key, hold, now);
      return;
    }
    if (update.status === "completed") {
      if (this.holds.get(key)?.untilCompleted) this.holds.delete(key);
      return;
    }
    if (!inTurn && update.sessionUpdate === "tool_call" && !this.holds.has(key)) {
      this.set(key, { reason: "tool call", until: now + MAX_HOLD_MS, untilCompleted: true }, now);
    }
  }

  /** Notes an AIR async task starting or ending. */
  observeAsyncTask(update: AsyncTaskUpdate, now = Date.now()): void {
    const key = `task:${update.asyncTaskId}`;
    if (update.sessionUpdate === "async_task_spawned") {
      if (update.toolCallId) this.holds.delete(`tool:${update.toolCallId}`);
      this.set(
        key,
        { reason: `${update.taskType ?? "background"} task`, until: now + MAX_HOLD_MS },
        now,
      );
    } else if (
      update.sessionUpdate === "async_task_state_update" &&
      (update.state === "completed" || update.state === "failed" || update.state === "stopped")
    ) {
      this.holds.delete(key);
      if (update.toolCallId) this.holds.delete(`tool:${update.toolCallId}`);
    }
  }

  /** The holds still in force, dropping the ones that lapsed. */
  outstanding(now = Date.now()): PendingWorkHold[] {
    for (const [key, hold] of this.holds) {
      if (hold.until <= now) this.holds.delete(key);
    }
    return [...this.holds.values()];
  }

  clear(): void {
    this.holds.clear();
  }

  private toolHold(update: ToolUpdate, now: number): PendingWorkHold | null {
    const input = update.rawInput as Record<string, unknown> | null | undefined;
    if (!input || typeof input !== "object") return null;
    switch (toolName(update)) {
      case "ScheduleWakeup": {
        const delaySeconds = finiteNumber(input.delaySeconds);
        return delaySeconds === undefined
          ? null
          : { reason: "scheduled wakeup", until: now + delaySeconds * 1000 };
      }
      case "CronCreate":
        return { reason: "cron job", until: now + MAX_HOLD_MS };
      case "Monitor": {
        const timeout = finiteNumber(input.timeout_ms) ?? MONITOR_DEFAULT_TIMEOUT_MS;
        return { reason: "monitor", until: now + timeout };
      }
      case "Bash":
      case "PowerShell":
        return input.run_in_background === true
          ? { reason: "background command", until: now + MAX_HOLD_MS }
          : null;
      default:
        return null;
    }
  }

  private set(key: string, hold: PendingWorkHold, now: number): void {
    this.holds.set(key, { ...hold, until: Math.min(hold.until, now + MAX_HOLD_MS) });
  }
}
