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
  /** Called when Cmd/Ctrl+Z is pressed but undo history is empty (revert to disk) */
  onRevert?: () => void;
}

export function CodeMirrorEditor({
  content,
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
  onRevert,
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
  const onRevertRef = useRef(onRevert);
  onRevertRef.current = onRevert;
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

      // Destroy previous instance
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
        onEditorViewRef.current?.(null);
      }

      const extensions = [
        ...baseEditorExtensions(
          isDark,
          () => onSaveRef.current?.(),
          () => onRevertRef.current?.(),
        ),
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

      const state = EditorState.create({
        doc: initialContentRef.current,
        extensions,
      });

      viewRef.current = new EditorView({
        state,
        parent: container,
      });

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
