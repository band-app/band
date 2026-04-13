import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { useIsDark } from "../hooks/use-is-dark";
import { baseEditorExtensions, loadLanguage, searchHighlightOnly } from "../lib/codemirror-setup";
import { selectionToChatExtension } from "../lib/selection-to-chat";

interface CodeMirrorEditorProps {
  /** Initial content to populate the editor with */
  content: string;
  language: string;
  className?: string;
  /** Workspace-relative file path — enables "Add to Chat" on text selection */
  filePath?: string;
  /** Called when the EditorView is created or destroyed */
  onEditorView?: (view: EditorView | null) => void;
  /** Called whenever the document content changes */
  onContentChange?: (content: string) => void;
  /** Called when Cmd/Ctrl+S is pressed */
  onSave?: () => void;
}

export function CodeMirrorEditor({
  content,
  language,
  className,
  filePath,
  onEditorView,
  onContentChange,
  onSave,
}: CodeMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onEditorViewRef = useRef(onEditorView);
  onEditorViewRef.current = onEditorView;
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const isDark = useIsDark();

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
        ...baseEditorExtensions(isDark, () => onSaveRef.current?.()),
        searchHighlightOnly(),
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

  return <div ref={containerRef} className={className} />;
}
