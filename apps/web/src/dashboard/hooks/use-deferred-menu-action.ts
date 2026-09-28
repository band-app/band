import { useCallback, useRef } from "react";

/**
 * Defer a menu item's action until the menu has fully closed.
 *
 * Radix's `ContextMenuContent` / `DropdownMenuContent` keep a
 * `FocusScope` mounted for the ~150 ms close transition that runs
 * AFTER `onSelect` fires. Any input that mounts inside the
 * synchronously-dispatched action ends up fighting that FocusScope
 * for focus and gets cancelled by its own `onBlur`.
 *
 * The fix: in `onSelect`, just *record* what should happen. In the
 * content's `onCloseAutoFocus` (which fires once the menu is fully
 * gone), flush the recorded callback. By the time the callback runs
 * there's no FocusScope competing — the input mounts in a quiet DOM
 * and gets focus on the first try.
 *
 * Usage:
 *
 *     const menu = useDeferredMenuAction();
 *     // ...
 *     <ContextMenuContent onCloseAutoFocus={menu.flush}>
 *       <ContextMenuItem onSelect={() => menu.queue(() => doThing())}>
 *         Do thing
 *       </ContextMenuItem>
 *     </ContextMenuContent>
 */
export function useDeferredMenuAction() {
  const pendingRef = useRef<(() => void) | null>(null);

  const queue = useCallback((fn: () => void) => {
    pendingRef.current = fn;
  }, []);

  const flush = useCallback((e: { preventDefault: () => void }) => {
    // Also stops Radix from restoring focus to the trigger — our queued
    // action will mount its own UI which takes focus instead.
    e.preventDefault();
    const fn = pendingRef.current;
    pendingRef.current = null;
    fn?.();
  }, []);

  return { queue, flush };
}
