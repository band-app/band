import { DashboardShell, useDashboardStore } from "@band/dashboard-core";
import { MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import { WorkspaceChatPanel } from "./WorkspaceChatPanel";
import { WorkspaceDetailPanel } from "./WorkspaceDetailPanel";

interface DesktopLayoutProps {
  toolbarExtra?: ReactNode;
}

function EmptyStatePanel({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-center px-8">
        <MessageSquare className="size-8 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

export function DesktopLayout({ toolbarExtra }: DesktopLayoutProps) {
  const activeWorkspaceId = useDashboardStore((s) => s.activeWorkspaceId);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
      {/* Left Panel - Project List */}
      <div className="w-72 shrink-0 border-r border-border overflow-hidden">
        <DashboardShell toolbarExtra={toolbarExtra} />
      </div>

      {/* Middle Panel - Chat (narrower) */}
      <div className="flex-[2] min-w-0 border-r border-border overflow-hidden">
        {activeWorkspaceId ? (
          <WorkspaceChatPanel key={activeWorkspaceId} workspaceId={activeWorkspaceId} />
        ) : (
          <EmptyStatePanel message="Select a workspace to start chatting" />
        )}
      </div>

      {/* Right Panel - Changes & Code (wider for file diffs) */}
      <div className="flex-[3] min-w-0 overflow-hidden">
        {activeWorkspaceId ? (
          <WorkspaceDetailPanel key={activeWorkspaceId} workspaceId={activeWorkspaceId} />
        ) : (
          <EmptyStatePanel message="Select a workspace to view changes" />
        )}
      </div>
    </div>
  );
}
