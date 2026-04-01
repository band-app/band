import { Tooltip, TooltipContent, TooltipTrigger } from "@band-app/ui";
import { GitBranch } from "lucide-react";
import type { AgentInfo } from "../types";

interface Props {
  agent?: AgentInfo;
  isActive?: boolean;
}

export function AgentStatusIndicator({ agent, isActive }: Props) {
  if (!agent || agent.status === "waiting") {
    return (
      <GitBranch
        className={`size-3.5 shrink-0 ${isActive ? "text-primary" : "text-muted-foreground"}`}
      />
    );
  }

  const isWorking = agent.status === "working";
  const color = isWorking ? "bg-status-working" : "bg-status-needs-attention";
  const tooltip = isWorking ? "Agent running..." : "Agent done";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`inline-block size-2.5 shrink-0 rounded-full ${color}`}
        />
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
