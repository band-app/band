import { DiffView } from "@band/dashboard-core";
import { Code, GitCompare } from "lucide-react";
import { useState } from "react";
import { CodeBrowserView } from "./CodeBrowserView";

type DetailTab = "diff" | "code";

const tabs: { id: DetailTab; label: string; icon: typeof GitCompare }[] = [
  { id: "diff", label: "Changes", icon: GitCompare },
  { id: "code", label: "Code", icon: Code },
];

interface DetailTabNavProps {
  activeTab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
}

function DetailTabNav({ activeTab, onTabChange }: DetailTabNavProps) {
  return (
    <div className="flex h-12 shrink-0 items-center border-b border-border">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            className={`flex h-full flex-1 items-center justify-center gap-2 text-sm font-medium transition-colors ${
              isActive
                ? "border-b-2 border-foreground text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="size-4" />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

interface WorkspaceDetailPanelProps {
  workspaceId: string;
}

export function WorkspaceDetailPanel({ workspaceId }: WorkspaceDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<DetailTab>("diff");

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <DetailTabNav activeTab={activeTab} onTabChange={setActiveTab} />
      <div className="min-h-0 flex-1">
        <div className={activeTab === "diff" ? "h-full" : "hidden"}>
          <DiffView workspaceId={workspaceId} active={activeTab === "diff"} />
        </div>
        <div className={activeTab === "code" ? "h-full" : "hidden"}>
          <CodeBrowserView workspaceId={workspaceId} />
        </div>
      </div>
    </div>
  );
}
