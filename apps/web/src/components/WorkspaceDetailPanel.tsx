import { type DiffStats, DiffView, QuickOpenDialog, SearchFilesDialog } from "@band/dashboard-core";
import { ChevronDown, ChevronUp, Code, GitCompare, Terminal as TerminalIcon } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { CodeBrowserView } from "./CodeBrowserView";

const TerminalPanel = lazy(() =>
  import("./TerminalPanel").then((m) => ({ default: m.TerminalPanel })),
);

type DetailTab = "diff" | "code";

interface DetailTabNavProps {
  activeTab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  diffStats: DiffStats | null;
}

function DetailTabNav({ activeTab, onTabChange, diffStats }: DetailTabNavProps) {
  return (
    <div className="flex h-12 shrink-0 items-center border-b border-white/20">
      <button
        type="button"
        onClick={() => onTabChange("diff")}
        className={`flex h-full flex-1 items-center justify-center gap-2 text-sm font-medium transition-colors ${
          activeTab === "diff"
            ? "border-b border-foreground text-foreground"
            : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <GitCompare className="size-4" />
        Changes
        {diffStats && diffStats.filesChanged > 0 && (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-500/20 text-blue-400 px-1.5 text-xs font-medium">
            {diffStats.filesChanged}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={() => onTabChange("code")}
        className={`flex h-full flex-1 items-center justify-center gap-2 text-sm font-medium transition-colors ${
          activeTab === "code"
            ? "border-b border-foreground text-foreground"
            : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <Code className="size-4" />
        Code
      </button>
    </div>
  );
}

interface WorkspaceDetailPanelProps {
  workspaceId: string;
}

export function WorkspaceDetailPanel({ workspaceId }: WorkspaceDetailPanelProps) {
  const isDesktop = useIsDesktop();
  const [activeTab, setActiveTab] = useState<DetailTab>("diff");
  const [diffStats, setDiffStats] = useState<DiffStats | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const terminalMounted = useRef(false);
  if (terminalOpen) terminalMounted.current = true;
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [searchFilesOpen, setSearchFilesOpen] = useState(false);
  const [pendingFilePath, setPendingFilePath] = useState<string | null>(null);
  const findInFileRef = useRef<(() => void) | null>(null);

  const handleStatsChange = useCallback((stats: DiffStats | null) => {
    setDiffStats(stats);
  }, []);

  const handleFindInFileReady = useCallback((fn: (() => void) | null) => {
    findInFileRef.current = fn;
  }, []);

  // Global keyboard shortcuts — register on window in capture phase
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      // Cmd+P / Ctrl+P → Quick Open
      if (mod && key === "p" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        setQuickOpenOpen(true);
        return;
      }

      // Cmd+Shift+F / Ctrl+Shift+F → Search in Files
      if (mod && e.shiftKey && key === "f" && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        setSearchFilesOpen(true);
        return;
      }

      // Cmd+F / Ctrl+F → Find in current file (CodeMirror search)
      if (mod && key === "f" && !e.shiftKey && !e.altKey && findInFileRef.current) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        findInFileRef.current();
        return;
      }
    };

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  const handleOpenFile = useCallback((path: string) => {
    setActiveTab("code");
    setPendingFilePath(path);
  }, []);

  const handleFileOpened = useCallback(() => {
    setPendingFilePath(null);
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <DetailTabNav activeTab={activeTab} onTabChange={setActiveTab} diffStats={diffStats} />
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className={activeTab === "diff" ? "h-full" : "hidden"}>
          <DiffView
            workspaceId={workspaceId}
            active={activeTab === "diff"}
            onStatsChange={handleStatsChange}
          />
        </div>
        <div className={activeTab === "code" ? "h-full" : "hidden"}>
          <CodeBrowserView
            workspaceId={workspaceId}
            openFilePath={pendingFilePath}
            onFileOpened={handleFileOpened}
            onFindInFile={handleFindInFileReady}
          />
        </div>
      </div>

      {/* Terminal panel — desktop only */}
      {isDesktop && (
        <div className="shrink-0 border-t border-white/20">
          <button
            type="button"
            onClick={() => setTerminalOpen((prev) => !prev)}
            className="flex w-full items-center gap-2 px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <TerminalIcon className="size-3.5" />
            Terminal
            {terminalOpen ? (
              <ChevronDown className="ml-auto size-3.5" />
            ) : (
              <ChevronUp className="ml-auto size-3.5" />
            )}
          </button>
          {terminalMounted.current && (
            <div className={terminalOpen ? "h-64 border-t border-white/10" : "hidden"}>
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    Loading terminal…
                  </div>
                }
              >
                <TerminalPanel workspaceId={workspaceId} visible={terminalOpen} />
              </Suspense>
            </div>
          )}
        </div>
      )}

      <QuickOpenDialog
        workspaceId={workspaceId}
        open={quickOpenOpen}
        onOpenChange={setQuickOpenOpen}
        onOpenFile={handleOpenFile}
      />
      <SearchFilesDialog
        workspaceId={workspaceId}
        open={searchFilesOpen}
        onOpenChange={setSearchFilesOpen}
        onOpenFile={handleOpenFile}
      />
    </div>
  );
}
