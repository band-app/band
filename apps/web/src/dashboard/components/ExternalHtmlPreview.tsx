import { useEffect, useState } from "react";
import type { DashboardAdapter, ExternalFileContext } from "../adapter";

interface ExternalHtmlPreviewProps {
  adapter: DashboardAdapter;
  absolutePath: string;
  ctx: ExternalFileContext;
  /** The file as it is on disk. The page reloads when it changes. */
  diskContent?: string;
}

/**
 * An HTML file outside the worktree in a sandboxed iframe (scripts only, no same-origin, so the
 * page cannot reach Band's cookies, token or storage). The URL is a grant for the file's folder, so
 * relative CSS, images and scripts beside the file load. Read-only: visual editing is for
 * worktree files.
 */
export function ExternalHtmlPreview({
  adapter,
  absolutePath,
  ctx,
  diskContent,
}: ExternalHtmlPreviewProps) {
  const [state, setState] = useState<{ url?: string; error?: string } | null>(null);
  const { source, worktreeId } = ctx;

  // biome-ignore lint/correctness/useExhaustiveDependencies: diskContent reloads the page
  useEffect(() => {
    if (!adapter.getExternalHtmlPreviewUrl) {
      setState({ error: "Previewing this file is not supported here" });
      return;
    }
    let cancelled = false;
    adapter
      .getExternalHtmlPreviewUrl(absolutePath, { worktreeId, source })
      .then((url) => {
        if (!cancelled) setState({ url });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({ error: err instanceof Error ? err.message : "Failed to preview the file" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [adapter, absolutePath, source, worktreeId, diskContent]);

  if (state?.error) {
    return (
      <div
        data-testid="file-viewer__error"
        className="flex h-32 items-center justify-center text-sm text-destructive"
      >
        {state.error}
      </div>
    );
  }
  if (!state?.url) return null;
  return (
    <iframe
      key={state.url}
      data-testid="file-viewer__external-html-preview"
      title={absolutePath}
      src={state.url}
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
      className="h-full w-full border-0"
    />
  );
}
