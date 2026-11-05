/** Grants last 5 minutes on the hub; drop a cached one a minute early. */
const GRANT_LIFETIME_MS = 4 * 60 * 1000;

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  zip: "application/zip",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

export function mimeForName(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot >= 0 && MIME_BY_EXT[name.slice(dot + 1).toLowerCase()]) || "application/octet-stream";
}

/** The `DownloadURL` drag data Chromium turns into a file drop: `<mime>:<name>:<absolute url>`. */
export function downloadUrlData(path: string, url: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  // The format splits on ":", so a colon in the name would break it.
  return `${mimeForName(name)}:${name.replaceAll(":", "_")}:${url}`;
}

/**
 * Grants minted ahead of a drag. `dragstart` must set `DownloadURL`
 * synchronously, so a row asks for its URL on hover and the drag reads what is
 * cached. A failed or missing grant leaves the drag as it was.
 */
export class DragGrantCache {
  private readonly entries = new Map<string, { url: string; at: number }>();
  private readonly pending = new Set<string>();

  constructor(private readonly mint: (path: string) => Promise<string>) {}

  /** The cached URL when it is still fresh. */
  peek(path: string, now = Date.now()): string | null {
    const hit = this.entries.get(path);
    return hit && now - hit.at < GRANT_LIFETIME_MS ? hit.url : null;
  }

  /** Mint a grant for `path` unless a fresh one exists or one is on its way. */
  prepare(path: string): void {
    if (this.peek(path) || this.pending.has(path)) return;
    this.pending.add(path);
    this.mint(path)
      .then((url) => this.entries.set(path, { url, at: Date.now() }))
      .catch(() => {})
      .finally(() => this.pending.delete(path));
  }
}
