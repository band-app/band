import { pathInside } from "../../lib/path-inside";

export const HTML_PREVIEW_EVENT = "band:preview-html";

/** Asks one browser tab to load a URL. Loading the URL it already shows reloads it. */
export const BROWSER_LOAD_EVENT = "band:browser-load";

export interface BrowserLoadDetail {
  browserId: string;
  url: string;
}

export interface HtmlPreviewDetail {
  worktreeId: string;
  path: string;
}

export function isHtmlFile(path: string): boolean {
  return /\.html?$/i.test(path);
}

/** Ask the worktree's center layout to show `path` in a Band browser tab. */
export function previewHtmlInBrowser(detail: HtmlPreviewDetail): void {
  window.dispatchEvent(new CustomEvent(HTML_PREVIEW_EVENT, { detail }));
}

/** Whether a tab URL is a preview URL for `path` in `worktreeId`, whatever its grant. */
export function isPreviewUrlFor(url: string, worktreeId: string, path: string): boolean {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return (
    url.includes(`/api/worktree-preview/${encodeURIComponent(worktreeId)}/`) &&
    url.split("?")[0].endsWith(`/${encodedPath}`)
  );
}

export interface LocalFileInput {
  /** Absolute POSIX path, percent-decoded. */
  path: string;
  /** Query string without the leading `?`, or "". */
  search: string;
  /** Fragment without the leading `#`, or "". */
  hash: string;
}

/**
 * Reads what a user typed into a browser tab's address bar as a local file
 * location, or returns null when it is not one. Accepts `file:///abs`,
 * `file://Users/...` (two slashes: the first segment is a path segment, not a
 * host), `file://localhost/abs` and a bare absolute path `/abs`. Keeps the
 * `?query` and `#fragment` and percent-decodes the path.
 */
export function parseLocalFileInput(raw: string): LocalFileInput | null {
  let rest = raw.trim();
  if (/^file:\/\//i.test(rest)) {
    rest = rest.slice("file://".length);
    if (/^localhost(?=\/|$)/i.test(rest)) rest = rest.slice("localhost".length);
    if (!rest.startsWith("/")) rest = `/${rest}`;
  } else if (!rest.startsWith("/") || rest.startsWith("//")) {
    return null;
  }
  const hashAt = rest.indexOf("#");
  const hash = hashAt === -1 ? "" : rest.slice(hashAt + 1);
  if (hashAt !== -1) rest = rest.slice(0, hashAt);
  const queryAt = rest.indexOf("?");
  const search = queryAt === -1 ? "" : rest.slice(queryAt + 1);
  if (queryAt !== -1) rest = rest.slice(0, queryAt);
  let path: string;
  try {
    path = decodeURIComponent(rest);
  } catch {
    path = rest;
  }
  path = path.replace(/\/{2,}/g, "/");
  if (path.split("/").includes("..")) return null;
  return { path, search, hash };
}

/**
 * The worktree whose folder holds `absPath` (longest folder wins), with the
 * path relative to it. Only worktrees on `hostId` are considered, because the
 * same path can exist on two workers.
 */
export function findWorktreeForPath<W extends { id: string; path: string; hostId?: string }>(
  absPath: string,
  hostId: string,
  worktrees: W[],
): { worktree: W; relPath: string } | null {
  let best: { worktree: W; relPath: string } | null = null;
  for (const worktree of worktrees) {
    if ((worktree.hostId || "local") !== hostId) continue;
    const rel = pathInside(worktree.path, absPath);
    if (rel === null) continue;
    if (!best || worktree.path.length > best.worktree.path.length) {
      best = { worktree, relPath: rel };
    }
  }
  return best;
}
