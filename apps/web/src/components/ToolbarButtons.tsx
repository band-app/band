import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@band/ui";
import { useNavigate } from "@tanstack/react-router";
import { ListTodo, Timer, Zap } from "lucide-react";
import { useCallback } from "react";
import { TunnelToolbarButton } from "./TunnelToolbarButton";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function ToolbarButtons() {
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
