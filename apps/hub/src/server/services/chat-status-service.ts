import type { AgentHookStatus } from "@band-app/coding-agent";
import { agentSessionService } from "./agent-session-service";
import { chatService } from "./chat-service";
import { chatStatusSource, setWorktreeSourceStatus } from "./state";
import { emit as emitStatusEvent } from "./watcher-service";

/**
 * The status a chat reports on its worktree (source `chat:<id>`):
 * `working`, `monitoring`, `question`, `done`, `failed` or `idle`.
 *
 * `task-service` drives it for turns Band starts. Turns the agent starts on
 * its own (a cron, a `ScheduleWakeup`, a finished background task) never go
 * through `session/prompt`, and the Claude adapter sends no marker when
 * such a turn ends. The chat shows `working` while updates arrive and
 * settles after `quietMs()` without one.
 */

/** Silence after which an agent-started turn counts as over. */
const QUIET_MS = 10_000;
/** Longest delay a timer takes. */
const MAX_TIMER_MS = 2 ** 31 - 1;

function quietMs(): number {
  const override = Number(process.env.BAND_AGENT_QUIET_MS);
  return Number.isFinite(override) && override > 0 ? override : QUIET_MS;
}

/** Chats whose agent runs a turn Band did not start, with the timer that ends it. */
const autonomous = new Map<string, ReturnType<typeof setTimeout> | null>();
/** Per chat, the timer that re-checks `monitoring` when its soonest hold lapses. */
const monitorTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Chats showing `monitoring`. */
const monitoringChats = new Set<string>();

/** Whether Band has a turn in flight for the chat; set by `observeAgentStatus`. */
let runningTurn: (chatId: string) => boolean = () => false;

/** Records a chat's status on its worktree and broadcasts the worktree's new status. */
export function setChatStatus(worktreeId: string, chatId: string, status: AgentHookStatus): void {
  if (status === "monitoring") monitoringChats.add(chatId);
  else monitoringChats.delete(chatId);
  const updated = setWorktreeSourceStatus(worktreeId, chatStatusSource(chatId), { status });
  emitStatusEvent({ kind: "update", status: updated });
}

/** The status a chat settles to when its agent has nothing running right now. */
function restingStatus(chatId: string): AgentHookStatus {
  if (agentSessionService.hasPendingRequest(chatId)) return "question";
  if (agentSessionService.nextWorkDeadline(chatId) !== null) return "monitoring";
  return "done";
}

/** A turn Band started begins: the chat is `working`, and no agent-started turn is pending. */
export function beginBandTurn(worktreeId: string, chatId: string): void {
  endAutonomous(chatId);
  clearMonitorTimer(chatId);
  setChatStatus(worktreeId, chatId, "working");
}

/**
 * A turn Band started ended without the user stopping it. `done`, or
 * `monitoring` while the agent still has background work, or `failed`.
 */
export function endBandTurn(
  worktreeId: string,
  chatId: string,
  result: "done" | "failed" | "idle",
): void {
  const status = result === "done" ? restingStatus(chatId) : result;
  setChatStatus(worktreeId, chatId, status);
  if (status === "monitoring") watchMonitoring(worktreeId, chatId);
}

function endAutonomous(chatId: string): void {
  const timer = autonomous.get(chatId);
  if (timer) clearTimeout(timer);
  autonomous.delete(chatId);
}

function clearMonitorTimer(chatId: string): void {
  const timer = monitorTimers.get(chatId);
  if (timer) clearTimeout(timer);
  monitorTimers.delete(chatId);
}

/** A task lapses by deadline with no update (a cron job): look again then. */
function watchMonitoring(worktreeId: string, chatId: string): void {
  clearMonitorTimer(chatId);
  const deadline = agentSessionService.nextWorkDeadline(chatId);
  if (deadline === null) return;
  const timer = setTimeout(
    () => {
      monitorTimers.delete(chatId);
      if (runningTurn(chatId) || autonomous.has(chatId)) return;
      reconsiderMonitoring(worktreeId, chatId);
    },
    Math.min(Math.max(deadline - Date.now(), 0) + 100, MAX_TIMER_MS),
  );
  timer.unref?.();
  monitorTimers.set(chatId, timer);
}

/** A `monitoring` chat whose last hold ended is `done`; one with holds left keeps watching. */
function reconsiderMonitoring(worktreeId: string, chatId: string): void {
  if (!chatService.get(chatId) || !monitoringChats.has(chatId)) return;
  const status = restingStatus(chatId);
  if (status === "monitoring") {
    watchMonitoring(worktreeId, chatId);
    return;
  }
  setChatStatus(worktreeId, chatId, status);
}

function settleAutonomous(worktreeId: string, chatId: string): void {
  autonomous.delete(chatId);
  if (!chatService.get(chatId) || runningTurn(chatId)) return;
  const status = restingStatus(chatId);
  setChatStatus(worktreeId, chatId, status);
  if (status === "monitoring") watchMonitoring(worktreeId, chatId);
}

function armQuietTimer(worktreeId: string, chatId: string): void {
  const previous = autonomous.get(chatId);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => settleAutonomous(worktreeId, chatId), quietMs());
  timer.unref?.();
  autonomous.set(chatId, timer);
}

let observing = false;

/**
 * Starts following the chats' agents. Called on the first submitted turn,
 * not at module load, because `agent-session-service` sits in an import
 * cycle with `task-service` and isn't initialised yet then.
 */
export function observeAgentStatus(hasRunningTurn: (chatId: string) => boolean): void {
  if (observing) return;
  observing = true;
  runningTurn = hasRunningTurn;

  // A permission or elicitation request opening means the agent waits on
  // the user; its answer means the agent is working again. A request with
  // no turn of Band's behind it belongs to a turn the agent started.
  agentSessionService.observePending((chatId, worktreeId) => {
    const waiting = agentSessionService.hasPendingRequest(chatId);
    if (runningTurn(chatId)) {
      setChatStatus(worktreeId, chatId, waiting ? "question" : "working");
      return;
    }
    if (waiting) {
      const timer = autonomous.get(chatId);
      if (timer) clearTimeout(timer);
      autonomous.set(chatId, null);
      setChatStatus(worktreeId, chatId, "question");
    } else if (autonomous.has(chatId)) {
      setChatStatus(worktreeId, chatId, "working");
      armQuietTimer(worktreeId, chatId);
    }
  });

  agentSessionService.observeActivity((chatId, worktreeId, kind) => {
    if (runningTurn(chatId) || !chatService.get(chatId)) return;
    if (kind === "update") {
      // Stay `question` while a request is open: the answer flips it back.
      if (agentSessionService.hasPendingRequest(chatId)) return;
      const wasWorking = autonomous.has(chatId);
      armQuietTimer(worktreeId, chatId);
      clearMonitorTimer(chatId);
      if (!wasWorking) setChatStatus(worktreeId, chatId, "working");
      return;
    }
    // A background task started or ended while no turn runs. A turn of the
    // agent's own settles by itself; otherwise the chat leaves `monitoring`
    // once its last hold ends.
    if (autonomous.has(chatId)) return;
    reconsiderMonitoring(worktreeId, chatId);
  });
}
