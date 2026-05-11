import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileTab {
  filePath: string;
}

export interface UseFileTabsReturn {
  openTabs: FileTab[];
  activeTabPath: string | null;
  openTab: (filePath: string) => void;
  closeTab: (filePath: string) => void;
  setActiveTab: (filePath: string) => void;
  closeOtherTabs: (filePath: string) => void;
  closeAllTabs: () => void;
}

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

interface PersistedTabState {
  tabs: string[];
  active: string | null;
}

function storageKey(workspaceId: string): string {
  return `band-open-tabs:${workspaceId}`;
}

function loadTabState(workspaceId: string): PersistedTabState | null {
  try {
    const raw = localStorage.getItem(storageKey(workspaceId));
    if (!raw) return null;
    // Don't trust the cast — older builds (or hand-edited localStorage) may
    // have written a different shape, e.g. an array of `{ filePath }` objects
    // instead of bare strings. Filter to strings so downstream code that
    // calls `.split("/")` on a tab path can't crash the whole workspace.
    const parsed = JSON.parse(raw) as { tabs?: unknown; active?: unknown };
    if (!Array.isArray(parsed.tabs)) return null;
    const tabs = parsed.tabs.filter((t): t is string => typeof t === "string");
    const active = typeof parsed.active === "string" ? parsed.active : null;
    return { tabs, active };
  } catch {
    return null;
  }
}

function saveTabState(workspaceId: string, tabs: string[], active: string | null): void {
  try {
    const state: PersistedTabState = { tabs, active };
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
    if (saved) return saved.tabs.map((filePath) => ({ filePath }));
    return [];
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
    saveTabState(
      workspaceId,
      openTabs.map((t) => t.filePath),
      activeTabPath,
    );
  }, [workspaceId, openTabs, activeTabPath]);

  // Reset state when workspace changes
  const prevWorkspaceRef = useRef(workspaceId);
  useEffect(() => {
    if (prevWorkspaceRef.current !== workspaceId) {
      prevWorkspaceRef.current = workspaceId;
      skipFirstPersist.current = true;
      const saved = loadTabState(workspaceId);
      if (saved) {
        setOpenTabs(saved.tabs.map((filePath) => ({ filePath })));
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
    closeTab,
    setActiveTab,
    closeOtherTabs,
    closeAllTabs,
  };
}
