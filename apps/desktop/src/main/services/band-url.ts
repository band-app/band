/**
 * Parses `band://file/<absolute path>[:line[:col]]`, the URL other apps use to open a path in Band
 * (the same shape as `zed://file/<path>`). Any app can open a band:// URL, so the parser only
 * returns a path and a position. It never returns a command. The mobile app's `band://pair?...`
 * is a different route on a different platform, and a route this app does not know is `unknown`.
 * No Electron import, so `node:test` can drive it.
 */

import { posix } from "node:path";

export type BandUrl =
  | { kind: "file"; path: string; line?: number; column?: number }
  | { kind: "unknown"; reason: string };

const POSITION = /^(.*?):(\d+)(?::(\d+))?$/;

export function parseBandUrl(raw: string): BandUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "unknown", reason: "not a URL" };
  }
  if (url.protocol !== "band:") return { kind: "unknown", reason: "not a band:// URL" };
  if (url.hostname !== "file")
    return { kind: "unknown", reason: `unknown route "${url.hostname}"` };

  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return { kind: "unknown", reason: "path is not valid percent-encoding" };
  }
  let path = decoded;
  let line: number | undefined;
  let column: number | undefined;
  const match = POSITION.exec(decoded);
  if (match) {
    path = match[1] ?? "";
    line = Number(match[2]);
    if (match[3] !== undefined) column = Number(match[3]);
  }
  if (!path.startsWith("/") || path.includes("\0")) {
    return { kind: "unknown", reason: "path is not absolute" };
  }
  path = posix.normalize(path);
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return { kind: "file", path, ...(line ? { line } : {}), ...(column ? { column } : {}) };
}
