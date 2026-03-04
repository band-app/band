import { useEffect, useState } from "react";
import { ProjectList } from "@/components/ProjectList";
import { AddProjectDialog } from "@/components/AddProjectDialog";
import { SettingsPage } from "@/components/SettingsPage";
import { useDashboardStore } from "@/stores/dashboard-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useStatusWatcher, useActiveWorkspaceWatcher } from "@/hooks/use-status";
import { useHooksSetup } from "@/hooks/use-hooks-setup";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Plus, Settings, X } from "lucide-react";

export default function App() {
  const loadProjects = useDashboardStore((s) => s.loadProjects);
  const error = useDashboardStore((s) => s.error);
  const clearError = useDashboardStore((s) => s.clearError);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [view, setView] = useState<"dashboard" | "settings">("dashboard");
  const { state: hooksState, install: installHooks } = useHooksSetup();

  useStatusWatcher();
  useActiveWorkspaceWatcher();

  useEffect(() => {
    loadProjects();
    loadSettings();
  }, [loadProjects, loadSettings]);

  return (
    <div className="h-screen w-screen overflow-hidden flex flex-col bg-background text-foreground p-0">
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

      {hooksState.status === "needs_install" && (
        <div className="mx-4 mt-2 px-4 py-2 bg-blue-500/10 border border-blue-500/30 rounded-lg text-sm flex items-center justify-between gap-2">
          <span className="text-blue-200">
            Install Claude Code hooks for agent status detection
          </span>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 text-xs"
            onClick={installHooks}
          >
            Install
          </Button>
        </div>
      )}

      <ScrollArea
        className="flex-1"
        onClick={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest("button, a, input, select, textarea")) return;
          const list = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('[tabindex="0"]');
          list?.focus();
        }}
      >
        <main className="px-2 py-4 overflow-hidden">
          {view === "dashboard" ? <ProjectList /> : <SettingsPage onClose={() => setView("dashboard")} />}
        </main>
      </ScrollArea>

      <Separator />

      <footer className="flex items-center justify-between px-4 py-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() =>
                setView(view === "settings" ? "dashboard" : "settings")
              }
            >
              <Settings />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
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
