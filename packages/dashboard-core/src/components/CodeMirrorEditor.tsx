import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { useIsDark } from "../hooks/use-is-dark";
import {
  baseEditorExtensions,
  cursorLineTracker,
  lineHighlightExtension,
  loadLanguage,
  scrollToLine,
  searchHighlightOnly,
  setHighlightLines,
} from "../lib/codemirror-setup";
import { selectionToChatExtension } from "../lib/selection-to-chat";

interface CodeMirrorEditorProps {
  /** Initial content to populate the editor with */
  content: string;
  /**
   * Original on-disk content. When provided and differs from `content`,
   * the editor initializes with this first, then applies `content` as an
   * undoable transaction so Cmd+Z can revert to the original.
   * This is used when restoring cached edits after page reload.
   */
  originalContent?: string;
  language: string;
  className?: string;
  /** Workspace-relative file path — enables "Add to Chat" on text selection */
  filePath?: string;
  /** 1-based line number to scroll to and highlight */
  line?: number;
  /** 1-based end line for range highlighting */
  lineEnd?: number;
  /** 1-based column offset */
  column?: number;
  /** Called when the EditorView is created or destroyed */
  onEditorView?: (view: EditorView | null) => void;
  /** Called whenever the document content changes */
  onContentChange?: (content: string) => void;
  /** Called when Cmd/Ctrl+S is pressed */
  onSave?: () => void;
  /** Called when the user jumps the cursor ≥10 lines (click, Page Up/Down, etc.) */
  onCursorLineChange?: (departureLine: number, arrivalLine: number) => void;
}

export function CodeMirrorEditor({
  content,
  originalContent,
  language,
  className,
  filePath,
  line,
  lineEnd,
  column,
  onEditorView,
  onContentChange,
  onSave,
  onCursorLineChange,
}: CodeMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onEditorViewRef = useRef(onEditorView);
  onEditorViewRef.current = onEditorView;
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onCursorLineChangeRef = useRef(onCursorLineChange);
  onCursorLineChangeRef.current = onCursorLineChange;
  const isDark = useIsDark();

  // Store line props in refs so the creation effect can read them without re-running
  const lineRef = useRef(line);
  const lineEndRef = useRef(lineEnd);
  const columnRef = useRef(column);
  lineRef.current = line;
  lineEndRef.current = lineEnd;
  columnRef.current = column;

  // Store content in a ref so the editor creation effect reads the latest
  // value without re-running on every content prop change.
  const initialContentRef = useRef(content);
  initialContentRef.current = content;

  const originalContentRef = useRef(originalContent);
  originalContentRef.current = originalContent;

  // On recreation (theme/language change), we save the editor's current
  // document here so the new instance preserves the user's edits.
  // null = first creation (use props instead).
  const recreationDocRef = useRef<string | null>(null);

  // Create/recreate the editor when language or theme changes.
  // We intentionally do NOT depend on `content` — the editor owns
  // the document once created. Only language/theme/filePath changes
  // warrant a full recreation.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;

    const setup = async () => {
      const langSupport = await loadLanguage(language);
      if (cancelled) return;

      // Destroy previous instance — current doc was already saved in cleanup
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
        onEditorViewRef.current?.(null);
      }

      const extensions = [
        ...baseEditorExtensions(isDark, () => onSaveRef.current?.()),
        searchHighlightOnly(),
        ...lineHighlightExtension(isDark),
        cursorLineTracker((departureLine, arrivalLine) =>
          onCursorLineChangeRef.current?.(departureLine, arrivalLine),
        ),
        // Listener for content changes
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onContentChangeRef.current?.(update.state.doc.toString());
          }
        }),
      ];
      if (filePath) {
        extensions.push(selectionToChatExtension(filePath));
      }
      if (langSupport) {
        extensions.push(langSupport);
      }

      // Determine the initial document:
      // 1. Recreation (theme/language change) → use the saved document
      // 2. First creation with cached edits → start with original so cached
      //    edits become an undoable transaction (Cmd+Z reverts to original)
      // 3. Normal first creation → use content prop directly
      const savedDoc = recreationDocRef.current;
      recreationDocRef.current = null;

      let initDoc: string;
      let pendingReplace: string | null = null;

      if (savedDoc !== null) {
        // Recreation — preserve the user's current document
        initDoc = savedDoc;
      } else if (
        originalContentRef.current != null &&
        originalContentRef.current !== initialContentRef.current
      ) {
        // First creation with cached edits — start with original content
        // and queue the cached edits as an undoable transaction
        initDoc = originalContentRef.current;
        pendingReplace = initialContentRef.current;
      } else {
        // Normal creation — no cached edits
        initDoc = initialContentRef.current;
      }

      const state = EditorState.create({
        doc: initDoc,
        extensions,
      });

      viewRef.current = new EditorView({
        state,
        parent: container,
      });

      // Apply cached edits as a transaction so they appear in undo history.
      // After this, Cmd+Z will revert back to the original disk content.
      if (pendingReplace !== null) {
        viewRef.current.dispatch({
          changes: { from: 0, to: initDoc.length, insert: pendingReplace },
        });
      }

      // Scroll to line after creation
      if (lineRef.current) {
        scrollToLine(viewRef.current, lineRef.current, lineEndRef.current, columnRef.current);
      }

      onEditorViewRef.current?.(viewRef.current);
    };

    setup();

    return () => {
      cancelled = true;
      if (viewRef.current) {
        // Save current document so recreation preserves user edits
        recreationDocRef.current = viewRef.current.state.doc.toString();
        viewRef.current.destroy();
        viewRef.current = null;
        onEditorViewRef.current?.(null);
      }
    };
  }, [language, isDark, filePath]);

  // Handle line/lineEnd/column changes without recreating the editor
  useEffect(() => {
    if (!viewRef.current) return;
    if (line) {
      scrollToLine(viewRef.current, line, lineEnd, column);
    } else {
      // Clear highlight when line is removed
      viewRef.current.dispatch({
        effects: setHighlightLines.of(null),
      });
    }
  }, [line, lineEnd, column]);

  return <div ref={containerRef} className={className} />;
}
