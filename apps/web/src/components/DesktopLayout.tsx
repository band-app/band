import { MessageSquare } from "lucide-react";
import { type ReactNode, useCallback, useRef } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { DashboardShell } from "@/dashboard";
import {
  loadSidebarWidth,
  SIDEBAR_MAX_SIZE,
  SIDEBAR_MIN_SIZE,
  saveSidebarWidth,
} from "../lib/sidebar-width";

interface DesktopLayoutProps {
  bottomActions?: ReactNode;
}

export function DesktopLayout({ bottomActions }: DesktopLayoutProps) {
  const savedWidth = loadSidebarWidth();
  const defaultLayout = savedWidth ? { sidebar: savedWidth, main: 100 - savedWidth } : undefined;
  const skipFirstLayoutCallback = useRef(true);
  const handleSidebarResize = useCallback((layout: Record<string, number>) => {
    if (skipFirstLayoutCallback.current) {
      skipFirstLayoutCallback.current = false;
      return;
    }
    if (layout.sidebar != null) {
      saveSidebarWidth(layout.sidebar);
    }
  }, []);

  return (
    <div className="flex h-full w-full overflow-hidden bg-background text-foreground">
      <Group
        orientation="horizontal"
        defaultLayout={defaultLayout}
        onLayoutChanged={handleSidebarResize}
      >
        <Panel
          id="sidebar"
          defaultSize={SIDEBAR_MIN_SIZE}
          minSize={SIDEBAR_MIN_SIZE}
          maxSize={SIDEBAR_MAX_SIZE}
          collapsible
          collapsedSize="0%"
        >
          <div className="h-full border-r border-border overflow-hidden">
            <DashboardShell bottomActions={bottomActions} />
          </div>
        </Panel>
        <Separator className="w-[3px] bg-transparent hover:bg-accent-foreground/20 active:bg-accent-foreground/30 transition-colors cursor-col-resize" />
        <Panel id="main" minSize="20%">
          {/* Empty state — no workspace selected */}
          <div className="flex-1 min-w-0 overflow-hidden">
            <div className="flex h-full items-center justify-center">
              <div className="flex flex-col items-center gap-3 text-center px-8">
                <MessageSquare className="size-8 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">Select a workspace to get started</p>
              </div>
            </div>
          </div>
        </Panel>
      </Group>
    </div>
  );
}
