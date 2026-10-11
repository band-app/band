/** A tiny bus for "an agent turn ended in this worktree", so services need not import task-service. */

import { EventEmitter } from "node:events";

const bus = new EventEmitter();

export function emitTurnEnded(worktreeId: string): void {
  bus.emit("turn-ended", worktreeId);
}

/** Calls `listener` after each turn that ends in any worktree. Returns the unsubscribe function. */
export function onTurnEnded(listener: (worktreeId: string) => void): () => void {
  bus.on("turn-ended", listener);
  return () => bus.off("turn-ended", listener);
}
