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
   * Returns the path of the evicted preview tab (if any) so caller can
   * release its associated editor state / localStorage entries.
   */
  openTabPreview: (filePath: string) => string | null;
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

  const openTabPreview = useCallback((filePath: string): string | null => {
    let evicted: string | null = null;
    setOpenTabs((prev) => {
      const existingIdx = prev.findIndex((t) => t.filePath === filePath);
      // If file already open (preview or pinned), just activate it.
      if (existingIdx !== -1) return prev;
      // Replace the existing preview tab if any, otherwise append.
      const previewIdx = prev.findIndex((t) => t.isPreview);
      if (previewIdx !== -1) {
        evicted = prev[previewIdx].filePath;
        const next = prev.slice();
        next[previewIdx] = { filePath, isPreview: true };
        return next;
      }
      return [...prev, { filePath, isPreview: true }];
    });
    setActiveTabPathState(filePath);
    return evicted;
  }, []);

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
