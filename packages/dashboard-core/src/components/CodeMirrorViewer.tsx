import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { useIsDark } from "../hooks/use-is-dark";
import { baseViewerExtensions, loadLanguage, openFileSearchPanel } from "../lib/codemirror-setup";

interface CodeMirrorViewerProps {
  content: string;
  language: string;
  className?: string;
  /** Called when the EditorView is created or destroyed */
  onEditorView?: (view: EditorView | null) => void;
}

export function CodeMirrorViewer({
  content,
  language,
  className,
  onEditorView,
}: CodeMirrorViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onEditorViewRef = useRef(onEditorView);
  onEditorViewRef.current = onEditorView;
  const isDark = useIsDark();

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

      const extensions = [...baseViewerExtensions(isDark)];
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
  }, [content, language, isDark]);

  // Listen for find-in-file custom event dispatched by the workspace layout
  useEffect(() => {
    const handler = () => {
      const view = viewRef.current;
      console.log("[band:find-in-file] handler fired, view:", !!view);
      if (view) {
        view.focus();
        const result = openFileSearchPanel(view);
        console.log("[band:find-in-file] openSearchPanel result:", result);
      }
    };
    window.addEventListener("band:find-in-file", handler);
    return () => window.removeEventListener("band:find-in-file", handler);
  }, []);

  return <div ref={containerRef} className={className} />;
}
