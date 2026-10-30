import { createLogger } from "@band-app/logger";
import { agentSessionService } from "./agent-session-service";
import { chatService } from "./chat-service";

const log = createLogger("background-wake");

/**
 * Wakes an idle agent when background work it started has ended.
 *
 * A background shell or Monitor does not hold a turn open. When it ends after the turn, the
 * Claude CLI may re-enter the model by itself, which reaches Band as an update from a turn the
 * agent started. If that has not happened `BAND_BACKGROUND_WAKE_MS` after the task ended, the agent
 * is waiting for a notice it never got, so Band sends one short message naming the tasks.
 *
 * One message goes out per batch of ended tasks. Nothing is sent while a turn runs, after the
 * agent started a turn of its own, or once the chat's process is gone (stopped, idle-stopped,
 * exited or removed).
 */

const WAKE_MS = 5_000;

function wakeMs(): number {
  const raw = process.env.BAND_BACKGROUND_WAKE_MS;
  const override = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(override) && override >= 0 ? override : WAKE_MS;
}

interface Waiting {
  worktreeId: string;
  tasks: { name: string; state: string }[];
  timer: ReturnType<typeof setTimeout>;
}

const waiting = new Map<string, Waiting>();

export interface WakeDeps {
  hasRunningTurn: (chatId: string) => boolean;
  /** Starts a turn with `prompt`, or queues it. */
  send: (worktreeId: string, chatId: string, prompt: string) => void;
}

function cancel(chatId: string): void {
  const entry = waiting.get(chatId);
  if (entry) clearTimeout(entry.timer);
  waiting.delete(chatId);
}

export function wakeMessage(tasks: { name: string; state: string }[]): string {
  const lines = tasks.map((t) => `- ${t.name} (${t.state})`);
  return [
    tasks.length === 1
      ? "A background task you started has ended:"
      : "Background tasks you started have ended:",
    ...lines,
    "Carry on with what you were waiting for.",
  ].join("\n");
}

let observing = false;

export function observeBackgroundWake(deps: WakeDeps): void {
  if (observing) return;
  observing = true;
  agentSessionService.observeBackgroundTasks((chatId, worktreeId, event) => {
    if (event.kind !== "ended") {
      cancel(chatId);
      return;
    }
    const entry = waiting.get(chatId);
    if (entry) {
      entry.tasks.push({ name: event.name, state: event.state });
      return;
    }
    const next: Waiting = {
      worktreeId,
      tasks: [{ name: event.name, state: event.state }],
      timer: setTimeout(() => {
        waiting.delete(chatId);
        if (!chatService.get(chatId) || deps.hasRunningTurn(chatId)) return;
        try {
          deps.send(worktreeId, chatId, wakeMessage(next.tasks));
        } catch (err) {
          log.warn({ chatId, err }, "could not wake the agent");
        }
      }, wakeMs()),
    };
    next.timer.unref?.();
    waiting.set(chatId, next);
  });
}
