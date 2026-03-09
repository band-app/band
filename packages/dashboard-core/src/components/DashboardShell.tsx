import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ScrollArea,
  Separator,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@band/ui";
import { Check, FolderPlus, Plus, Settings, Tag, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useCliSetup } from "../hooks/use-cli-setup";
import { useHooksSetup } from "../hooks/use-hooks-setup";
import { useProjects } from "../hooks/use-projects";
import { useSettingsQuery } from "../hooks/use-settings-query";
import {
  useActiveWorkspaceWatcher,
  useBranchStatusWatcher,
  useStatusWatcher,
} from "../hooks/use-status";
import { useDashboardStore } from "../stores/index";
import { AddProjectDialog } from "./AddProjectDialog";
import { ProjectList } from "./ProjectList";
import { SettingsPage } from "./SettingsPage";

interface DashboardShellProps {
  toolbarExtra?: ReactNode;
}

export function DashboardShell({ toolbarExtra }: DashboardShellProps) {
  const { projects, isLoading: loading } = useProjects();
  const { settings } = useSettingsQuery();
  const labels = settings.labels ?? [];
  const error = useDashboardStore((s) => s.error);
  const clearError = useDashboardStore((s) => s.clearError);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showErrorDialog, setShowErrorDialog] = useState(false);
  const [view, setView] = useState<"dashboard" | "settings">("dashboard");
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const { state: hooksState, install: installHooks } = useHooksSetup();
  const { state: cliState, install: installCli } = useCliSetup();

  useStatusWatcher();
  useActiveWorkspaceWatcher();
  useBranchStatusWatcher();

  return (
    <div className="h-dvh w-full overflow-hidden flex flex-col bg-background text-foreground p-0 pt-[env(safe-area-inset-top)]">
      <Separator />

      {view === "settings" ? (
        <ScrollArea className="flex-1 overflow-hidden">
          <div className="px-2 py-2">
            <SettingsPage onClose={() => setView("dashboard")} />
          </div>
        </ScrollArea>
      ) : (
        <>
          <div className="flex items-center justify-between px-4 py-2">
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="icon-sm" variant="ghost" onClick={() => setView("settings")}>
                    <Settings className="size-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Settings</TooltipContent>
              </Tooltip>
              {toolbarExtra}
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
                            style={{
                              backgroundColor: labels.find((l) => l.id === labelFilter)?.color,
                            }}
                          />
                          {labels.find((l) => l.id === labelFilter)?.name}
                        </>
                      ) : (
                        <>
                          <Tag className="size-5" />
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
                <Button size="icon-sm" variant="ghost" onClick={() => setShowAddDialog(true)}>
                  <Plus className="size-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Add project</TooltipContent>
            </Tooltip>
          </div>

          <Separator />

          <ScrollArea
            className="flex-1 overflow-hidden"
            onClick={(e: React.MouseEvent<HTMLDivElement>) => {
              const target = e.target as HTMLElement;
              if (target.closest("button, a, input, select, textarea")) return;
              const list = (e.currentTarget as HTMLElement).querySelector<HTMLElement>(
                '[tabindex="0"]',
              );
              list?.focus();
            }}
          >
            <main className="px-2 py-2 overflow-hidden">
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Spinner className="size-5 text-muted-foreground" />
                </div>
              ) : projects.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
                  <FolderPlus className="size-8 text-muted-foreground/50" />
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">No projects yet</p>
                    <p className="text-xs text-muted-foreground/70 mt-1">
                      Add a project to get started
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => setShowAddDialog(true)}>
                    <Plus className="size-3 mr-1" />
                    Add project
                  </Button>
                </div>
              ) : (
                <ProjectList labelFilter={labelFilter} />
              )}
            </main>
          </ScrollArea>

          {(cliState.status === "manual" || cliState.status === "conflict") && (
            <div className="mx-4 mb-2 px-4 py-2 bg-blue-500/10 border border-blue-500/30 rounded-lg text-sm flex items-center justify-between gap-2">
              <span className="text-blue-200">
                {cliState.status === "conflict"
                  ? "A different `band` binary exists — replace it to use the bundled CLI"
                  : `Install \`band\` CLI to /usr/local/bin (${cliState.reason})`}
              </span>
              <Button variant="outline" size="sm" className="shrink-0 text-xs" onClick={installCli}>
                Install
              </Button>
            </div>
          )}

          {hooksState.status === "needs_install" && (
            <div className="mx-4 mb-2 px-4 py-2 bg-blue-500/10 border border-blue-500/30 rounded-lg text-sm flex items-center justify-between gap-2">
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

          {error && (
            <div className="mx-4 mb-2 px-4 py-2 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive flex items-center justify-between gap-2">
              <button
                type="button"
                className="truncate text-left cursor-pointer hover:underline"
                onClick={() => setShowErrorDialog(true)}
              >
                {error}
              </button>
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

          <Dialog open={showErrorDialog} onOpenChange={setShowErrorDialog}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle className="text-destructive">Error</DialogTitle>
                <DialogDescription>Click the error text to select it.</DialogDescription>
              </DialogHeader>
              <pre className="whitespace-pre-wrap break-words text-sm bg-muted/50 rounded-md p-3 max-h-64 overflow-auto select-all cursor-text">
                {error}
              </pre>
              <DialogFooter>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (error) navigator.clipboard.writeText(error);
                  }}
                >
                  Copy
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => {
                    setShowErrorDialog(false);
                    clearError();
                  }}
                >
                  Dismiss
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <AddProjectDialog
            open={showAddDialog}
            onOpenChange={setShowAddDialog}
            defaultLabel={labelFilter}
          />
        </>
      )}
    </div>
  );
}
