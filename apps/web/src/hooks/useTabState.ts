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
  /**
   * User-selected syntax highlighting language override (e.g.
   * `"typescript"`, `"markdown"`, `"plaintext"`). When set, the editor
   * uses this instead of auto-detecting from the file extension /
   * filename. Survives saves (per issue #434: "Saving an untitled tab
   * whose language was manually set keeps the override even if the
   * chosen filename's extension would imply a different language").
   *
   * **Persists across sessions** for file-backed tabs — `TabFileState`
   * is the localStorage-backed per-tab record, and the `language`
   * field rides along. Treating the override as session-persistent is
   * deliberate: the user explicitly chose Python for their `.txt`
   * file, and silently reverting that choice on reload would surprise
   * them more than letting it stick. Reverting paths:
   *
   *   - **Auto Detect** entry in the language picker — clears the
   *     override (`update({ language: undefined })`) so the next
   *     render falls back to extension-based detection. Shown in the
   *     picker only when an override is currently active.
   *   - **Close the tab** — `removeFile` drops the whole `TabFileState`
   *     entry including the language field. The next open of the same
   *     file starts fresh.
   *
   * Untitled tabs are also persisted now (issue #434's "scratch
   * persistence" follow-up landed in the same PR), so their overrides
   * survive reloads too. The synthetic `untitled:N` keys mean
   * collisions are scoped to the same monotonic-N counter — see
   * `useFileTabs.initialUntitledCounter`.
   */
  language?: string;
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
  /** Get the user-overridden language for a file (undefined when auto-detected). */
  getLanguage: (filePath: string) => string | undefined;
  /** Store a manual language override for a file. */
  setLanguage: (filePath: string, language: string) => void;
  /** Check if a file has unsaved edits. */
  isDirty: (filePath: string) => boolean;
  /** Remove all stored state for a file (e.g. when tab is closed). */
  removeFile: (filePath: string) => void;
  /**
   * Rename a stored file's state (and any descendants when `oldPath`
   * was a directory). Used to keep persisted editor state in sync when
   * the user renames a file/directory from the file browser.
   */
  renameFile: (oldPath: string, newPath: string) => void;
  /**
   * Remove stored state for `path` and anything sitting inside it.
   * Used when a path is deleted from the file browser.
   */
  removePath: (path: string) => void;
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

  const getLanguage = useCallback((filePath: string): string | undefined => {
    return stateRef.current[filePath]?.language;
  }, []);

  const setLanguage = useCallback(
    (filePath: string, language: string) => {
      const entry = stateRef.current[filePath] ?? {};
      stateRef.current[filePath] = { ...entry, language };
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

  const renameFile = useCallback(
    (oldPath: string, newPath: string) => {
      if (oldPath === newPath) return;
      const prefix = `${oldPath}/`;
      let changed = false;
      const next: Record<string, TabFileState> = {};
      for (const [key, value] of Object.entries(stateRef.current)) {
        if (key === oldPath) {
          next[newPath] = value;
          changed = true;
        } else if (key.startsWith(prefix)) {
          next[newPath + key.slice(oldPath.length)] = value;
          changed = true;
        } else {
          next[key] = value;
        }
      }
      if (changed) {
        stateRef.current = next;
        saveState(workspaceId, stateRef.current);
      }
    },
    [workspaceId],
  );

  const removePath = useCallback(
    (path: string) => {
      const prefix = `${path}/`;
      let changed = false;
      for (const key of Object.keys(stateRef.current)) {
        if (key === path || key.startsWith(prefix)) {
          delete stateRef.current[key];
          changed = true;
        }
      }
      if (changed) saveState(workspaceId, stateRef.current);
    },
    [workspaceId],
  );

  return {
    get,
    update,
    getViewMode,
    setViewMode,
    getLanguage,
    setLanguage,
    isDirty,
    removeFile,
    renameFile,
    removePath,
  };
}
