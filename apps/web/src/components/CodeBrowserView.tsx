import {
  FileBrowser,
  FileViewer,
  openFileSearchPanel,
  parseFileLocation,
} from "@band-app/dashboard-core";
import { File } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useIsDesktop } from "../hooks/useIsDesktop";

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

  const handleEditorView = useCallback(
    // EditorView type from @codemirror/view — kept untyped to avoid cross-package dependency
    (view: { focus: () => void } | null) => {
      if (view) {
        onFindInFile?.(() => {
          view.focus();
          openFileSearchPanel(view);
        });
      } else {
        onFindInFile?.(null);
      }
    },
    [onFindInFile],
  );

  // Clean up on unmount
  useEffect(() => {
    return () => onFindInFile?.(null);
  }, [onFindInFile]);

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
      <div className="w-60 shrink-0 border-r border-border overflow-hidden">
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
      <div className="flex-1 min-w-0 overflow-hidden">
        {viewFilePath ? (
          <FileViewer
            workspaceId={workspaceId}
            filePath={viewFilePath}
            line={viewLine}
            lineEnd={viewLineEnd}
            column={viewColumn}
            onEditorView={handleEditorView}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="flex flex-col items-center gap-3 text-center px-8">
              <File className="size-8 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">Select a file to view</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
