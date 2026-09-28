import { Tooltip, TooltipContent, TooltipTrigger } from "@band-app/ui";
import { GitBranch } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentInfo } from "../types";

interface Props {
  agent?: AgentInfo;
  isActive?: boolean;
  // Icon shown when the agent is idle. Non-root cards fall back to the branch
  // glyph (the default); the root card passes its house icon so the status dot
  // occupies the same slot — replacing the identity icon rather than sitting
  // beside it.
  fallback?: ReactNode;
}

export function AgentStatusIndicator({ agent, isActive, fallback }: Props) {
  if (!agent || (agent.status !== "working" && agent.status !== "needs_attention")) {
    return (
      fallback ?? (
        <GitBranch
          className={`size-3 shrink-0 ${isActive ? "text-primary" : "text-muted-foreground"}`}
        />
      )
    );
  }

  const isWorking = agent.status === "working";
  const color = isWorking ? "bg-status-working" : "bg-status-needs-attention";
  const tooltip = isWorking ? "Agent running..." : "Needs your attention";
  const animation = isWorking ? "" : "animate-status-pulse";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="workspace-card__agent-status"
          className={`inline-block size-2 shrink-0 rounded-full ${color} ${animation}`}
        />
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
