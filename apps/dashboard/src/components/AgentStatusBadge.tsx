import { AgentInfo, AgentStatusType } from "../stores/dashboard-store";

const STATUS_CONFIG: Record<
  AgentStatusType,
  { icon: string; label: string; className: string }
> = {
  idle: {
    icon: "−",
    label: "Idle",
    className: "text-[var(--color-idle)]",
  },
  working: {
    icon: "●",
    label: "Working",
    className: "text-[var(--color-working)]",
  },
  needs_input: {
    icon: "⚠",
    label: "Needs Input",
    className: "text-[var(--color-needs-input)]",
  },
  done: {
    icon: "✓",
    label: "Done",
    className: "text-[var(--color-done)]",
  },
  error: {
    icon: "✗",
    label: "Error",
    className: "text-[var(--color-error)]",
  },
};

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

interface Props {
  agent?: AgentInfo;
}

export function AgentStatusBadge({ agent }: Props) {
  if (!agent) {
    return (
      <span className="text-xs text-[var(--color-text-muted)]">
        (no agent)
      </span>
    );
  }

  const config = STATUS_CONFIG[agent.status];

  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span className={config.className}>{config.icon}</span>
      <span className={config.className}>{agent.name}</span>
      <span className="text-[var(--color-text-muted)]">{config.label}</span>
      {agent.summary && (
        <span
          className="text-xs text-[var(--color-text-muted)] truncate max-w-[200px]"
          title={agent.summary}
        >
          — {agent.summary}
        </span>
      )}
      <span className="text-xs text-[var(--color-text-muted)]">
        {timeAgo(agent.lastActivity)}
      </span>
    </span>
  );
}
