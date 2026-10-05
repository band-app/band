import { useCallback, useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Module-level store — survives React remounts, cleared on page reload.
// ---------------------------------------------------------------------------

const MAX_RECENT = 50;

/** worktreeId → ordered list of file paths (most-recent-first) */
const recentFilesMap = new Map<string, string[]>();

function getRecent(worktreeId: string): string[] {
  return recentFilesMap.get(worktreeId) ?? [];
}

function addRecent(worktreeId: string, filePath: string): string[] {
  const list = getRecent(worktreeId).filter((f) => f !== filePath);
  list.unshift(filePath);
  if (list.length > MAX_RECENT) list.length = MAX_RECENT;
  recentFilesMap.set(worktreeId, list);
  return list;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseRecentFilesReturn {
  recentFiles: string[];
  trackFile: (filePath: string) => void;
}

export function useRecentFiles(worktreeId: string): UseRecentFilesReturn {
  const [recentFiles, setRecentFiles] = useState<string[]>(() => getRecent(worktreeId));

  // Re-sync when worktree changes
  useEffect(() => {
    setRecentFiles(getRecent(worktreeId));
  }, [worktreeId]);

  const trackFile = useCallback(
    (filePath: string) => {
      if (!filePath) return;
      const updated = addRecent(worktreeId, filePath);
      setRecentFiles(updated);
    },
    [worktreeId],
  );

  return { recentFiles, trackFile };
}
