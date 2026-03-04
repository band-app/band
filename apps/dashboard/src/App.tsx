import { useEffect, useState } from "react";
import { ProjectList } from "@/components/ProjectList";
import { AddProjectDialog } from "@/components/AddProjectDialog";
import { useDashboardStore } from "@/stores/dashboard-store";
import { useStatusWatcher, useActiveWorkspaceWatcher } from "@/hooks/use-status";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Plus, X } from "lucide-react";

export default function App() {
  const loadProjects = useDashboardStore((s) => s.loadProjects);
  const error = useDashboardStore((s) => s.error);
  const clearError = useDashboardStore((s) => s.clearError);
  const [showAddDialog, setShowAddDialog] = useState(false);

  useStatusWatcher();
  useActiveWorkspaceWatcher();

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {error && (
        <div className="mx-4 mt-2 px-4 py-2 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive flex items-center justify-between gap-2">
          <span className="truncate">{error}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-destructive shrink-0"
            onClick={clearError}
          >
            <X />
          </Button>
        </div>
      )}

      <ScrollArea className="flex-1">
        <main className="px-2 py-2">
          <ProjectList />
        </main>
      </ScrollArea>

      <Separator />

      <footer className="flex items-center justify-center px-4 py-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => setShowAddDialog(true)}
            >
              <Plus />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add project</TooltipContent>
        </Tooltip>
      </footer>

      <AddProjectDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
      />
    </div>
  );
}
