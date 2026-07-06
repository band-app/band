import { FolderOpen, GitBranch, GitCompare, MessageSquare, TerminalSquare } from "lucide-react";

export type WorkspaceTab = "chat" | "diff" | "code" | "terminal" | "graph";

interface WorkspaceTabNavProps {
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  diffFileCount?: number;
}

const tabs: { id: WorkspaceTab; label: string; icon: typeof MessageSquare }[] = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "diff", label: "Changes", icon: GitCompare },
  { id: "code", label: "Files", icon: FolderOpen },
  { id: "terminal", label: "Terminal", icon: TerminalSquare },
  { id: "graph", label: "Graph", icon: GitBranch },
];

export function WorkspaceTabNav({ activeTab, onTabChange, diffFileCount }: WorkspaceTabNavProps) {
  return (
    <div className="flex shrink-0 border-b border-border">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;
        const badge = tab.id === "diff" && diffFileCount != null && diffFileCount > 0;

        const className = `flex flex-1 items-center justify-center gap-1.5 py-2.5 text-sm font-medium transition-colors ${
          isActive
            ? "border-b-2 border-foreground text-foreground"
            : "text-muted-foreground hover:text-foreground"
        }`;

        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            className={className}
            aria-label={tab.label}
            title={tab.label}
          >
            <Icon className="size-4" />
            {badge && (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-500/20 text-blue-600 dark:text-blue-400 px-1.5 text-xs font-medium">
                {diffFileCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
