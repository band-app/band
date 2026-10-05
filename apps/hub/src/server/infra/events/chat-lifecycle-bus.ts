/**
 * In-process pub/sub for what happens to a chat's agent turns, for services
 * that act on a chat without owning it (the project subscriptions of step 6.4).
 * It is separate from the status bus on purpose: that one feeds UI streams, and
 * its events carry no turn outcome or error text.
 */

export interface ChatLifecycleEvent {
  chatId: string;
  worktreeId: string;
  /** `failed`: the turn ended with an error. `waiting`: the agent asks the user a question. `finished`: the turn ended and nothing is queued. */
  kind: "failed" | "waiting" | "finished";
  /** The error message of a `failed` turn. */
  error?: string;
}

type Listener = (event: ChatLifecycleEvent) => void;

const listeners = new Set<Listener>();

export function emitChatLifecycle(event: ChatLifecycleEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // One listener's failure never reaches the turn that produced the event.
    }
  }
}

export function subscribeChatLifecycle(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
