import { DashboardProvider, DashboardShell } from "@band/dashboard-core";
import {
  HybridDashboardAdapter,
  NativeShellCapabilities,
} from "@band/dashboard-core/adapters/hybrid";
import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@band/ui";
import { Link } from "@tanstack/react-router";
import { ListTodo } from "lucide-react";
import { useCallback } from "react";
import { TunnelToolbarButton } from "./TunnelToolbarButton";

const adapter = new HybridDashboardAdapter();
const capabilities = new NativeShellCapabilities();

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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

export function DashboardView() {
  return (
    <DashboardProvider adapter={adapter} capabilities={capabilities}>
      <TooltipProvider>
        <DashboardShell
          toolbarExtra={
            <>
              <TasksButton />
              <TunnelToolbarButton />
            </>
          }
        />
      </TooltipProvider>
    </DashboardProvider>
  );
}
