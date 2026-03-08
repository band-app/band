import { ArrowLeft, FileWarning } from "lucide-react";
import { useEffect, useState } from "react";
import { useAdapter } from "../context";
import { extensionToLanguage, filenameToLanguage } from "../lib/language-map";
import type { FileContentResult } from "../types";

interface FileViewerProps {
  workspaceId: string;
  filePath: string;
  onBack: () => void;
}

let highlighterPromise: Promise<typeof import("shiki")> | null = null;

function getShiki() {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki");
  }
  return highlighterPromise;
}

function getFilename(path: string): string {
  return path.split("/").pop() || path;
}

function getExtension(path: string): string {
  const name = getFilename(path);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function detectLanguage(filePath: string, serverHint?: string): string {
  if (serverHint) return serverHint;
  const ext = getExtension(filePath);
  const fromExt = extensionToLanguage(ext);
  if (fromExt) return fromExt;
  const fromName = filenameToLanguage(getFilename(filePath));
  return fromName || "plaintext";
}

export function FileViewer({ workspaceId, filePath, onBack }: FileViewerProps) {
  const adapter = useAdapter();
  const [data, setData] = useState<FileContentResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

  useEffect(() => {
    if (!adapter.getWorkspaceFile) {
      setError("File viewing not supported");
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setHighlightedHtml(null);

    adapter
      .getWorkspaceFile(workspaceId, filePath)
      .then(async (result) => {
        if (cancelled) return;
        setData(result);

        if (result.content) {
          try {
            const lang = detectLanguage(filePath, result.language);
            const shiki = await getShiki();
            const html = await shiki.codeToHtml(result.content, {
              lang,
              theme: "github-dark",
            });
            if (!cancelled) setHighlightedHtml(html);
          } catch {
            // Fall back to plain text rendering
          }
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to read file");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [adapter, workspaceId, filePath]);

  const filename = getFilename(filePath);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex size-7 items-center justify-center rounded-md hover:bg-accent"
        >
          <ArrowLeft className="size-3.5" />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{filename}</span>
        {data && (
          <span className="shrink-0 text-xs text-muted-foreground">{formatSize(data.size)}</span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            Loading...
          </div>
        )}
        {error && (
          <div className="flex h-32 items-center justify-center text-sm text-destructive">
            {error}
          </div>
        )}
        {data?.binary && (
          <div className="flex h-32 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <FileWarning className="size-8" />
            Binary file ({formatSize(data.size)})
          </div>
        )}
        {data?.tooLarge && (
          <div className="flex h-32 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <FileWarning className="size-8" />
            File too large ({formatSize(data.size)})
          </div>
        )}
        {data?.content && highlightedHtml && <HighlightedCode html={highlightedHtml} />}
        {data?.content && !highlightedHtml && !loading && (
          <pre className="overflow-x-auto p-4 text-xs leading-5">{data.content}</pre>
        )}
      </div>
    </div>
  );
}

function HighlightedCode({ html }: { html: string }) {
  return (
    <div
      className="overflow-x-auto p-2 text-xs [&_pre]:!bg-transparent [&_code]:text-xs [&_code]:leading-5"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki generates trusted HTML from code
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
