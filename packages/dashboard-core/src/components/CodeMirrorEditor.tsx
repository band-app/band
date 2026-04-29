import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { useIsDark } from "../hooks/use-is-dark";
import {
  baseEditorExtensions,
  cursorLineTracker,
  historyField,
  lineHighlightExtension,
  loadLanguage,
  scrollToLine,
  searchHighlightOnly,
  serializeEditorState,
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
  /** Optional LSP extension to wire into the editor */
  lspExtension?: Extension | null;
  /** Serialized editor state (from EditorState.toJSON with historyField) to restore on creation */
  savedEditorState?: unknown;
  /** Scroll position to restore after editor creation */
  savedScrollTop?: number;
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
  lspExtension,
  savedEditorState,
  savedScrollTop,
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
  const lspExtensionRef = useRef(lspExtension);
  lspExtensionRef.current = lspExtension;
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

  const savedEditorStateRef = useRef(savedEditorState);
  savedEditorStateRef.current = savedEditorState;
  const savedScrollTopRef = useRef(savedScrollTop);
  savedScrollTopRef.current = savedScrollTop;

  // On recreation (theme/language change), we save the editor's full state
  // here so the new instance preserves everything (doc, selection, history, scroll).
  // null = first creation (use props instead).
  const recreationStateRef = useRef<{ editorState: unknown; scrollTop: number } | null>(null);

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
      if (lspExtensionRef.current) {
        extensions.push(lspExtensionRef.current);
      }
      if (langSupport) {
        extensions.push(langSupport);
      }

      // Determine how to create the editor state:
      // 1. Recreation (theme/language change) — restore full state with new extensions
      // 2. Tab switch — restore from parent-provided saved state
      // 3. First creation with cached edits — apply as undoable transaction
      // 4. Normal first creation — use content prop directly
      const savedRecreation = recreationStateRef.current;
      recreationStateRef.current = null;

      let restoreScroll: number | undefined;

      if (savedRecreation) {
        // Recreation — restore full editor state (doc, selection, undo history)
        const state = EditorState.fromJSON(
          savedRecreation.editorState,
          { extensions },
          { history: historyField },
        );
        viewRef.current = new EditorView({ state, parent: container });
        restoreScroll = savedRecreation.scrollTop;
      } else if (savedEditorStateRef.current) {
        // Tab switch — restore from parent-provided serialized state
        const state = EditorState.fromJSON(
          savedEditorStateRef.current,
          { extensions },
          { history: historyField },
        );
        viewRef.current = new EditorView({ state, parent: container });
        restoreScroll = savedScrollTopRef.current ?? undefined;
      } else {
        // First creation — use content props
        let initDoc: string;
        let pendingReplace: string | null = null;

        if (
          originalContentRef.current != null &&
          originalContentRef.current !== initialContentRef.current
        ) {
          // Cached edits — start with original content, queue edits as
          // undoable transaction (Cmd+Z reverts to original)
          initDoc = originalContentRef.current;
          pendingReplace = initialContentRef.current;
        } else {
          initDoc = initialContentRef.current;
        }

        const state = EditorState.create({ doc: initDoc, extensions });
        viewRef.current = new EditorView({ state, parent: container });

        if (pendingReplace !== null) {
          viewRef.current.dispatch({
            changes: { from: 0, to: initDoc.length, insert: pendingReplace },
          });
        }

        // Scroll to line only on first creation (not restoration)
        if (lineRef.current) {
          scrollToLine(viewRef.current, lineRef.current, lineEndRef.current, columnRef.current);
        }
      }

      // Restore scroll position and focus (for recreation and tab switch)
      if (restoreScroll != null) {
        const scroll = restoreScroll;
        requestAnimationFrame(() => {
          if (viewRef.current) {
            viewRef.current.scrollDOM.scrollTop = scroll;
            viewRef.current.focus();
          }
        });
      }

      onEditorViewRef.current?.(viewRef.current);
    };

    setup();

    return () => {
      cancelled = true;
      if (viewRef.current) {
        // Save full editor state so recreation preserves everything
        // (document, cursor/selection, undo history, scroll position)
        recreationStateRef.current = serializeEditorState(viewRef.current);
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
