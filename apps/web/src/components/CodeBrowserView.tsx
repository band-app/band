import {
  FileBrowser,
  FileViewer,
  parseFileLocation,
  SearchBar,
  useSearch,
} from "@band-app/dashboard-core";
import { cn } from "@band-app/ui";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { File } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { useIsDesktop } from "../hooks/useIsDesktop";

const streamdownPlugins = { cjk, code, math, mermaid };

function renderMarkdown(content: string) {
  return (
    <Streamdown
      className={cn(
        "size-full break-words leading-relaxed [overflow-wrap:anywhere]",
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
      )}
      plugins={streamdownPlugins}
    >
      {content}
    </Streamdown>
  );
}

interface CodeBrowserViewProps {
  workspaceId: string;
  /** When set, navigates the browser to this file path. */
  file?: string;
  /** Called when the user selects a file or navigates back (null = no file). */
  onSelectFile?: (filePath: string | null) => void;
  /** Externally triggered file to open (e.g. from Quick Open or Search) */
  openFilePath?: string | null;
  /** Called after the external file path has been consumed */
  onFileOpened?: () => void;
  /** Reports a callback that triggers find-in-file search (null when unavailable) */
  onFindInFile?: (fn: (() => void) | null) => void;
}

function directoryOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx > 0 ? filePath.slice(0, idx) : "";
}

export function CodeBrowserView({
  workspaceId,
  file,
  onSelectFile,
  openFilePath,
  onFileOpened,
  onFindInFile,
}: CodeBrowserViewProps) {
  const isDesktop = useIsDesktop();
  const [currentPath, setCurrentPath] = useState(() => {
    if (!file) return "";
    const loc = parseFileLocation(file);
    return directoryOf(loc.filePath);
  });
  const [viewFilePath, setViewFilePath] = useState(() => {
    if (!file) return "";
    return parseFileLocation(file).filePath;
  });
  const [viewLine, setViewLine] = useState<number | undefined>(() => {
    if (!file) return undefined;
    return parseFileLocation(file).line;
  });
  const [viewLineEnd, setViewLineEnd] = useState<number | undefined>(() => {
    if (!file) return undefined;
    return parseFileLocation(file).lineEnd;
  });
  const [viewColumn, setViewColumn] = useState<number | undefined>(() => {
    if (!file) return undefined;
    return parseFileLocation(file).column;
  });

  // Sync when the file prop changes (e.g. navigating from diff view)
  useEffect(() => {
    if (file) {
      const loc = parseFileLocation(file);
      setViewFilePath(loc.filePath);
      setCurrentPath(directoryOf(loc.filePath));
      setViewLine(loc.line);
      setViewLineEnd(loc.lineEnd);
      setViewColumn(loc.column);
    }
  }, [file]);

  // Handle externally triggered file open
  useEffect(() => {
    if (openFilePath) {
      const loc = parseFileLocation(openFilePath);
      setViewFilePath(loc.filePath);
      setViewLine(loc.line);
      setViewLineEnd(loc.lineEnd);
      setViewColumn(loc.column);
      // Navigate the file browser to the file's parent directory
      const lastSlash = loc.filePath.lastIndexOf("/");
      setCurrentPath(lastSlash > 0 ? loc.filePath.slice(0, lastSlash) : "");
      onFileOpened?.();
    }
  }, [openFilePath, onFileOpened]);

  // -------------------------------------------------------------------------
  // Find-in-file state
  // -------------------------------------------------------------------------
  // biome-ignore lint/suspicious/noExplicitAny: EditorView type from @codemirror/view — kept untyped to avoid cross-package dependency
  const editorViewRef = useRef<any>(null);

  const getViews = useCallback(() => (editorViewRef.current ? [editorViewRef.current] : []), []);

  const search = useSearch({ getViews, onFindInFile });

  const handleEditorView = useCallback(
    // biome-ignore lint/suspicious/noExplicitAny: EditorView from @codemirror/view — kept untyped to avoid cross-package dependency
    (view: any) => {
      editorViewRef.current = view;
      if (view) {
        search.dispatchToViews([view]);
      }
    },
    [search.dispatchToViews],
  );

  // Close search when file changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewFilePath intentionally triggers reset when user navigates to a different file
  useEffect(() => {
    search.handleCloseSearch();
  }, [viewFilePath]);

  const handleSelectFile = useCallback(
    (filePath: string) => {
      setViewFilePath(filePath);
      setViewLine(undefined);
      setViewLineEnd(undefined);
      setViewColumn(undefined);
      onSelectFile?.(filePath);
    },
    [onSelectFile],
  );

  const handleBack = useCallback(() => {
    setViewFilePath("");
    setViewLine(undefined);
    setViewLineEnd(undefined);
    setViewColumn(undefined);
    onSelectFile?.(null);
  }, [onSelectFile]);

  // Mobile: toggle between browse and view
  if (!isDesktop) {
    if (viewFilePath) {
      return (
        <FileViewer
          workspaceId={workspaceId}
          filePath={viewFilePath}
          line={viewLine}
          lineEnd={viewLineEnd}
          column={viewColumn}
          onBack={handleBack}
          renderMarkdown={renderMarkdown}
        />
      );
    }
    return (
      <FileBrowser
        workspaceId={workspaceId}
        currentPath={currentPath}
        onNavigate={setCurrentPath}
        onOpenFile={handleSelectFile}
      />
    );
  }

  // Desktop: side-by-side layout
  return (
    <div className="flex h-full overflow-hidden">
      {/* Left sidebar - file tree */}
      <div className="w-60 shrink-0 overflow-hidden border-r border-border">
        <FileBrowser
          workspaceId={workspaceId}
          currentPath={currentPath}
          onNavigate={setCurrentPath}
          onOpenFile={handleSelectFile}
          compact
          selectedFile={viewFilePath}
        />
      </div>

      {/* Right panel - file content */}
      <div className="min-w-0 flex-1 overflow-hidden">
        {viewFilePath ? (
          <FileViewer
            workspaceId={workspaceId}
            filePath={viewFilePath}
            line={viewLine}
            lineEnd={viewLineEnd}
            column={viewColumn}
            onEditorView={handleEditorView}
            renderMarkdown={renderMarkdown}
            toolbar={
              search.searchOpen ? (
                <SearchBar
                  ref={search.searchBarRef}
                  query={search.searchQuery}
                  onQueryChange={search.setSearchQuery}
                  options={search.searchOptions}
                  onOptionsChange={search.setSearchOptions}
                  placeholder="Find in file..."
                  matchInfo={search.matchInfo}
                  onNext={search.handleNext}
                  onPrevious={search.handlePrevious}
                  onClose={search.handleCloseSearch}
                />
              ) : undefined
            }
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="flex flex-col items-center gap-3 px-8 text-center">
              <File className="size-8 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">Select a file to view</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
