import { FileBrowser, FileViewer } from "@band/dashboard-core";
import { useState } from "react";

interface CodeBrowserViewProps {
  workspaceId: string;
}

export function CodeBrowserView({ workspaceId }: CodeBrowserViewProps) {
  const [mode, setMode] = useState<"browse" | "view">("browse");
  const [currentPath, setCurrentPath] = useState("");
  const [viewFilePath, setViewFilePath] = useState("");

  const handleOpenFile = (path: string) => {
    setViewFilePath(path);
    setMode("view");
  };

  const handleBack = () => {
    setMode("browse");
  };

  if (mode === "view") {
    return <FileViewer workspaceId={workspaceId} filePath={viewFilePath} onBack={handleBack} />;
  }

  return (
    <FileBrowser
      workspaceId={workspaceId}
      currentPath={currentPath}
      onNavigate={setCurrentPath}
      onOpenFile={handleOpenFile}
    />
  );
}
