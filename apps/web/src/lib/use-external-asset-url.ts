import { useEffect, useState } from "react";
import type { DashboardAdapter, ExternalFileContext } from "../dashboard/adapter";

export interface ExternalAsset {
  url?: string;
  error?: string;
}

/**
 * A Blob URL for an external file's bytes (a PDF, image or video outside the worktree), read
 * through the adapter so the hub's token stays in a header. The URL is revoked when the file or
 * the tab changes. `enabled` false skips the read.
 */
export function useExternalAssetUrl(
  adapter: DashboardAdapter,
  enabled: boolean,
  absolutePath: string,
  ctx: ExternalFileContext,
): ExternalAsset {
  const [state, setState] = useState<(ExternalAsset & { key: string }) | null>(null);
  const key = `${ctx.source}\n${ctx.worktreeId}\n${absolutePath}`;
  const { source, worktreeId } = ctx;

  // biome-ignore lint/correctness/useExhaustiveDependencies: key covers the file and its source
  useEffect(() => {
    if (!enabled) return;
    if (!adapter.readExternalBlob) {
      setState({ key, error: "Previewing this file is not supported here" });
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    adapter
      .readExternalBlob(absolutePath, { worktreeId, source })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ key, url: objectUrl });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({ key, error: err instanceof Error ? err.message : "Failed to read file" });
        }
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [adapter, enabled, key]);

  return enabled && state?.key === key ? state : {};
}
