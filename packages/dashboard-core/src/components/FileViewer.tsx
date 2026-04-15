import { Tooltip, TooltipContent, TooltipTrigger } from "@band-app/ui";
import type { EditorView } from "@codemirror/view";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Code,
  Eye,
  FileWarning,
  Loader2,
  Save,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAdapter } from "../context";
import { type FilePreviewType, getFilePreviewType } from "../lib/file-type";
import { extensionToLanguage, filenameToLanguage } from "../lib/language-map";
import type { FileContentResult } from "../types";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
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
  /** When true, code files open in an editable editor instead of read-only viewer */
  editable?: boolean;
  /** Called when user clicks the back navigation button */
  onGoBack?: () => void;
  /** Called when user clicks the forward navigation button */
  onGoForward?: () => void;
  /** Whether the back navigation button is enabled */
  canGoBack?: boolean;
  /** Whether the forward navigation button is enabled */
  canGoForward?: boolean;
  /** Called when the user jumps the cursor ≥10 lines (click, Page Up/Down, etc.) */
  onCursorLineChange?: (departureLine: number, arrivalLine: number) => void;
}

// localStorage-backed cache for unsaved edits — survives page reloads
const EDITS_PREFIX = "band-edits:";

function editsCacheKey(workspaceId: string, filePath: string): string {
  return `${EDITS_PREFIX}${workspaceId}\0${filePath}`;
}

const unsavedEditsCache = {
  get(key: string): string | undefined {
    try {
      return localStorage.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // quota exceeded or unavailable — silently ignore
    }
  },
  delete(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // unavailable — silently ignore
    }
  },
};

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
  editable,
  onGoBack,
  onGoForward,
  canGoBack,
  canGoForward,
  onCursorLineChange,
}: FileViewerProps) {
  const adapter = useAdapter();
  const [data, setData] = useState<FileContentResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"preview" | "source">("preview");

  // Editing state
  const [editedContent, setEditedContent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const isDirty = editedContent !== null && editedContent !== data?.content;

  const canEdit = editable && !!adapter.saveWorkspaceFile;

  const previewType: FilePreviewType = getFilePreviewType(filePath);

  // Persist unsaved edits to cache when leaving a file (navigation or unmount),
  // and restore them when returning.
  useEffect(() => {
    const key = editsCacheKey(workspaceId, filePath);
    const cached = unsavedEditsCache.get(key);
    setViewMode("preview");
    setEditedContent(cached ?? null);
    setSaveError(null);

    return () => {
      // Save current edits to cache when leaving this file
      const current = editedContentRef.current;
      if (current !== null) {
        unsavedEditsCache.set(key, current);
      } else {
        unsavedEditsCache.delete(key);
      }
    };
  }, [workspaceId, filePath]);

  // Warn before tab close when dirty
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  // Notify parent that editor view is unavailable in preview mode
  useEffect(() => {
    if (previewType !== "code" && viewMode === "preview") {
      onEditorView?.(null);
    }
  }, [previewType, viewMode, onEditorView]);

  useEffect(() => {
    // Images and PDFs are rendered via the raw file URL — no tRPC fetch needed
    if (previewType === "image" || previewType === "pdf") {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    if (!adapter.getWorkspaceFile) {
      setError("File viewing not supported");
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);

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
  }, [adapter, workspaceId, filePath, previewType]);

  const lang = data?.content ? detectLanguage(filePath, data.language) : "plaintext";

  const fileUrl = adapter.getWorkspaceFileUrl
    ? adapter.getWorkspaceFileUrl(workspaceId, filePath)
    : undefined;

  const showMarkdownToggle = previewType === "markdown" && renderMarkdown;

  // The content to display — use edited content when available, otherwise server content
  const displayContent = editedContent ?? data?.content;

  // Use a ref to avoid stale closure in the save handler
  const editedContentRef = useRef(editedContent);
  editedContentRef.current = editedContent;

  const handleSave = useCallback(async () => {
    if (!adapter.saveWorkspaceFile || editedContentRef.current === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      await adapter.saveWorkspaceFile(workspaceId, filePath, editedContentRef.current);
      // Update the data state so isDirty resets
      const savedContent = editedContentRef.current;
      setData((prev) => (prev ? { ...prev, content: savedContent } : prev));
      // Clear cache — saved content is now on disk
      unsavedEditsCache.delete(editsCacheKey(workspaceId, filePath));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [adapter, workspaceId, filePath]);

  const handleContentChange = useCallback((newContent: string) => {
    setEditedContent(newContent);
  }, []);

  const handleBack = useCallback(() => {
    if (isDirty && !window.confirm("You have unsaved changes. Discard?")) {
      return;
    }
    // Clear cache and ref so the cleanup effect doesn't re-save discarded edits
    unsavedEditsCache.delete(editsCacheKey(workspaceId, filePath));
    editedContentRef.current = null;
    onBack?.();
  }, [isDirty, onBack, workspaceId, filePath]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Title bar */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/50 px-3">
        {onBack && (
          <button
            type="button"
            onClick={handleBack}
            className="inline-flex size-6 items-center justify-center rounded-md hover:bg-accent"
          >
            <ArrowLeft className="size-3.5" />
          </button>
        )}
        {/* Editor navigation history buttons */}
        {(onGoBack || onGoForward) && (
          <div className="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onGoBack}
                  disabled={!canGoBack}
                  className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-30 disabled:pointer-events-none"
                >
                  <ChevronLeft className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                Go Back{" "}
                <kbd className="ml-1.5 rounded border border-popover-foreground/25 bg-popover-foreground/10 px-1 py-0.5 font-mono text-[14px]">
                  ⌃-
                </kbd>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onGoForward}
                  disabled={!canGoForward}
                  className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-30 disabled:pointer-events-none"
                >
                  <ChevronRight className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                Go Forward{" "}
                <kbd className="ml-1.5 rounded border border-popover-foreground/25 bg-popover-foreground/10 px-1 py-0.5 font-mono text-[14px]">
                  ⌃⇧-
                </kbd>
              </TooltipContent>
            </Tooltip>
          </div>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {filePath}
          {isDirty && <span className="ml-1 text-muted-foreground">(modified)</span>}
        </span>
        {saveError && <span className="shrink-0 text-xs text-destructive">{saveError}</span>}
        {canEdit && isDirty && (
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            title="Save (Cmd+S)"
            className="inline-flex size-6 items-center justify-center rounded-md hover:bg-accent disabled:opacity-50"
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
          </button>
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
        {data && (
          <span className="shrink-0 text-xs text-muted-foreground">{formatSize(data.size)}</span>
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

        {/* Markdown preview (rendered) — uses displayContent so edits show live */}
        {!loading &&
          !error &&
          previewType === "markdown" &&
          renderMarkdown &&
          viewMode === "preview" &&
          displayContent && (
            <div className="h-full overflow-auto">
              <div className="mx-auto max-w-3xl px-8 py-6 text-sm">
                {renderMarkdown(displayContent)}
              </div>
            </div>
          )}

        {/* Source view: editable editor or read-only viewer */}
        {!loading &&
          !error &&
          data?.content &&
          (previewType === "code" ||
            (previewType === "markdown" && (!renderMarkdown || viewMode === "source"))) &&
          (canEdit ? (
            <CodeMirrorEditor
              content={displayContent!}
              language={lang}
              className="h-full"
              filePath={filePath}
              line={line}
              lineEnd={lineEnd}
              column={column}
              onEditorView={onEditorView}
              onContentChange={handleContentChange}
              onSave={handleSave}
              onCursorLineChange={onCursorLineChange}
            />
          ) : (
            <CodeMirrorViewer
              content={data.content}
              language={lang}
              className="h-full"
              filePath={filePath}
              line={line}
              lineEnd={lineEnd}
              column={column}
              onEditorView={onEditorView}
              onCursorLineChange={onCursorLineChange}
            />
          ))}

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
