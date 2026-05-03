import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@band-app/ui";
import { ListTodo, Timer, Zap } from "lucide-react";
import { useCallback, useState } from "react";
import { CronjobsPageContent } from "./CronjobsPageContent";
import { TasksPageContent } from "./TasksPageContent";
import { TunnelToolbarButton } from "./TunnelToolbarButton";

export function ToolbarButtons() {
  const [showTasksDialog, setShowTasksDialog] = useState(false);
  const [showCronjobsDialog, setShowCronjobsDialog] = useState(false);

  const handleTasksClick = useCallback(() => setShowTasksDialog(true), []);
  const handleCronjobsClick = useCallback(() => setShowCronjobsDialog(true), []);

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Run agent">
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
          <DropdownMenuItem onClick={handleCronjobsClick}>
            <Timer className="size-4" />
            Cronjobs
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <TunnelToolbarButton />

      <Dialog open={showTasksDialog} onOpenChange={setShowTasksDialog}>
        <DialogContent className="sm:max-w-6xl h-[80vh] flex flex-col p-0 gap-0">
          <DialogHeader className="px-6 pt-6 pb-4 border-b border-border/50 shrink-0">
            <DialogTitle>Tasks</DialogTitle>
          </DialogHeader>
          <TasksPageContent />
        </DialogContent>
      </Dialog>

      <Dialog open={showCronjobsDialog} onOpenChange={setShowCronjobsDialog}>
        <DialogContent className="sm:max-w-6xl h-[80vh] flex flex-col p-0 gap-0">
          <DialogHeader className="px-6 pt-6 pb-4 border-b border-border/50 shrink-0">
            <DialogTitle>Cronjobs</DialogTitle>
          </DialogHeader>
          <CronjobsPageContent />
        </DialogContent>
      </Dialog>
    </>
  );
}
