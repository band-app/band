import type { PlatformCapabilities } from "@band/dashboard-core";
import { DashboardProvider, DashboardShell } from "@band/dashboard-core";
import {
  HybridDashboardAdapter,
  NativeShellCapabilities,
} from "@band/dashboard-core/adapters/hybrid";
import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@band/ui";
import { Link } from "@tanstack/react-router";
import { ListTodo, Timer } from "lucide-react";
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

function TasksButton() {
  const handleClick = useCallback(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_tasks_window");
  }, []);

  if (inTauri) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon-sm" variant="ghost" onClick={handleClick}>
            <ListTodo className="size-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Tasks</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon-sm" variant="ghost" asChild>
          <Link to="/tasks">
            <ListTodo className="size-5" />
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Tasks</TooltipContent>
    </Tooltip>
  );
}

function ToolbarButtons() {
  return (
    <>
      <TasksButton />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon-sm" variant="ghost" asChild>
            <Link to="/cronjobs">
              <Timer className="size-5" />
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Cronjobs</TooltipContent>
      </Tooltip>
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
