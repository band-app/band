import type { PlatformCapabilities } from "@band/dashboard-core";
import { DashboardProvider, DashboardShell } from "@band/dashboard-core";
import {
  HybridDashboardAdapter,
  NativeShellCapabilities,
} from "@band/dashboard-core/adapters/hybrid";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@band/ui";
import { useNavigate } from "@tanstack/react-router";
import { ListTodo, Timer, Zap } from "lucide-react";
import { useCallback } from "react";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { DesktopLayout } from "./DesktopLayout";
import { TunnelToolbarButton } from "./TunnelToolbarButton";

const adapter = new HybridDashboardAdapter();
const capabilities = new NativeShellCapabilities();

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * On desktop web (non-Tauri), getWorkspaceHref returns undefined so that
 * WorkspaceCard uses onClick → openWorkspace (zustand) instead of <a> navigation.
 * This enables the three-panel layout where workspace selection is inline.
 */
class DesktopWebCapabilities implements PlatformCapabilities {
  copyPath = false;

  getWorkspaceHref(_workspaceId: string): string | undefined {
    return undefined;
  }
}

const desktopCapabilities = new DesktopWebCapabilities();

function ToolbarButtons() {
  const navigate = useNavigate();

  const handleTasksClick = useCallback(async () => {
    if (inTauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_tasks_window");
    } else {
      navigate({ to: "/tasks" });
    }
  }, [navigate]);

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost">
                <Zap className="size-5" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Run agent</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={handleTasksClick}>
            <ListTodo className="size-4" />
            Tasks
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate({ to: "/cronjobs" })}>
            <Timer className="size-4" />
            Cronjobs
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <TunnelToolbarButton />
    </>
  );
}

export function DashboardView() {
  const isDesktop = useIsDesktop() && !inTauri;
  const activeCapabilities = isDesktop ? desktopCapabilities : capabilities;

  return (
    <DashboardProvider adapter={adapter} capabilities={activeCapabilities}>
      <TooltipProvider>
        {isDesktop ? (
          <DesktopLayout toolbarExtra={<ToolbarButtons />} />
        ) : (
          <DashboardShell toolbarExtra={<ToolbarButtons />} />
        )}
      </TooltipProvider>
    </DashboardProvider>
  );
}
