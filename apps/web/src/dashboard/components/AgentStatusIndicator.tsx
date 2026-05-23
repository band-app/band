import { Tooltip, TooltipContent, TooltipTrigger } from "@band-app/ui";
import { GitBranch } from "lucide-react";
import type { AgentInfo } from "../types";

interface Props {
  agent?: AgentInfo;
  isActive?: boolean;
}

export function AgentStatusIndicator({ agent, isActive }: Props) {
  if (!agent || (agent.status !== "working" && agent.status !== "needs_attention")) {
    return (
      <GitBranch
        className={`size-3 shrink-0 ${isActive ? "text-primary" : "text-muted-foreground"}`}
      />
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
