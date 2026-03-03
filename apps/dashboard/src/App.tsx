import { useEffect, useState } from "react";
import { ProjectList } from "@/components/ProjectList";
import { AddProjectDialog } from "@/components/AddProjectDialog";
import { useDashboardStore } from "@/stores/dashboard-store";
import { useStatusWatcher } from "@/hooks/use-status";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Plus, X } from "lucide-react";

export default function App() {
  const loadProjects = useDashboardStore((s) => s.loadProjects);
  const error = useDashboardStore((s) => s.error);
  const clearError = useDashboardStore((s) => s.clearError);
  const [showAddDialog, setShowAddDialog] = useState(false);

  useStatusWatcher();

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <header className="flex items-center justify-between px-4 py-2">
        <h1 className="text-sm font-medium text-muted-foreground">Projects</h1>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => setShowAddDialog(true)}
        >
          <Plus />
        </Button>
      </header>

      <Separator />

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
        <main className="px-6 py-6">
          <ProjectList />
        </main>
      </ScrollArea>

      <AddProjectDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
      />
    </div>
  );
}
