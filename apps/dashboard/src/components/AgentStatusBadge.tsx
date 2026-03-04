import { AgentInfo } from "@/stores/dashboard-store";

interface Props {
  agent?: AgentInfo;
}

export function AgentStatusBadge({ agent }: Props) {
  if (!agent || agent.status === "waiting") {
    return null;
  }

  const color =
    agent.status === "working"
      ? "bg-status-working"
      : "bg-status-needs-attention";

  return <span className={`inline-block size-2 rounded-full ${color}`} />;
}
