import { CIStatus } from "@/stores/dashboard-store";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface Props {
  ci: CIStatus;
}

const config: Record<string, { color: string; animate?: boolean; label: string }> = {
  pending: { color: "bg-yellow-400", label: "CI pending" },
  running: { color: "bg-yellow-400", animate: true, label: "CI running" },
  success: { color: "bg-green-400", label: "CI passed" },
  failure: { color: "bg-red-400", label: "CI failed" },
  cancelled: { color: "bg-gray-400", label: "CI cancelled" },
};

export function CIStatusIndicator({ ci }: Props) {
  const cfg = config[ci.state];
  if (!cfg) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`inline-block size-2 rounded-full shrink-0 ${cfg.color} ${cfg.animate ? "animate-pulse" : ""}`}
        />
      </TooltipTrigger>
      <TooltipContent>{cfg.label}</TooltipContent>
    </Tooltip>
  );
}
