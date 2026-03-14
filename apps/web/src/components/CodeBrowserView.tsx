import { FileBrowser, FileViewer, openFileSearchPanel } from "@band/dashboard-core";
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
  const [currentPath, setCurrentPath] = useState(() => (file ? directoryOf(file) : ""));
  const [viewFilePath, setViewFilePath] = useState(file ?? "");

  // Sync when the file prop changes (e.g. navigating from diff view)
  useEffect(() => {
    if (file) {
      setViewFilePath(file);
      setCurrentPath(directoryOf(file));
    }
  }, [file]);

  // Handle externally triggered file open
  useEffect(() => {
    if (openFilePath) {
      setViewFilePath(openFilePath);
      // Navigate the file browser to the file's parent directory
      const lastSlash = openFilePath.lastIndexOf("/");
      setCurrentPath(lastSlash > 0 ? openFilePath.slice(0, lastSlash) : "");
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
      onSelectFile?.(filePath);
    },
    [onSelectFile],
  );

  const handleBack = useCallback(() => {
    setViewFilePath("");
    onSelectFile?.(null);
  }, [onSelectFile]);

  // Mobile: toggle between browse and view
  if (!isDesktop) {
    if (viewFilePath) {
      return <FileViewer workspaceId={workspaceId} filePath={viewFilePath} onBack={handleBack} />;
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
      <div className="w-60 shrink-0 border-r border-white/20 overflow-hidden">
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
