import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AgentInfo } from "@/stores/dashboard-store";

interface Props {
  agent?: AgentInfo;
}

export function AgentStatusBadge({ agent }: Props) {
  if (!agent || agent.status === "waiting") {
    return null;
  }

  const color = agent.status === "working" ? "bg-status-working" : "bg-status-needs-attention";

  const tooltip = agent.status === "working" ? "Agent running..." : "Agent done";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`inline-block size-2 rounded-full ${color}`} />
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
