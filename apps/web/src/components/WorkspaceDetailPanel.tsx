import { type DiffStats, DiffView } from "@band/dashboard-core";
import { Code, GitCompare } from "lucide-react";
import { useCallback, useState } from "react";
import { CodeBrowserView } from "./CodeBrowserView";

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
  const [activeTab, setActiveTab] = useState<DetailTab>("diff");
  const [diffStats, setDiffStats] = useState<DiffStats | null>(null);

  const handleStatsChange = useCallback((stats: DiffStats | null) => {
    setDiffStats(stats);
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <DetailTabNav activeTab={activeTab} onTabChange={setActiveTab} diffStats={diffStats} />
      <div className="min-h-0 flex-1">
        <div className={activeTab === "diff" ? "h-full" : "hidden"}>
          <DiffView
            workspaceId={workspaceId}
            active={activeTab === "diff"}
            onStatsChange={handleStatsChange}
          />
        </div>
        <div className={activeTab === "code" ? "h-full" : "hidden"}>
          <CodeBrowserView workspaceId={workspaceId} />
        </div>
      </div>
    </div>
  );
}
