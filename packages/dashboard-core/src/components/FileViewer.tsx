import type { EditorView } from "@codemirror/view";
import { ArrowLeft, Code, Eye, FileWarning } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { useAdapter } from "../context";
import { type FilePreviewType, getFilePreviewType } from "../lib/file-type";
import { extensionToLanguage, filenameToLanguage } from "../lib/language-map";
import type { FileContentResult } from "../types";
import { CodeMirrorViewer } from "./CodeMirrorViewer";
import { ImagePreview } from "./ImagePreview";
import { PdfPreview } from "./PdfPreview";

interface FileViewerProps {
  workspaceId: string;
  filePath: string;
  onBack?: () => void;
  /** 1-based line number to scroll to and highlight */
  line?: number;
  /** 1-based end line for range highlight (inclusive) */
  lineEnd?: number;
  /** 1-based column number for cursor positioning */
  column?: number;
  /** Called when the CodeMirror EditorView is created or destroyed */
  onEditorView?: (view: EditorView | null) => void;
  /** Optional toolbar rendered between the title bar and the content area */
  toolbar?: React.ReactNode;
  /** Optional markdown renderer — when provided, markdown files show a rendered preview with source toggle */
  renderMarkdown?: (content: string) => React.ReactNode;
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

export function FileViewer({
  workspaceId,
  filePath,
  onBack,
  line,
  lineEnd,
  column,
  onEditorView,
  toolbar,
  renderMarkdown,
}: FileViewerProps) {
  const adapter = useAdapter();
  const [data, setData] = useState<FileContentResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"preview" | "source">("preview");

  const previewType: FilePreviewType = getFilePreviewType(filePath);

  // Reset view mode when navigating to a different file
  // biome-ignore lint/correctness/useExhaustiveDependencies: filePath intentionally triggers reset when user navigates to a different file
  useEffect(() => {
    setViewMode("preview");
  }, [filePath]);

  // Notify parent that editor view is unavailable in preview mode
  useEffect(() => {
    if (previewType !== "code" && viewMode === "preview") {
      onEditorView?.(null);
    }
  }, [previewType, viewMode, onEditorView]);

  useEffect(() => {
    if (!adapter.getWorkspaceFile) {
      setError("File viewing not supported");
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    adapter
      .getWorkspaceFile(workspaceId, filePath)
      .then((result) => {
        if (!cancelled) setData(result);
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

  const lang = data?.content ? detectLanguage(filePath, data.language) : "plaintext";

  const fileUrl = adapter.getWorkspaceFileUrl
    ? adapter.getWorkspaceFileUrl(workspaceId, filePath)
    : undefined;

  const showMarkdownToggle = previewType === "markdown" && renderMarkdown;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Title bar */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/50 px-3">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="inline-flex size-6 items-center justify-center rounded-md hover:bg-accent"
          >
            <ArrowLeft className="size-3.5" />
          </button>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{filePath}</span>
        {data && (
          <span className="shrink-0 text-xs text-muted-foreground">{formatSize(data.size)}</span>
        )}
        {/* Markdown preview/source toggle icons */}
        {showMarkdownToggle && (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => setViewMode("preview")}
              title="Preview"
              className={`inline-flex size-6 items-center justify-center rounded-md transition-colors ${
                viewMode === "preview"
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <Eye className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode("source")}
              title="Source"
              className={`inline-flex size-6 items-center justify-center rounded-md transition-colors ${
                viewMode === "source"
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <Code className="size-3.5" />
            </button>
          </div>
        )}
      </div>

      {toolbar}

      {/* Content area */}
      <div className="min-h-0 flex-1 overflow-hidden">
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

        {/* Image preview */}
        {!loading && !error && previewType === "image" && fileUrl && (
          <ImagePreview src={fileUrl} alt={getFilename(filePath)} />
        )}

        {/* PDF preview */}
        {!loading && !error && previewType === "pdf" && fileUrl && (
          <PdfPreview src={fileUrl} filename={getFilename(filePath)} />
        )}

        {/* Markdown preview (rendered) */}
        {!loading &&
          !error &&
          previewType === "markdown" &&
          renderMarkdown &&
          viewMode === "preview" &&
          data?.content && (
            <div className="h-full overflow-auto">
              <div className="mx-auto max-w-3xl px-8 py-6 text-sm">
                {renderMarkdown(data.content)}
              </div>
            </div>
          )}

        {/* Source view: CodeMirror for markdown in source mode, or any code/text file */}
        {!loading &&
          !error &&
          data?.content &&
          (previewType === "code" ||
            (previewType === "markdown" && (!renderMarkdown || viewMode === "source"))) && (
            <CodeMirrorViewer
              content={data.content}
              language={lang}
              className="h-full"
              filePath={filePath}
              line={line}
              lineEnd={lineEnd}
              column={column}
              onEditorView={onEditorView}
            />
          )}

        {/* Binary file fallback (non-image, non-pdf) */}
        {!loading && !error && data?.binary && previewType === "code" && (
          <div className="flex h-32 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <FileWarning className="size-8" />
            Binary file ({formatSize(data.size)})
          </div>
        )}

        {/* File too large (only for code/text files — images and PDFs use the raw URL) */}
        {!loading && !error && data?.tooLarge && previewType === "code" && (
          <div className="flex h-32 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <FileWarning className="size-8" />
            File too large ({formatSize(data.size)})
          </div>
        )}
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
