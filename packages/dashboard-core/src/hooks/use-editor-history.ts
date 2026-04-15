import { useCallback, useRef, useState } from "react";

/** A single entry in the editor navigation history. */
export interface EditorHistoryEntry {
  filePath: string;
  line?: number;
  column?: number;
}

export interface UseEditorHistoryReturn {
  /** Push a new entry (truncates forward stack). Call on navigation events. */
  push: (entry: EditorHistoryEntry) => void;
  /** Navigate back — returns the entry or undefined if at start. */
  goBack: () => EditorHistoryEntry | undefined;
  /** Navigate forward — returns the entry or undefined if at end. */
  goForward: () => EditorHistoryEntry | undefined;
  canGoBack: boolean;
  canGoForward: boolean;
}

const MAX_HISTORY = 100;
const LINE_PROXIMITY_THRESHOLD = 5;

/** Returns true if two entries are close enough to be considered the same location. */
function entriesAreClose(a: EditorHistoryEntry, b: EditorHistoryEntry): boolean {
  if (a.filePath !== b.filePath) return false;
  // If neither has a line number, they are the same location
  if (a.line == null && b.line == null) return true;
  // If only one has a line, they differ
  if (a.line == null || b.line == null) return false;
  return Math.abs(a.line - b.line) <= LINE_PROXIMITY_THRESHOLD;
}

/**
 * Browser-like editor navigation history for back/forward within files.
 *
 * Tracks file + line + column positions in a stack with a cursor.
 * Navigating back/forward moves the cursor without pushing a new entry.
 * Any normal navigation truncates the forward stack — exactly like a browser.
 */
export function useEditorHistory(): UseEditorHistoryReturn {
  const stackRef = useRef<EditorHistoryEntry[]>([]);
  const cursorRef = useRef(-1);
  // Sentinel: when true, the next push() call is a no-op.
  // Set by goBack/goForward so that the state change they trigger
  // doesn't get recorded as a new history entry.
  const navigatingRef = useRef(false);

  // State drives re-renders for button enable/disable
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  const updateCanFlags = useCallback(() => {
    setCanGoBack(cursorRef.current > 0);
    setCanGoForward(cursorRef.current < stackRef.current.length - 1);
  }, []);

  const push = useCallback(
    (entry: EditorHistoryEntry) => {
      if (navigatingRef.current) {
        navigatingRef.current = false;
        return;
      }

      const stack = stackRef.current;
      const cursor = cursorRef.current;

      // Deduplicate: skip if the new entry is close to the current position
      if (cursor >= 0 && entriesAreClose(stack[cursor], entry)) {
        return;
      }

      // Truncate forward entries and push
      const newStack = stack.slice(0, cursor + 1);
      newStack.push(entry);

      // Cap the stack size
      if (newStack.length > MAX_HISTORY) {
        newStack.shift();
      }

      stackRef.current = newStack;
      cursorRef.current = newStack.length - 1;
      updateCanFlags();
    },
    [updateCanFlags],
  );

  const goBack = useCallback((): EditorHistoryEntry | undefined => {
    if (cursorRef.current <= 0) return undefined;
    cursorRef.current -= 1;
    navigatingRef.current = true;
    updateCanFlags();
    return stackRef.current[cursorRef.current];
  }, [updateCanFlags]);

  const goForward = useCallback((): EditorHistoryEntry | undefined => {
    if (cursorRef.current >= stackRef.current.length - 1) return undefined;
    cursorRef.current += 1;
    navigatingRef.current = true;
    updateCanFlags();
    return stackRef.current[cursorRef.current];
  }, [updateCanFlags]);

  return { push, goBack, goForward, canGoBack, canGoForward };
}
