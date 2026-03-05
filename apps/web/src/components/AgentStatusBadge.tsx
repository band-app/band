export type AgentStatusType = "working" | "needs_attention" | "waiting";

interface AgentStatusBadgeProps {
	status?: AgentStatusType;
}

export function AgentStatusBadge({ status }: AgentStatusBadgeProps) {
	if (!status || status === "waiting") {
		return null;
	}

	const color =
		status === "working"
			? "bg-status-working"
			: "bg-status-needs-attention";

	return <span className={`inline-block size-2 rounded-full ${color}`} />;
}
