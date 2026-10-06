import { useSyncExternalStore } from "react";

/**
 * Which host's desktop the viewer dialog shows, or null when it is closed. The Hosts settings
 * row and the worktree header both open it, and `DashboardShell` mounts the one dialog.
 */
let openHostId: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function openDesktopViewer(hostId: string): void {
  openHostId = hostId;
  emit();
}

export function closeDesktopViewer(): void {
  openHostId = null;
  emit();
}

export function useDesktopViewerHost(): string | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => openHostId,
    () => null,
  );
}
