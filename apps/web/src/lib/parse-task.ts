/** The task id in a `/task/<id>` pathname, or null. */
export function parseTaskFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/task\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
