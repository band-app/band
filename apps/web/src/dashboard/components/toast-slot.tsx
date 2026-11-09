import { type ReactNode, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

/** Ref callback for the element in `ToastHost` that notifications from other components render into. */
export function registerToastSlot(el: HTMLElement | null): void {
  slot = el;
  for (const l of listeners) l();
}

/**
 * Renders `children` inside the toast stack from anywhere in the tree, so a component that owns
 * its own state (the CLI and hooks setup) can show a notification without moving that state.
 */
export function ToastPortal({ children }: { children: ReactNode }) {
  const target = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => slot,
    () => null,
  );
  return target ? createPortal(children, target) : null;
}
