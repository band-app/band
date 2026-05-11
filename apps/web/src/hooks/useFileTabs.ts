import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileTab {
  filePath: string;
  /** Preview tab — italic, single shared slot, replaced by next preview open. */
  isPreview?: boolean;
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
}

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

interface PersistedTab {
  filePath: string;
  isPreview?: boolean;
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
    const parsed = JSON.parse(raw) as PersistedTabState;
    if (!Array.isArray(parsed.tabs)) return null;
    const tabs: FileTab[] = parsed.tabs.map((t) =>
      typeof t === "string" ? { filePath: t } : { filePath: t.filePath, isPreview: t.isPreview },
    );
    return { tabs, active: parsed.active ?? null };
  } catch {
    return null;
  }
}

function saveTabState(workspaceId: string, tabs: FileTab[], active: string | null): void {
  try {
    const state: PersistedTabState = {
      tabs: tabs.map((t) => (t.isPreview ? { filePath: t.filePath, isPreview: true } : t.filePath)),
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
      next[idx] = { filePath };
      return next;
    });
    setActiveTabPathState(filePath);
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

  return {
    openTabs,
    activeTabPath,
    openTab,
    openTabPreview,
    openTabPinned,
    pinTab,
    closeTab,
    setActiveTab,
    closeOtherTabs,
    closeAllTabs,
  };
}
