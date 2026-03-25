import { DashboardShell } from "@band-app/dashboard-core";
import { MessageSquare } from "lucide-react";
import type { ReactNode } from "react";

interface DesktopLayoutProps {
  toolbarExtra?: ReactNode;
}

export function DesktopLayout({ toolbarExtra }: DesktopLayoutProps) {
  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
      {/* Left Panel — Project List */}
      <div className="w-80 shrink-0 border-r border-white/20 overflow-hidden">
        <DashboardShell toolbarExtra={toolbarExtra} />
      </div>

      {/* Empty state — no workspace selected */}
      <div className="flex-1 min-w-0 overflow-hidden">
        <div className="flex h-full items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-center px-8">
            <MessageSquare className="size-8 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">Select a workspace to get started</p>
          </div>
        </div>
      </div>
    </div>
  );
}
