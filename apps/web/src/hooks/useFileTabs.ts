import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileTab {
  /**
   * For workspace files this is the workspace-relative path
   * (`src/main.ts`). For external files this is the absolute
   * filesystem path returned by the OS file picker
   * (`/Users/alice/notes/scratch.md`). The shape is the same so
   * downstream tab plumbing (active-tab pointer, dedup, eviction)
   * doesn't have to special-case the two flavours.
   */
  filePath: string;
  /** Preview tab — italic, single shared slot, replaced by next preview open. */
  isPreview?: boolean;
  /**
   * True when `filePath` is an absolute path to a file outside the
   * current workspace root, opened via the "Open File…" action. The
   * editor uses the host file IO surface (`host.readFile` /
   * `host.saveFile`) instead of the workspace one, and the tab is
   * rendered with an "external" marker so the user can tell at a
   * glance that edits write to an out-of-workspace path.
   */
  isExternal?: boolean;
}

export interface UseFileTabsReturn {
  openTabs: FileTab[];
  activeTabPath: string | null;
  /**
   * Ensure a tab exists and activate it. Does NOT change an existing tab's
   * preview state — used by route-restore, history nav, external open.
   * New tabs are created as pinned.
   */
  openTab: (filePath: string) => void;
  /**
   * Open a file outside the workspace root as a pinned, external tab.
   * The path is absolute (returned by the OS file picker). If a tab
   * for this path already exists it is activated; no second tab is
   * created.
   */
  openTabExternal: (absolutePath: string) => void;
  /**
   * Open as a preview tab — replaces any existing preview tab.
   *
   * If `isDirty` is provided and the current preview tab is dirty, the
   * dirty preview is pinned in place (so unsaved edits are never lost)
   * and the new file is appended as the new preview. Pinning and the
   * new-preview append happen inside a single setState call so they are
   * atomic with respect to React's batching — callers can rely on the
   * returned `evicted` path being safe to discard.
   *
   * Returns the path of the evicted preview tab (if any) so the caller
   * can release its associated editor state / localStorage entries.
   * Returns null when the preview was pinned (dirty case), when the
   * file is already open, or when no preview tab existed.
   */
  openTabPreview: (filePath: string, isDirty?: (path: string) => boolean) => string | null;
  /** Force-open a pinned tab — creates if missing, pins if existing preview. */
  openTabPinned: (filePath: string) => void;
  /** Convert an existing preview tab into a pinned tab. */
  pinTab: (filePath: string) => void;
  closeTab: (filePath: string) => void;
  setActiveTab: (filePath: string) => void;
  closeOtherTabs: (filePath: string) => void;
  closeAllTabs: () => void;
  /**
   * Rename or move a file. Updates the tab whose path equals `oldPath`,
   * and any descendant tab whose path starts with `oldPath + "/"` (used
   * when the user renames a directory). The active tab pointer follows
   * the renamed path automatically.
   */
  renameFile: (oldPath: string, newPath: string) => void;
  /**
   * Remove every tab whose path equals `path` or sits inside `path + "/"`.
   * Used to keep tabs in sync when the user deletes a file or directory
   * from the file browser.
   */
  removePath: (path: string) => void;
}

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

interface PersistedTab {
  filePath: string;
  isPreview?: boolean;
  isExternal?: boolean;
}

interface PersistedTabState {
  tabs: (string | PersistedTab)[];
  active: string | null;
}

function storageKey(workspaceId: string): string {
  return `band-open-tabs:${workspaceId}`;
}

function loadTabState(workspaceId: string): { tabs: FileTab[]; active: string | null } | null {
  try {
    const raw = localStorage.getItem(storageKey(workspaceId));
    if (!raw) return null;
    // Don't trust the cast — older builds (or hand-edited localStorage) may
    // have written a different shape, e.g. an array of `{ filePath }` objects
    // instead of bare strings. Filter to strings so downstream code that
    // calls `.split("/")` on a tab path can't crash the whole workspace.
    const parsed = JSON.parse(raw) as { tabs?: unknown; active?: unknown };
    if (!Array.isArray(parsed.tabs)) return null;
    // Accept either a bare string (legacy / pinned tab) or a
    // `{ filePath: string, isPreview?: boolean }` object (preview tab).
    // Anything else is dropped — `.split("/")` on a non-string path
    // would crash the whole workspace.
    const tabs: FileTab[] = [];
    for (const t of parsed.tabs) {
      if (typeof t === "string") {
        tabs.push({ filePath: t });
      } else if (
        t !== null &&
        typeof t === "object" &&
        "filePath" in t &&
        typeof (t as { filePath: unknown }).filePath === "string"
      ) {
        const obj = t as { filePath: string; isPreview?: unknown; isExternal?: unknown };
        const tab: FileTab = { filePath: obj.filePath };
        if (obj.isPreview === true) tab.isPreview = true;
        if (obj.isExternal === true) tab.isExternal = true;
        tabs.push(tab);
      }
    }
    const active = typeof parsed.active === "string" ? parsed.active : null;
    return { tabs, active };
  } catch {
    return null;
  }
}

function saveTabState(workspaceId: string, tabs: FileTab[], active: string | null): void {
  try {
    const state: PersistedTabState = {
      tabs: tabs.map((t) => {
        // Bare-string serialization is the legacy/compact form for plain
        // pinned workspace tabs. Anything carrying extra flags (preview,
        // external) is written as an object so the loader can re-hydrate
        // the flag.
        if (!t.isPreview && !t.isExternal) return t.filePath;
        const out: PersistedTab = { filePath: t.filePath };
        if (t.isPreview) out.isPreview = true;
        if (t.isExternal) out.isExternal = true;
        return out;
      }),
      active,
    };
    localStorage.setItem(storageKey(workspaceId), JSON.stringify(state));
  } catch {
    // storage unavailable
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useFileTabs(workspaceId: string): UseFileTabsReturn {
  const [openTabs, setOpenTabs] = useState<FileTab[]>(() => {
    const saved = loadTabState(workspaceId);
    return saved?.tabs ?? [];
  });

  const [activeTabPath, setActiveTabPathState] = useState<string | null>(() => {
    const saved = loadTabState(workspaceId);
    return saved?.active ?? null;
  });

  // Mirror of the React-committed `openTabs` plus any direct-value update
  // we've just dispatched in the same synchronous tick. Updating this ref
  // immediately after a `setOpenTabs(next)` call lets consecutive calls in
  // the same tick see the up-to-date state without waiting for a render.
  //
  // We only read this ref inside `openTabPreview`, the one operation that
  // must atomically decide between "pin the dirty preview and append" vs
  // "evict the clean preview and replace" — packaging both branches into a
  // single direct-value setState avoids the original pin-vs-replace race
  // that arose when those two transitions were issued as separate setStates.
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;

  // Persist to localStorage whenever tabs or active tab changes.
  // Skip the first mount to avoid redundant write of the just-loaded state.
  const skipFirstPersist = useRef(true);
  useEffect(() => {
    if (skipFirstPersist.current) {
      skipFirstPersist.current = false;
      return;
    }
    saveTabState(workspaceId, openTabs, activeTabPath);
  }, [workspaceId, openTabs, activeTabPath]);

  // Reset state when workspace changes
  const prevWorkspaceRef = useRef(workspaceId);
  useEffect(() => {
    if (prevWorkspaceRef.current !== workspaceId) {
      prevWorkspaceRef.current = workspaceId;
      skipFirstPersist.current = true;
      const saved = loadTabState(workspaceId);
      if (saved) {
        setOpenTabs(saved.tabs);
        setActiveTabPathState(saved.active);
      } else {
        setOpenTabs([]);
        setActiveTabPathState(null);
      }
    }
  }, [workspaceId]);

  const openTab = useCallback((filePath: string) => {
    setOpenTabs((prev) => {
      const exists = prev.some((t) => t.filePath === filePath);
      if (exists) return prev;
      return [...prev, { filePath }];
    });
    setActiveTabPathState(filePath);
  }, []);

  const openTabPinned = useCallback((filePath: string) => {
    setOpenTabs((prev) => {
      const idx = prev.findIndex((t) => t.filePath === filePath);
      if (idx === -1) return [...prev, { filePath }];
      if (!prev[idx].isPreview) return prev;
      const next = prev.slice();
      // Preserve isExternal when promoting a preview tab to pinned.
      next[idx] = prev[idx].isExternal ? { filePath, isExternal: true } : { filePath };
      return next;
    });
    setActiveTabPathState(filePath);
  }, []);

  const openTabExternal = useCallback((absolutePath: string) => {
    // External files are always opened pinned — they're a deliberate user
    // intent ("I want to edit this specific file"), so the preview-tab
    // single-slot model isn't appropriate.
    setOpenTabs((prev) => {
      const idx = prev.findIndex((t) => t.filePath === absolutePath);
      if (idx === -1) return [...prev, { filePath: absolutePath, isExternal: true }];
      // Already open — make sure it stays marked as external and pinned.
      const existing = prev[idx];
      if (existing.isExternal && !existing.isPreview) return prev;
      const next = prev.slice();
      next[idx] = { filePath: absolutePath, isExternal: true };
      return next;
    });
    setActiveTabPathState(absolutePath);
  }, []);

  const openTabPreview = useCallback(
    (filePath: string, isDirty?: (path: string) => boolean): string | null => {
      const prev = openTabsRef.current;

      // Already open (preview or pinned) — just activate, no eviction.
      if (prev.some((t) => t.filePath === filePath)) {
        setActiveTabPathState(filePath);
        return null;
      }

      const previewIdx = prev.findIndex((t) => t.isPreview);
      let evicted: string | null = null;
      let next: FileTab[];

      if (previewIdx === -1) {
        // No existing preview — append a new preview tab.
        next = [...prev, { filePath, isPreview: true }];
      } else {
        const previewPath = prev[previewIdx].filePath;
        const draft = prev.slice();
        if (isDirty?.(previewPath)) {
          // Dirty preview — pin it in place and append the new preview.
          // Combining pin + append in ONE setState call (vs. the previous
          // pinTab() + setOpenTabs() pair) is what makes the transition
          // atomic with respect to React's batching: there's no longer
          // any direct-value setState that can overwrite a queued pin
          // updater. The dirty file's tab survives and its editedContent
          // is never silently dropped by the eviction cleanup below.
          draft[previewIdx] = { filePath: previewPath };
          next = [...draft, { filePath, isPreview: true }];
        } else {
          // Clean preview — replace it. Caller may release editor state
          // for the evicted path.
          evicted = previewPath;
          draft[previewIdx] = { filePath, isPreview: true };
          next = draft;
        }
      }

      openTabsRef.current = next;
      setOpenTabs(next);
      setActiveTabPathState(filePath);
      return evicted;
    },
    [],
  );

  const pinTab = useCallback((filePath: string) => {
    setOpenTabs((prev) => {
      const idx = prev.findIndex((t) => t.filePath === filePath);
      if (idx === -1 || !prev[idx].isPreview) return prev;
      const next = prev.slice();
      next[idx] = { filePath };
      return next;
    });
  }, []);

  const closeTab = useCallback((filePath: string) => {
    setOpenTabs((prev) => {
      const idx = prev.findIndex((t) => t.filePath === filePath);
      if (idx === -1) return prev;
      const next = prev.filter((_, i) => i !== idx);

      // Update active tab if the closed tab was active
      setActiveTabPathState((currentActive) => {
        if (currentActive !== filePath) return currentActive;
        if (next.length === 0) return null;
        // Prefer the tab at the same index (right neighbor), then fall back to left
        const newIdx = Math.min(idx, next.length - 1);
        return next[newIdx].filePath;
      });

      return next;
    });
  }, []);

  const setActiveTab = useCallback(
    (filePath: string) => {
      // Only set active if the tab actually exists
      const exists = openTabs.some((t) => t.filePath === filePath);
      if (exists) {
        setActiveTabPathState(filePath);
      }
    },
    [openTabs],
  );

  const closeOtherTabs = useCallback((filePath: string) => {
    setOpenTabs((prev) => {
      const kept = prev.filter((t) => t.filePath === filePath);
      return kept.length > 0 ? kept : [];
    });
    setActiveTabPathState(filePath);
  }, []);

  const closeAllTabs = useCallback(() => {
    setOpenTabs([]);
    setActiveTabPathState(null);
  }, []);

  // Helper: returns the rewritten path if `path` is `oldPath` itself or
  // a descendant of `oldPath`. Returns null when it's outside the
  // renamed subtree.
  const rewritePath = useCallback(
    (path: string, oldPath: string, newPath: string): string | null => {
      if (path === oldPath) return newPath;
      const prefix = `${oldPath}/`;
      if (path.startsWith(prefix)) return newPath + path.slice(oldPath.length);
      return null;
    },
    [],
  );

  const renameFile = useCallback(
    (oldPath: string, newPath: string) => {
      if (oldPath === newPath) return;
      setOpenTabs((prev) => {
        let changed = false;
        const next = prev.map((tab) => {
          const rewritten = rewritePath(tab.filePath, oldPath, newPath);
          if (rewritten === null) return tab;
          changed = true;
          return tab.isPreview ? { filePath: rewritten, isPreview: true } : { filePath: rewritten };
        });
        return changed ? next : prev;
      });
      setActiveTabPathState((current) => {
        if (current === null) return current;
        const rewritten = rewritePath(current, oldPath, newPath);
        return rewritten ?? current;
      });
    },
    [rewritePath],
  );

  const removePath = useCallback((path: string) => {
    const prefix = `${path}/`;
    setOpenTabs((prev) => {
      const next = prev.filter((tab) => tab.filePath !== path && !tab.filePath.startsWith(prefix));
      if (next.length === prev.length) {
        // Nothing to remove — still need to sync activeTabPath in case it
        // was already cleared elsewhere.
        return prev;
      }
      setActiveTabPathState((currentActive) => {
        if (
          currentActive !== null &&
          (currentActive === path || currentActive.startsWith(prefix))
        ) {
          // Pick the tab that used to be just after the removed range,
          // else the previous tab, else nothing.
          if (next.length === 0) return null;
          const removedIdx = prev.findIndex((t) => t.filePath === currentActive);
          if (removedIdx === -1) return next[0].filePath;
          // Find the surviving tab nearest to the removed slot.
          // Search forward first.
          for (let i = removedIdx; i < prev.length; i++) {
            if (next.some((t) => t.filePath === prev[i].filePath)) {
              return prev[i].filePath;
            }
          }
          for (let i = removedIdx - 1; i >= 0; i--) {
            if (next.some((t) => t.filePath === prev[i].filePath)) {
              return prev[i].filePath;
            }
          }
          return next[0].filePath;
        }
        return currentActive;
      });
      return next;
    });
  }, []);

  return {
    openTabs,
    activeTabPath,
    openTab,
    openTabPreview,
    openTabPinned,
    openTabExternal,
    pinTab,
    closeTab,
    setActiveTab,
    closeOtherTabs,
    closeAllTabs,
    renameFile,
    removePath,
  };
}
