import { useEffect, useState } from "react";
import { fetchDirectFile, fileRouteWorktreeId } from "./direct-worker";
import { isDesktop } from "./is-desktop";

/** Files above this size stay on the hub, because a Blob holds the whole file in memory. */
const MAX_BLOB_BYTES = 64 * 1024 * 1024;

/**
 * The URL to show a hub file route (`/api/worktree-file`, `/api/uploads`,
 * `/api/shared`) from. In the desktop app, a file of a worktree on this
 * computer's worker is read from the worker's loopback listener and shown as a
 * Blob URL, so the token stays in a header. Everything else, and any failure,
 * keeps `url` for the hub. While the desktop app decides, the result is
 * undefined so the hub is not asked first.
 */
export function useDirectAssetUrl(url: string | undefined): string | undefined {
  const candidate = isDesktop && url !== undefined && fileRouteWorktreeId(url) !== null;
  const [resolved, setResolved] = useState<{ url: string; shown: string } | null>(null);

  useEffect(() => {
    if (!candidate || !url) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    (async () => {
      try {
        const res = await fetchDirectFile(url, { signal: controller.signal });
        const length = res?.headers.get("content-length");
        if (res?.status === 200 && length !== null && Number(length) <= MAX_BLOB_BYTES) {
          const blob = await res.blob();
          if (controller.signal.aborted) return;
          objectUrl = URL.createObjectURL(blob);
          setResolved({ url, shown: objectUrl });
          return;
        }
        await res?.body?.cancel();
      } catch {
        // Fall through to the hub.
      }
      if (!controller.signal.aborted) setResolved({ url, shown: url });
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [candidate, url]);

  if (!candidate) return url;
  return resolved?.url === url ? resolved.shown : undefined;
}
