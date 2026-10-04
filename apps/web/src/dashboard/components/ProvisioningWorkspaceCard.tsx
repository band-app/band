import { Loader, TriangleAlert, X } from "lucide-react";
import { useCancelHostRequest } from "../hooks/use-host-requests";

export interface ProvisioningRequest {
  id: string;
  branch: string;
  status: "pending" | "leased" | "fulfilled" | "failed" | "cancelled";
  error: string | null;
  labels: Record<string, string>;
}

const STATUS_TEXT: Record<ProvisioningRequest["status"], string> = {
  pending: "Waiting for a host",
  leased: "Starting a host",
  fulfilled: "Setting up the workspace",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * A workspace that has no host yet (plan step 3.3): spinning while the hub
 * waits for a runner, or red with the reason when it gave up. The button
 * cancels the wait, or dismisses the failure.
 */
export function ProvisioningWorkspaceCard({ request }: { request: ProvisioningRequest }) {
  const cancel = useCancelHostRequest();
  const failed = request.status === "failed";
  const labels = Object.entries(request.labels).map(([k, v]) => `${k}=${v}`);
  return (
    <div
      className="flex items-start gap-2 rounded-md px-3 py-2 text-[13px]"
      data-testid="provisioning-workspace__card"
      data-status={request.status}
      data-branch={request.branch}
    >
      {failed ? (
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
      ) : (
        <Loader className="mt-0.5 size-3.5 shrink-0 animate-spin" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{request.branch}</div>
        <div
          className={failed ? "text-destructive" : "text-foreground/60"}
          data-testid="provisioning-workspace__status"
        >
          {STATUS_TEXT[request.status]}
          {labels.length > 0 && !failed ? ` (${labels.join(", ")})` : ""}
        </div>
        {failed && request.error && (
          <div
            className="break-words text-xs text-destructive"
            data-testid="provisioning-workspace__error"
          >
            {request.error}
          </div>
        )}
      </div>
      <button
        type="button"
        className="shrink-0 rounded p-1 text-foreground/60 hover:bg-primary/10 hover:text-foreground"
        aria-label={failed ? `Dismiss ${request.branch}` : `Cancel ${request.branch}`}
        data-testid="provisioning-workspace__cancel"
        disabled={cancel.isPending}
        onClick={() => cancel.mutate(request.id)}
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
