import { useCallback } from "react";

/**
 * Elements the bottom-right toast stack must not cover: the chat composer,
 * the mobile terminal key bar and the dashboard's bottom action bar. Each one
 * registers through `useToastObstruction`'s callback ref, and `ToastHost`
 * lifts the stack above any registered element it would overlap.
 */
const obstructions = new Set<HTMLElement>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

export function toastObstructions(): ReadonlySet<HTMLElement> {
  return obstructions;
}

/** Call `listener` whenever an element registers or unregisters. */
export function subscribeToastObstructions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A callback ref that registers its element as a toast obstruction while mounted. */
export function useToastObstruction(): (el: HTMLElement | null) => (() => void) | undefined {
  return useCallback((el: HTMLElement | null) => {
    if (!el) return;
    obstructions.add(el);
    changed();
    return () => {
      obstructions.delete(el);
      changed();
    };
  }, []);
}
