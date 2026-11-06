/**
 * A file tab outside the worktree can live on two machines: the worktree's own
 * worker (the default, read through the hub) or this Mac (a file from Finder,
 * read and saved by the desktop app). A desktop file's tab path carries a
 * prefix, so its tab id, dirty state and saved tab state never collide with a
 * worker file at the same path, such as two different `/etc/hosts`.
 */
export const DESKTOP_FILE_PREFIX = "desktop:";

export function desktopFilePath(absolutePath: string): string {
  return `${DESKTOP_FILE_PREFIX}${absolutePath}`;
}

export function isDesktopFilePath(tabPath: string): boolean {
  return tabPath.startsWith(DESKTOP_FILE_PREFIX);
}

/** The real absolute path behind a tab path, with the source prefix removed. */
export function ioPathOf(tabPath: string): string {
  return isDesktopFilePath(tabPath) ? tabPath.slice(DESKTOP_FILE_PREFIX.length) : tabPath;
}
