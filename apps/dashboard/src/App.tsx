import { Check, Globe, Plus, Settings, Tag, X } from "lucide-react";
import { useEffect, useState } from "react";
import { AddProjectDialog } from "@/components/AddProjectDialog";
import { ProjectList } from "@/components/ProjectList";
import { SettingsPage } from "@/components/SettingsPage";
import { TunnelDialog } from "@/components/TunnelDialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useHooksSetup } from "@/hooks/use-hooks-setup";
import {
  useActiveWorkspaceWatcher,
  useBranchStatusWatcher,
  useStatusWatcher,
} from "@/hooks/use-status";
import { useTunnel } from "@/hooks/use-tunnel";
import { useDashboardStore } from "@/stores/dashboard-store";
import { useSettingsStore } from "@/stores/settings-store";

export default function App() {
  const loadProjects = useDashboardStore((s) => s.loadProjects);
  const error = useDashboardStore((s) => s.error);
  const clearError = useDashboardStore((s) => s.clearError);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const labels = useSettingsStore((s) => s.settings.labels) ?? [];
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [view, setView] = useState<"dashboard" | "settings">("dashboard");
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const { state: hooksState, install: installHooks } = useHooksSetup();
  const {
    webServerRunning,
    tunnelUrl,
    setTunnelUrl,
    showDialog: showTunnelDialog,
    setShowDialog: setShowTunnelDialog,
    openDialog,
    handleStopped,
  } = useTunnel();

  useStatusWatcher();
  useActiveWorkspaceWatcher();
  useBranchStatusWatcher();

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
          <Button variant="outline" size="sm" className="shrink-0 text-xs" onClick={installHooks}>
            Install
          </Button>
        </div>
      )}

      <div className="flex items-center justify-between px-4 py-2">
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={() => setView(view === "settings" ? "dashboard" : "settings")}
              >
                <Settings className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                className={webServerRunning ? "text-green-500" : ""}
                onClick={openDialog}
              >
                <Globe className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {webServerRunning ? "Mobile access" : "Start web server"}
            </TooltipContent>
          </Tooltip>
          {labels.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className={`text-sm h-8 px-2 gap-1.5 ${labelFilter ? "bg-accent text-accent-foreground" : ""}`}
                >
                  {labelFilter ? (
                    <>
                      <span
                        className="size-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: labels.find((l) => l.id === labelFilter)?.color }}
                      />
                      {labels.find((l) => l.id === labelFilter)?.name}
                    </>
                  ) : (
                    <>
                      <Tag className="size-4" />
                      All
                    </>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={() => setLabelFilter(null)}>
                  <span className="flex-1">All</span>
                  {!labelFilter && <Check className="size-3 ml-2" />}
                </DropdownMenuItem>
                {labels.map((lbl) => (
                  <DropdownMenuItem key={lbl.id} onClick={() => setLabelFilter(lbl.id)}>
                    <span
                      className="size-2.5 rounded-full shrink-0 mr-2"
                      style={{ backgroundColor: lbl.color }}
                    />
                    <span className="flex-1">{lbl.name}</span>
                    {labelFilter === lbl.id && <Check className="size-3 ml-2" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-xs" variant="ghost" onClick={() => setShowAddDialog(true)}>
              <Plus className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add project</TooltipContent>
        </Tooltip>
      </div>

      <Separator />

      <ScrollArea
        className="flex-1"
        onClick={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest("button, a, input, select, textarea")) return;
          const list = (e.currentTarget as HTMLElement).querySelector<HTMLElement>(
            '[tabindex="0"]',
          );
          list?.focus();
        }}
      >
        <main className="px-2 py-2 overflow-hidden">
          {view === "dashboard" ? (
            <ProjectList labelFilter={labelFilter} />
          ) : (
            <SettingsPage onClose={() => setView("dashboard")} />
          )}
        </main>
      </ScrollArea>

      <AddProjectDialog open={showAddDialog} onOpenChange={setShowAddDialog} />

      <TunnelDialog
        open={showTunnelDialog}
        onOpenChange={setShowTunnelDialog}
        onStopped={handleStopped}
        initialUrl={tunnelUrl}
        onTunnelUrl={setTunnelUrl}
      />
    </div>
  );
}
