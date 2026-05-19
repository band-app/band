import { Tooltip, TooltipContent, TooltipTrigger } from "@band-app/ui";
import { GitBranch, type LucideIcon } from "lucide-react";
import type { AgentInfo } from "../types";

interface Props {
  agent?: AgentInfo;
  isActive?: boolean;
  /**
   * Icon to render when no agent is actively `working` / `needs_attention`.
   * Defaults to `GitBranch` (the original behavior for git-backed
   * workspaces). Plain (non-git) projects pass `Folder` since they have
   * no branch — see #427.
   */
  fallbackIcon?: LucideIcon;
}

export function AgentStatusIndicator({ agent, isActive, fallbackIcon }: Props) {
  if (!agent || (agent.status !== "working" && agent.status !== "needs_attention")) {
    const Icon = fallbackIcon ?? GitBranch;
    return (
      <Icon className={`size-3 shrink-0 ${isActive ? "text-primary" : "text-muted-foreground"}`} />
    );
  }

  const isWorking = agent.status === "working";
  const color = isWorking ? "bg-status-working" : "bg-status-needs-attention";
  const tooltip = isWorking ? "Agent running..." : "Needs your attention";
  const animation = isWorking ? "" : "animate-status-pulse";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`inline-block size-2 shrink-0 rounded-full ${color} ${animation}`} />
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
