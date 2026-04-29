import { useCallback, useRef } from "react";

// ---------------------------------------------------------------------------
// localStorage-backed store for per-tab state
// ---------------------------------------------------------------------------
// Stores a map of filePath -> TabFileState so each tab's editor state,
// scroll position, view mode, and unsaved edits can be restored when
// switching between tabs.

export interface TabFileState {
  /** View mode for preview-capable files (e.g. markdown). */
  viewMode?: "preview" | "source";
  /** Unsaved file content — stored for dirty detection and persistence across reloads. */
  editedContent?: string;
  /** Serialized CodeMirror EditorState (doc, selection, undo history) via toJSON. */
  editorState?: unknown;
  /** Scroll position (scrollDOM.scrollTop) to restore after editor creation. */
  scrollTop?: number;
}

function storageKey(workspaceId: string): string {
  return `band-tab-state:${workspaceId}`;
}

function loadState(workspaceId: string): Record<string, TabFileState> {
  try {
    const raw = localStorage.getItem(storageKey(workspaceId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, TabFileState>;
  } catch {
    return {};
  }
}

function saveState(workspaceId: string, state: Record<string, TabFileState>): void {
  try {
    localStorage.setItem(storageKey(workspaceId), JSON.stringify(state));
  } catch {
    // storage unavailable
  }
}

export interface UseTabStateReturn {
  /** Get the full stored state for a file. */
  get: (filePath: string) => TabFileState | undefined;
  /** Merge partial state for a file (only provided fields are updated). */
  update: (filePath: string, patch: Partial<TabFileState>) => void;
  /** Get the stored view mode for a file. */
  getViewMode: (filePath: string) => "preview" | "source" | undefined;
  /** Store the view mode for a file. */
  setViewMode: (filePath: string, mode: "preview" | "source") => void;
  /** Check if a file has unsaved edits. */
  isDirty: (filePath: string) => boolean;
  /** Remove all stored state for a file (e.g. when tab is closed). */
  removeFile: (filePath: string) => void;
}

export function useTabState(workspaceId: string): UseTabStateReturn {
  // Keep state in a ref so reads/writes are always synchronous and
  // don't trigger re-renders (this is a side-channel, not render state).
  const stateRef = useRef<Record<string, TabFileState>>(loadState(workspaceId));

  // Track workspace changes so we reload from localStorage when it switches
  const workspaceRef = useRef(workspaceId);
  if (workspaceRef.current !== workspaceId) {
    workspaceRef.current = workspaceId;
    stateRef.current = loadState(workspaceId);
  }

  const get = useCallback((filePath: string): TabFileState | undefined => {
    return stateRef.current[filePath];
  }, []);

  const update = useCallback(
    (filePath: string, patch: Partial<TabFileState>) => {
      const entry = stateRef.current[filePath] ?? {};
      stateRef.current[filePath] = { ...entry, ...patch };
      saveState(workspaceId, stateRef.current);
    },
    [workspaceId],
  );

  const getViewMode = useCallback((filePath: string): "preview" | "source" | undefined => {
    return stateRef.current[filePath]?.viewMode;
  }, []);

  const setViewMode = useCallback(
    (filePath: string, mode: "preview" | "source") => {
      const entry = stateRef.current[filePath] ?? {};
      stateRef.current[filePath] = { ...entry, viewMode: mode };
      saveState(workspaceId, stateRef.current);
    },
    [workspaceId],
  );

  const isDirty = useCallback((filePath: string): boolean => {
    return stateRef.current[filePath]?.editedContent != null;
  }, []);

  const removeFile = useCallback(
    (filePath: string) => {
      delete stateRef.current[filePath];
      saveState(workspaceId, stateRef.current);
    },
    [workspaceId],
  );

  return { get, update, getViewMode, setViewMode, isDirty, removeFile };
}
