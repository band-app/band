import { useCallback, useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Module-level store — survives React remounts, cleared on page reload.
// ---------------------------------------------------------------------------

const MAX_RECENT = 50;

/** workspaceId → ordered list of file paths (most-recent-first) */
const recentFilesMap = new Map<string, string[]>();

function getRecent(workspaceId: string): string[] {
  return recentFilesMap.get(workspaceId) ?? [];
}

function addRecent(workspaceId: string, filePath: string): string[] {
  const list = getRecent(workspaceId).filter((f) => f !== filePath);
  list.unshift(filePath);
  if (list.length > MAX_RECENT) list.length = MAX_RECENT;
  recentFilesMap.set(workspaceId, list);
  return list;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseRecentFilesReturn {
  recentFiles: string[];
  trackFile: (filePath: string) => void;
}

export function useRecentFiles(workspaceId: string): UseRecentFilesReturn {
  const [recentFiles, setRecentFiles] = useState<string[]>(() => getRecent(workspaceId));

  // Re-sync when workspace changes
  useEffect(() => {
    setRecentFiles(getRecent(workspaceId));
  }, [workspaceId]);

  const trackFile = useCallback(
    (filePath: string) => {
      if (!filePath) return;
      const updated = addRecent(workspaceId, filePath);
      setRecentFiles(updated);
    },
    [workspaceId],
  );

  return { recentFiles, trackFile };
}
