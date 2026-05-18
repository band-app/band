import { Tooltip, TooltipContent, TooltipTrigger } from "@band-app/ui";
import type { Extension } from "@codemirror/state";
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
import {
  extensionToLanguage,
  filenameToLanguage,
  languageLabel,
  languageToExtension,
} from "../lib/language-map";
import type { FileContentResult } from "../types";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { CodeMirrorViewer } from "./CodeMirrorViewer";
import { ImagePreview } from "./ImagePreview";
import { LanguagePickerDialog } from "./LanguagePickerDialog";
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
  /** When true, hides the title bar (path, size, nav arrows). */
  hideTitleBar?: boolean;
  /** Controlled view mode for markdown files (preview vs source). When provided, FileViewer uses this instead of internal state. */
  viewMode?: "preview" | "source";
  /** Called when the user toggles between preview and source mode. */
  onViewModeChange?: (mode: "preview" | "source") => void;
  /** Optional LSP extension to wire into the editor for code intelligence */
  lspExtension?: Extension | null;
  /** Initial edited content to restore (from tab state). null = no cached edits. */
  initialEditedContent?: string | null;
  /** Serialized CodeMirror editor state to restore on creation */
  savedEditorState?: unknown;
  /** Scroll position to restore after editor creation */
  savedScrollTop?: number;
  /** Called when edited content changes (for persistence to tab state) */
  onEditedContentChange?: (content: string | null) => void;
  /**
   * When true, `filePath` is treated as an absolute filesystem path
   * outside the workspace root (the "Open File…" flow), and reads
   * /writes go through the host file IO surface
   * (`adapter.readExternalFile` / `adapter.saveExternalFile`) instead of
   * the workspace one. `workspaceId` is still required by the prop
   * shape but is unused on this path — image/PDF preview URLs and LSP
   * are intentionally not wired for external files.
   */
  external?: boolean;
  /**
   * When true, the viewer renders an untitled (scratch) buffer that
   * has no backing file. `filePath` carries the synthetic `untitled:N`
   * key from `useFileTabs`; no remote IO happens (no `getWorkspaceFile`
   * / `readExternalFile` call). Buffer state lives entirely in
   * `initialEditedContent` / `onEditedContentChange` until the user
   * picks a destination via `onSaveAs` — that callback is responsible
   * for surfacing the OS save dialog (gated on
   * `capabilities.pickSaveFile`) and transitioning the tab to a
   * file-backed one.
   */
  untitled?: boolean;
  /**
   * Manual syntax-highlighting language override (e.g. `"typescript"`,
   * `"markdown"`, `"plaintext"`). When set, takes precedence over
   * file-extension auto-detection — the user's explicit choice in the
   * language picker survives saves and tab restores.
   */
  languageOverride?: string;
  /**
   * Called when the user picks a language from the editor's language
   * indicator dropdown / "Change Language Mode…" command. The caller
   * persists the choice to tab state so it survives tab switches.
   */
  onLanguageOverrideChange?: (languageId: string) => void;
  /**
   * Save-as flow for untitled tabs. Called when the user hits Cmd+S on
   * an untitled buffer (or the close-confirm "Save" button). Receives
   * the live editor content and is expected to surface the OS save
   * dialog, persist the bytes, and resolve with the chosen absolute
   * path — at which point the caller transitions the tab to file-
   * backed. Resolves with `null` when the user cancels the save dialog
   * so the close path can keep the tab open.
   */
  onSaveAs?: (content: string) => Promise<string | null>;
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
  editable,
  onGoBack,
  onGoForward,
  canGoBack,
  canGoForward,
  onCursorLineChange,
  hideTitleBar,
  viewMode: controlledViewMode,
  onViewModeChange,
  lspExtension,
  initialEditedContent,
  savedEditorState,
  savedScrollTop,
  onEditedContentChange,
  external,
  untitled,
  languageOverride,
  onLanguageOverrideChange,
  onSaveAs,
}: FileViewerProps) {
  const adapter = useAdapter();
  const [data, setData] = useState<FileContentResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [internalViewMode, setInternalViewMode] = useState<"preview" | "source">("preview");

  // Support both controlled and uncontrolled view mode
  const viewMode = controlledViewMode ?? internalViewMode;
  const setViewMode = onViewModeChange ?? setInternalViewMode;

  // Editing state
  const [editedContent, setEditedContent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Status banner for the ⇧⌘F "Format Current File" action. Kept separate
  // from `saveError` so a successful format flash doesn't get swallowed by
  // an unrelated stale save error. `kind: "info"` covers the soft-skip
  // path (unsupported file extension); error covers Prettier syntax errors.
  const [formatStatus, setFormatStatus] = useState<{
    kind: "ok" | "error" | "info";
    message: string;
  } | null>(null);
  // `formatting` drives the spinner in the toolbar; `formattingRef` is the
  // re-entrancy guard. We can't use the React-state value as the guard —
  // setState is async, so two ⇧⌘F presses inside the same React batch
  // would both observe `formatting === false` and proceed in parallel. The
  // ref flips synchronously on call entry and clears in `finally`.
  const [formatting, setFormatting] = useState(false);
  const formattingRef = useRef(false);

  const editorViewRef = useRef<EditorView | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  // Untitled tabs are "dirty" whenever they have any content typed in —
  // there's no on-disk baseline to compare against. An empty buffer
  // counts as clean so closing an untouched scratch tab doesn't pop
  // the unsaved-changes confirmation.
  const isDirty = untitled
    ? editedContent != null && editedContent !== ""
    : editedContent !== null && editedContent !== data?.content;

  // Untitled tabs are *always* editable — the buffer lives entirely in
  // the renderer, so typing into it has nothing to do with whether a
  // save mechanism is available. `canSave` (below) gates the Save
  // button separately, so in a web build (no `onSaveAs` because
  // `capabilities.pickSaveFile` is undefined) the user can still draft
  // text into an untitled tab; only persistence requires the desktop
  // shell.
  //
  // Before this split, an untitled tab created from a non-desktop
  // entry point fell through to `CodeMirrorViewer` (read-only), which
  // looked like "the editor is empty and I can't type" — issue raised
  // post-review and fixed here.
  const canEdit =
    editable &&
    (untitled ? true : external ? !!adapter.saveExternalFile : !!adapter.saveWorkspaceFile);

  const canSave = untitled
    ? !!onSaveAs
    : external
      ? !!adapter.saveExternalFile
      : !!adapter.saveWorkspaceFile;

  // Untitled tabs never have a backing file extension to drive the
  // preview-type heuristic — force "code" so the editor renders rather
  // than the image/PDF/markdown branches.
  const previewType: FilePreviewType = untitled ? "code" : getFilePreviewType(filePath);

  // Reset editing state when switching files.
  // Edited content is initialized from the parent's tab state (via prop).
  // No cleanup effect needed — the parent saves content on every keystroke
  // via onEditedContentChange and saves editor state in handleTabSelect.
  // biome-ignore lint/correctness/useExhaustiveDependencies: controlledViewMode and initialEditedContent are intentionally excluded — we only reset on file change
  useEffect(() => {
    if (!controlledViewMode) setInternalViewMode("preview");
    setEditedContent(initialEditedContent ?? null);
    setSaveError(null);
    setFormatStatus(null);
  }, [workspaceId, filePath]);

  // Listen for discard-edits events from handleTabClose.  When the parent
  // closes a tab with "Close Without Saving", it dispatches this event
  // BEFORE the tab switch so we can null out the ref synchronously.
  // The cleanup effect (above) then sees null and skips re-saving.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.filePath === filePath) {
        editedContentRef.current = null;
        setEditedContent(null);
      }
    };
    window.addEventListener("band:discard-edits", handler);
    return () => window.removeEventListener("band:discard-edits", handler);
  }, [filePath]);

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
    // Untitled tabs have no backing file — synthesise an empty
    // content record so the rest of the render pipeline (canEdit
    // check, CodeMirrorEditor mount, dirty-state diff against
    // `data?.content`) keeps its existing shape. `initialEditedContent`
    // (threaded by the parent from useTabState) carries any in-memory
    // typing the user has done so far.
    if (untitled) {
      setData({ content: "", size: 0, binary: false, tooLarge: false });
      setLoading(false);
      setError(null);
      return;
    }

    // Images and PDFs are rendered via the raw file URL — no tRPC fetch needed.
    // External files don't have a workspace-relative URL; for the moment we
    // fall through to the text-content path (binary detection will catch
    // genuine images), since opening an arbitrary binary outside the workspace
    // root is rare and the image preview UI isn't a goal of the external-file
    // flow.
    if (!external && (previewType === "image" || previewType === "pdf")) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    const loader = external ? adapter.readExternalFile : adapter.getWorkspaceFile;
    if (!loader) {
      setError("File viewing not supported");
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);

    const promise = external
      ? adapter.readExternalFile!(filePath)
      : adapter.getWorkspaceFile!(workspaceId, filePath);
    promise
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
  }, [adapter, workspaceId, filePath, previewType, external, untitled]);

  // The user's explicit choice from the language picker always wins over
  // file-extension detection (issue #434: "manual override sticks for the
  // lifetime of the tab"). Untitled tabs default to plain text; file-
  // backed tabs fall through to the existing detection path.
  const lang = languageOverride
    ? languageOverride
    : untitled
      ? "plaintext"
      : data?.content
        ? detectLanguage(filePath, data.language)
        : "plaintext";

  // External files don't have a workspace-relative raw URL endpoint, so
  // image/PDF rendering for external paths is intentionally not wired.
  const fileUrl =
    !external && adapter.getWorkspaceFileUrl
      ? adapter.getWorkspaceFileUrl(workspaceId, filePath)
      : undefined;

  const showMarkdownToggle = previewType === "markdown" && renderMarkdown;

  // The content to display — use edited content when available, otherwise server content
  const displayContent = editedContent ?? data?.content;

  // Use refs to avoid stale closures in handlers
  const editedContentRef = useRef(editedContent);
  editedContentRef.current = editedContent;
  const onEditedContentChangeRef = useRef(onEditedContentChange);
  onEditedContentChangeRef.current = onEditedContentChange;

  const handleSave = useCallback(async () => {
    // Untitled tabs route through the OS save dialog (`onSaveAs`).
    // We use the *live* editor buffer rather than `editedContentRef`
    // because an empty untitled buffer never sets edited content
    // (isDirty filters out the empty string), so editedContentRef can
    // legitimately be null even when the user wants to save an
    // empty file from a fresh untitled tab.
    if (untitled) {
      if (!onSaveAs) return;
      const content = editorViewRef.current?.state.doc.toString() ?? editedContentRef.current ?? "";
      setSaving(true);
      setSaveError(null);
      try {
        // `onSaveAs` is responsible for the OS dialog, the file
        // write, and the tab transition. Cancellation resolves with
        // null — keep the tab as-is.
        const newPath = await onSaveAs(content);
        if (newPath != null) {
          // The parent has already swapped the tab key from
          // `untitled:N` to the real path; this component will be
          // remounted under the new filePath, so we don't need to
          // clear local state.
          window.dispatchEvent(new CustomEvent("band:dirty-change"));
        }
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Failed to save");
      } finally {
        setSaving(false);
      }
      return;
    }
    if (editedContentRef.current === null) return;
    const save = external
      ? adapter.saveExternalFile && ((c: string) => adapter.saveExternalFile!(filePath, c))
      : adapter.saveWorkspaceFile &&
        ((c: string) => adapter.saveWorkspaceFile!(workspaceId, filePath, c));
    if (!save) return;
    setSaving(true);
    setSaveError(null);
    try {
      await save(editedContentRef.current);
      // Update the data state so isDirty resets
      const savedContent = editedContentRef.current;
      setData((prev) => (prev ? { ...prev, content: savedContent } : prev));
      // Clear edited content — saved content is now on disk
      setEditedContent(null);
      onEditedContentChangeRef.current?.(null);
      window.dispatchEvent(new CustomEvent("band:dirty-change"));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [adapter, workspaceId, filePath, external, untitled, onSaveAs]);

  /**
   * Format the editor buffer in-place via Prettier.
   *
   * Server-side is pure — it takes the current editor content as a
   * string, formats it, and returns the result. Disk is untouched: any
   * unsaved edits stay unsaved, and the formatted output replaces the
   * editor buffer the same way a user-typed change would. The user
   * decides when to save with Cmd+S.
   *
   * Soft-skip outcomes (no Prettier parser, `.prettierignore` match)
   * render as a muted info message so editor save hooks can fire this
   * indiscriminately without yelling at the user for `.png` files.
   */
  const handleFormat = useCallback(async (): Promise<void> => {
    if (!adapter.formatWorkspaceFile) {
      setFormatStatus({ kind: "error", message: "Formatting not supported by this adapter" });
      return;
    }
    // Re-entrancy guard. Intentionally silent: a second ⌘⇧F press while a
    // format is in flight is a no-op rather than a queued retry. The
    // existing spinner is still visible (`formatting` state hasn't been
    // cleared), so the user sees "format is happening" from the first
    // press — adding feedback for the dropped second press would mostly
    // be noise.
    if (formattingRef.current) return;

    // Read the live buffer straight off the EditorView so we always
    // pick up unsaved keystrokes. Fall back to `editedContent` / `data`
    // (read-only viewer case, or any timing edge where the view ref is
    // null) so the in-memory shape stays canonical.
    const view = editorViewRef.current;
    const sourceContent =
      view?.state.doc.toString() ?? editedContentRef.current ?? dataRef.current?.content ?? null;
    if (sourceContent === null) {
      setFormatStatus({ kind: "error", message: "No content to format" });
      return;
    }

    formattingRef.current = true;
    setFormatting(true);
    setFormatStatus(null);
    try {
      // Untitled tabs have no real extension for Prettier to dispatch
      // on — synthesize a virtual filename inside the workspace from
      // the user's language choice (`languageOverride`) so the server-
      // side formatter picks the right parser. Untitled tabs default
      // to plain text, which Prettier has no parser for; short-circuit
      // with an actionable message instead of the generic "no parser
      // available" soft-skip — first-run users were confused by it
      // because the muted info-status easily reads as "format ran but
      // did nothing" when in fact the formatter never even got the
      // request.
      let formatPath = filePath;
      if (untitled) {
        const ext = languageOverride ? languageToExtension(languageOverride) : undefined;
        if (!ext) {
          setFormatStatus({
            kind: "info",
            message: "Set a language mode first to format this untitled tab",
          });
          return;
        }
        // The server's formatter requires the path to resolve inside
        // the worktree; using a leading "." filename keeps it inside
        // the workspace root and doesn't clobber any real file.
        formatPath = `.band-untitled${ext}`;
      }
      const result = await adapter.formatWorkspaceFile(workspaceId, formatPath, sourceContent);
      if (result.skipped) {
        setFormatStatus({ kind: "info", message: result.reason });
        return;
      }

      if (result.changed) {
        const formatted = result.formatted;
        if (view) {
          // CodeMirrorEditor intentionally ignores `content` prop
          // changes after initial creation (the editor owns its
          // buffer), so we drive the update through the live
          // EditorView. Tag it `band.format` so a single Cmd+Z reverts
          // the format back to what the user had typed before.
          const currentDoc = view.state.doc.toString();
          if (currentDoc !== formatted) {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: formatted },
              userEvent: "band.format",
            });
          }
        } else {
          // Read-only viewer / no live editor (e.g. markdown preview
          // pane). The CodeMirrorViewer keys its document on the
          // `content` prop, so swapping `editedContent` here is enough
          // to re-render it with the formatted bytes.
          setEditedContent(formatted);
          onEditedContentChangeRef.current?.(formatted);
          window.dispatchEvent(new CustomEvent("band:dirty-change"));
        }
      }

      setFormatStatus({
        kind: "ok",
        message: result.changed ? "Formatted" : "Already formatted",
      });
    } catch (err) {
      setFormatStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to format",
      });
    } finally {
      formattingRef.current = false;
      setFormatting(false);
    }
  }, [adapter, workspaceId, filePath, untitled, languageOverride]);

  // Listen for the global "Format Current File" event (⌘⇧F + palette).
  // Only one FileViewer is mounted per workspace at a time, so the
  // `workspaceId` guard is sufficient — we deliberately do NOT filter
  // by `detail.filePath` for the same reason the language-picker
  // listener doesn't: the dispatcher reads `currentFileRef.current`,
  // which is only updated by `notifySelectFile` (which drops untitled
  // and external paths). So when the user is viewing an untitled tab,
  // `detail.filePath` is either undefined or stale (pointing at the
  // previously-viewed real file), and a strict equality check would
  // reject the legitimate "format this untitled tab" case.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { workspaceId?: string; filePath?: string | null }
        | undefined;
      if (!detail || detail.workspaceId !== workspaceId) return;
      void handleFormat();
    };
    window.addEventListener("band:format-current-file", handler);
    return () => window.removeEventListener("band:format-current-file", handler);
  }, [workspaceId, handleFormat]);

  // Auto-clear the "Formatted" success flash so it doesn't linger next to
  // the filename. Errors stay until the user changes files or saves.
  useEffect(() => {
    if (formatStatus?.kind !== "ok") return;
    const timer = window.setTimeout(() => setFormatStatus(null), 2500);
    return () => window.clearTimeout(timer);
  }, [formatStatus]);

  const handleContentChange = useCallback((newContent: string) => {
    // When undo brings the content back to the on-disk version, clear
    // the edited state entirely so the dirty indicators (title bar +
    // tab dot) disappear.
    if (newContent === dataRef.current?.content) {
      setEditedContent(null);
      onEditedContentChangeRef.current?.(null);
    } else {
      setEditedContent(newContent);
      onEditedContentChangeRef.current?.(newContent);
    }
    // Notify FileTabBar (and any other listener) that dirty state changed
    window.dispatchEvent(new CustomEvent("band:dirty-change"));
  }, []);

  // Capture the EditorView locally (for revert) while forwarding to the parent
  const handleEditorView = useCallback(
    (view: EditorView | null) => {
      editorViewRef.current = view;
      onEditorView?.(view);
    },
    [onEditorView],
  );

  const handleBack = useCallback(() => {
    if (isDirty && !window.confirm("You have unsaved changes. Discard?")) {
      return;
    }
    // Clear dirty state
    setEditedContent(null);
    onEditedContentChangeRef.current?.(null);
    onBack?.();
  }, [isDirty, onBack]);

  // Searchable language-mode picker (issue #434). Opens from the
  // status-bar language indicator or the "Change Language Mode…" palette
  // entry; in both cases we dispatch / listen to a single event so the
  // wiring stays symmetrical with Quick Open / Search in Files.
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { workspaceId?: string; filePath?: string | null }
        | undefined;
      // Only one FileViewer is mounted per workspace at a time, so the
      // workspaceId guard is sufficient. We deliberately do NOT filter
      // by `detail.filePath`:
      //
      // The dispatcher (DockviewWorkspaceLayout) reads
      // `currentFileRef.current`, which is only updated through
      // `notifySelectFile` — and that path filters out untitled and
      // external tabs (their synthetic / absolute paths can't round-
      // trip through the workspace-relative URL). So `detail.filePath`
      // will be undefined for never-selected tabs AND stale (pointing
      // at the previously viewed real file) whenever the user is
      // currently viewing an untitled tab. A `detail.filePath !==
      // filePath` check would reject the legitimate "open picker for
      // the currently visible untitled tab" case.
      if (!detail || detail.workspaceId !== workspaceId) return;
      setLanguagePickerOpen(true);
    };
    window.addEventListener("band:open-language-picker", handler);
    return () => window.removeEventListener("band:open-language-picker", handler);
  }, [workspaceId]);

  const handlePickLanguage = useCallback(
    (languageId: string) => {
      onLanguageOverrideChange?.(languageId);
    },
    [onLanguageOverrideChange],
  );

  return (
    // min-w-0 prevents intrinsic-width content (CodeMirror's long unwrapped
    // lines, in particular) from forcing this box wider than its allocated
    // flex slot, which would propagate up and shove neighbouring layout
    // (e.g. the right-edge tab strip) off-screen.
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      {/* Title bar — full version (mobile / non-tab views) */}
      {!hideTitleBar && (
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
            {untitled ? "Untitled" : filePath}
            {isDirty && <span className="ml-1 text-muted-foreground">(modified)</span>}
          </span>
          {saveError && <span className="shrink-0 text-xs text-destructive">{saveError}</span>}
          {formatStatus && (
            <span
              className={`shrink-0 truncate text-xs ${
                formatStatus.kind === "error"
                  ? "text-destructive"
                  : formatStatus.kind === "ok"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground"
              }`}
              title={formatStatus.message}
            >
              {formatStatus.kind === "error" ? "Format failed" : formatStatus.message}
            </span>
          )}
          {formatting && (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          )}
          {canSave && isDirty && (
            // Gate on canSave (which requires a working save target —
            // adapter method for file-backed tabs, `onSaveAs` for
            // untitled ones) rather than canEdit, so an untitled tab in
            // the web build still renders an editable surface even
            // though no Save button can appear.
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              title="Save (Cmd+S)"
              className="inline-flex size-6 items-center justify-center rounded-md hover:bg-accent disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
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
      )}
      {toolbar}

      {/* Content area */}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
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

        {/* Markdown preview (rendered) — uses displayContent so edits show live.
             Note: check `!== undefined` not truthiness so an empty file
             (content === "") still renders the preview pane. */}
        {!loading &&
          !error &&
          previewType === "markdown" &&
          renderMarkdown &&
          viewMode === "preview" &&
          displayContent !== undefined && (
            <div className="h-full overflow-auto">
              <div className="mx-auto max-w-3xl px-8 py-6 text-sm">
                {renderMarkdown(displayContent)}
              </div>
            </div>
          )}

        {/* Source view: editable editor or read-only viewer.
             Same undefined-check as the markdown branch — empty files
             are still valid and must surface the editor. */}
        {!loading &&
          !error &&
          data?.content !== undefined &&
          (previewType === "code" ||
            (previewType === "markdown" && (!renderMarkdown || viewMode === "source"))) &&
          (canEdit ? (
            <CodeMirrorEditor
              content={displayContent ?? ""}
              originalContent={data.content}
              language={lang}
              className="h-full"
              filePath={filePath}
              line={line}
              lineEnd={lineEnd}
              column={column}
              onEditorView={handleEditorView}
              onContentChange={handleContentChange}
              onSave={handleSave}
              onCursorLineChange={onCursorLineChange}
              lspExtension={lspExtension}
              savedEditorState={savedEditorState}
              savedScrollTop={savedScrollTop}
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

      {/* Status bar — language indicator (click to change). Rendered for
          every editor tab (untitled and file-backed) so the picker
          surface is always reachable; we gate on the picker callback
          being wired rather than the file type so the host can opt
          panels in/out. */}
      {onLanguageOverrideChange && previewType === "code" && (
        <div className="flex h-6 shrink-0 items-center justify-end gap-2 border-t border-border/50 bg-background px-2 text-xs">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setLanguagePickerOpen(true)}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                {languageLabel(lang)}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              Select Language Mode
            </TooltipContent>
          </Tooltip>
        </div>
      )}

      <LanguagePickerDialog
        open={languagePickerOpen}
        onOpenChange={setLanguagePickerOpen}
        currentLanguage={lang}
        onSelect={handlePickLanguage}
      />
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
