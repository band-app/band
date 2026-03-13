import { FileBrowser, FileViewer } from "@band/dashboard-core";
import { File } from "lucide-react";
import { useState } from "react";
import { useIsDesktop } from "../hooks/useIsDesktop";

interface CodeBrowserViewProps {
  workspaceId: string;
}

export function CodeBrowserView({ workspaceId }: CodeBrowserViewProps) {
  const isDesktop = useIsDesktop();
  const [currentPath, setCurrentPath] = useState("");
  const [viewFilePath, setViewFilePath] = useState("");

  const handleBack = () => {
    setViewFilePath("");
  };

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
        onOpenFile={setViewFilePath}
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
          onOpenFile={setViewFilePath}
          compact
          selectedFile={viewFilePath}
        />
      </div>

      {/* Right panel - file content */}
      <div className="flex-1 min-w-0 overflow-hidden">
        {viewFilePath ? (
          <FileViewer workspaceId={workspaceId} filePath={viewFilePath} />
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
