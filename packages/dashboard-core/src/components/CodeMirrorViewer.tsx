import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { useIsDark } from "../hooks/use-is-dark";
import {
  baseViewerExtensions,
  cursorLineTracker,
  lineHighlightExtension,
  loadLanguage,
  scrollToLine,
  searchHighlightOnly,
  setHighlightLines,
} from "../lib/codemirror-setup";
import { selectionToChatExtension } from "../lib/selection-to-chat";

interface CodeMirrorViewerProps {
  content: string;
  language: string;
  className?: string;
  /** Workspace-relative file path — enables "Add to Chat" on text selection */
  filePath?: string;
  /** 1-based line number to scroll to and highlight */
  line?: number;
  /** 1-based end line for range highlight (inclusive). Uses dash syntax: file:5-10 */
  lineEnd?: number;
  /** 1-based column number for cursor positioning. Uses colon syntax: file:5:10 */
  column?: number;
  /** Called when the EditorView is created or destroyed */
  onEditorView?: (view: EditorView | null) => void;
  /** Called when the user jumps the cursor ≥10 lines (click, Page Up/Down, etc.) */
  onCursorLineChange?: (departureLine: number, arrivalLine: number) => void;
}

export function CodeMirrorViewer({
  content,
  language,
  className,
  filePath,
  line,
  lineEnd,
  column,
  onEditorView,
  onCursorLineChange,
}: CodeMirrorViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onEditorViewRef = useRef(onEditorView);
  onEditorViewRef.current = onEditorView;
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

  // Create/recreate the editor when content, language, or theme changes
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
        ...baseViewerExtensions(isDark),
        searchHighlightOnly(),
        ...lineHighlightExtension(isDark),
        cursorLineTracker((departureLine, arrivalLine) => onCursorLineChangeRef.current?.(departureLine, arrivalLine)),
      ];
      if (filePath) {
        extensions.push(selectionToChatExtension(filePath));
      }
      if (langSupport) {
        extensions.push(langSupport);
      }

      const state = EditorState.create({
        doc: content,
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
  }, [content, language, isDark, filePath]);

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
