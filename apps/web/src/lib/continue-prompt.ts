import type { HostOfflineAnswer } from "@band-app/shared/continuation";
import { useSyncExternalStore } from "react";

/**
 * The "host is offline, continue elsewhere?" prompt. An action that needs a live host (a chat
 * message, a terminal, an agent launch) gets an offer from the hub when the worktree's host is
 * offline. The caller hands it to `requestContinue`, which resolves once the person answered:
 * the new worktree id after a continuation, or null when they cancelled or it was not possible.
 */

export interface ContinueRequest {
  id: number;
  answer: HostOfflineAnswer;
  chatId?: string;
  resolve: (result: { worktreeId: string } | null) => void;
}

let current: ContinueRequest | null = null;
let nextId = 0;
const listeners = new Set<() => void>();

const emit = () => {
  for (const l of listeners) l();
};

export function requestContinue(
  answer: HostOfflineAnswer,
  chatId?: string,
): Promise<{ worktreeId: string } | null> {
  // One prompt at a time: a second action while the first is open is declined.
  if (current) return Promise.resolve(null);
  return new Promise((resolve) => {
    current = {
      id: ++nextId,
      answer,
      chatId,
      resolve: (result) => {
        current = null;
        emit();
        resolve(result);
      },
    };
    emit();
  });
}

/**
 * A continuation the hub made by itself (the repo continues on another host automatically). The
 * root component moves the UI to the new worktree. The chat shows the hub's notice.
 */
export interface ContinueAnnouncement {
  id: number;
  worktreeId: string;
}

let announced: ContinueAnnouncement | null = null;

export function announceContinued(worktreeId: string): void {
  announced = { id: ++nextId, worktreeId };
  emit();
}

export function useContinueAnnouncement(): ContinueAnnouncement | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => announced,
    () => null,
  );
}

/** For a caller that sent an action for `asked` and got `used` back: announces a move to another worktree. */
export function announceIfMoved(asked: string, used: string | undefined): void {
  if (used && used !== asked) announceContinued(used);
}

export function useContinueRequest(): ContinueRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}

/** The offer a tRPC error carries in `data.hostOffline`, or null for any other error. */
export function hostOfflineAnswerOf(err: unknown): HostOfflineAnswer | null {
  const answer = (err as { data?: { hostOffline?: HostOfflineAnswer } } | null)?.data?.hostOffline;
  return answer?.offer ? answer : null;
}

/** For callers with nothing to retry (a terminal, an agent launch): shows the prompt when the error is an offline offer. */
export function promptOnHostOffline(err: unknown): void {
  const answer = hostOfflineAnswerOf(err);
  if (answer) void requestContinue(answer);
}
