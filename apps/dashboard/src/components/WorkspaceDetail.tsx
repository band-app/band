import { AgentStatusBadge } from "@/components/AgentStatusBadge";
import {
  useDashboardStore,
  ProjectInfo,
  WorktreeInfo,
} from "@/stores/dashboard-store";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { ExternalLink, Trash2 } from "lucide-react";

export function WorkspaceDetail() {
  const selectedWorkspace = useDashboardStore((s) => s.selectedWorkspace);
  const projects = useDashboardStore((s) => s.projects);
  const statuses = useDashboardStore((s) => s.statuses);
  const openWorkspace = useDashboardStore((s) => s.openWorkspace);
  const removeWorkspace = useDashboardStore((s) => s.removeWorkspace);

  if (!selectedWorkspace) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <p className="text-sm">Select a workspace to view details</p>
      </div>
    );
  }

  const project = projects.find(
    (p: ProjectInfo) => p.name === selectedWorkspace.projectName
  );
  const worktree = project?.worktrees.find(
    (w: WorktreeInfo) => w.branch === selectedWorkspace.branch
  );
  const status = statuses.get(selectedWorkspace.workspaceId);

  if (!project || !worktree) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <p className="text-sm">Workspace not found</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <header className="flex items-center justify-between px-6 py-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold truncate">
            {worktree.branch}
          </h2>
          <p className="text-xs text-muted-foreground">
            {project.name}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => openWorkspace(selectedWorkspace.workspaceId)}
          >
            <ExternalLink />
            Open in IDE
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => removeWorkspace(project.name, worktree.branch)}
          >
            <Trash2 />
            Remove
          </Button>
        </div>
      </header>

      <Separator />

      <ScrollArea className="flex-1">
        <div className="px-6 py-6 flex flex-col gap-6">
          {/* Status */}
          <section>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
              Agent Status
            </h3>
            <div className="px-4 py-3 rounded-lg bg-card border border-border">
              <AgentStatusBadge agent={status?.agent} />
            </div>
          </section>

          {/* Details */}
          <section>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
              Details
            </h3>
            <div className="flex flex-col gap-2">
              <DetailRow label="Branch" value={worktree.branch} />
              <DetailRow label="Project" value={project.name} />
              <DetailRow label="Path" value={worktree.path} />
              {worktree.head && (
                <DetailRow
                  label="HEAD"
                  value={worktree.head.substring(0, 8)}
                />
              )}
              {status?.ide && (
                <DetailRow label="IDE" value={status.ide} />
              )}
              {status?.pid && (
                <DetailRow label="PID" value={String(status.pid)} />
              )}
            </div>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 px-4 py-2 rounded-lg bg-card border border-border">
      <span className="text-xs text-muted-foreground w-16 shrink-0 pt-0.5">
        {label}
      </span>
      <span className="text-sm break-all">
        {value}
      </span>
    </div>
  );
}
