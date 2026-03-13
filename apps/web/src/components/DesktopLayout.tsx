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
      <div className="w-80 shrink-0 border-r border-white/20 overflow-hidden">
        <DashboardShell toolbarExtra={toolbarExtra} />
      </div>

      {activeWorkspaceId ? (
        <>
          {/* Middle Panel - Changes & Code (takes remaining space) */}
          <div className="flex-1 min-w-0 border-r border-white/20 overflow-hidden">
            <WorkspaceDetailPanel key={activeWorkspaceId} workspaceId={activeWorkspaceId} />
          </div>

          {/* Right Panel - Chat (capped at 768px) */}
          <div className="max-w-[768px] flex-1 min-w-0 overflow-hidden">
            <WorkspaceChatPanel key={activeWorkspaceId} workspaceId={activeWorkspaceId} />
          </div>
        </>
      ) : (
        <div className="flex-1 min-w-0 overflow-hidden">
          <EmptyStatePanel message="Select a workspace to get started" />
        </div>
      )}
    </div>
  );
}
