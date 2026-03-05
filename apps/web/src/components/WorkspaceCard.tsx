import { Link } from "@tanstack/react-router";
import { GitBranch } from "lucide-react";
import { AgentStatusBadge, type AgentStatusType } from "./AgentStatusBadge";

interface WorkspaceCardProps {
  workspaceId: string;
  branch: string;
  agent?: {
    name: string;
    status: string;
    lastActivity: string;
  } | null;
}

export function WorkspaceCard({ workspaceId, branch, agent }: WorkspaceCardProps) {
  return (
    <Link
      to="/chat/$workspaceId"
      params={{ workspaceId: encodeURIComponent(workspaceId) }}
      className="flex items-center gap-3 px-3 py-1.5 min-w-0 overflow-hidden transition-colors hover:bg-accent/50 active:bg-accent/50"
    >
      <GitBranch className="size-3 shrink-0 text-muted-foreground" />
      <span className="truncate text-xs font-medium" style={{ color: "oklch(0.7 0 0)" }}>
        {branch}
      </span>
      {agent && <AgentStatusBadge status={agent.status as AgentStatusType} />}
    </Link>
  );
}
