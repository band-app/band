/**
 * Files an agent shares live under `/api/shared/<worktreeId>/<chatId>/<name>`
 * (older chat cards: `/api/shared/<worktreeId>/<name>`). A center tab shows one
 * as a `file:` leaf whose path is `shared:<chatId>/<name>`, or `shared:/<name>`
 * for the older form, so the tab id restores from the saved tab list alone.
 */

const URL_PREFIX = "/api/shared/";
const PATH_PREFIX = "shared:";

export interface SharedFileRef {
  worktreeId: string;
  chatId: string;
  name: string;
}

export function isSharedFilePath(filePath: string): boolean {
  return filePath.startsWith(PATH_PREFIX);
}

export function sharedFilePath(chatId: string, name: string): string {
  return `${PATH_PREFIX}${chatId}/${name}`;
}

/** The shared file a card's URL names, or null for any other URL. */
export function parseSharedFileUrl(url: string): SharedFileRef | null {
  const path = url.split("?")[0];
  if (!path.startsWith(URL_PREFIX)) return null;
  const parts = path.slice(URL_PREFIX.length).split("/");
  if (parts.length !== 2 && parts.length !== 3) return null;
  try {
    const decoded = parts.map(decodeURIComponent);
    return parts.length === 3
      ? { worktreeId: decoded[0], chatId: decoded[1], name: decoded[2] }
      : { worktreeId: decoded[0], chatId: "", name: decoded[1] };
  } catch {
    return null;
  }
}

/** The hub URL of the file a tab path names. */
export function sharedFileUrl(worktreeId: string, filePath: string): string | null {
  if (!isSharedFilePath(filePath)) return null;
  const rest = filePath.slice(PATH_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  const chatId = rest.slice(0, slash);
  const name = rest.slice(slash + 1);
  if (!name) return null;
  const base = `${URL_PREFIX}${encodeURIComponent(worktreeId)}`;
  return chatId
    ? `${base}/${encodeURIComponent(chatId)}/${encodeURIComponent(name)}`
    : `${base}/${encodeURIComponent(name)}`;
}
